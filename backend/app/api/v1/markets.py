import asyncio
import uuid
from datetime import UTC, datetime

import jwt
from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user, get_audit_context, require_admin
from app.core.config import get_settings
from app.core.errors import BusinessRuleViolation, Conflict, NotFound
from app.core.security import decode_access_token
from app.database.session import SessionLocal, get_db
from app.market import indicators as ind
from app.market.positioning import PositioningService
from app.market.service import MarketService, ProviderUnavailable, Quote, market_statuses
from app.market.types import TIMEFRAMES, AssetClass
from app.models import Instrument, User, UserSession, Watchlist, WatchlistItem
from app.realtime.bus import get_bus
from app.schemas.market import (
    BackfillRequest,
    CandleRead,
    CandlesResponse,
    InstrumentRead,
    InstrumentWithQuote,
    MarketOverview,
    MarketStatus,
    PositioningRead,
    PositioningResponse,
    QuoteRead,
    WatchlistAdd,
    WatchlistRead,
)
from app.services.audit_service import AuditContext, AuditService

router = APIRouter(prefix="/markets", tags=["markets"])

DEFAULT_WATCHLIST = ["BTC-USD", "EUR/USD", "AAPL", "SPY"]


def _q(q: Quote | None) -> QuoteRead | None:
    return QuoteRead.model_validate(q) if q else None


@router.get("/status", response_model=list[MarketStatus])
async def status_(_: User = Depends(current_user)):
    return market_statuses()


@router.get("/overview", response_model=MarketOverview)
async def overview(_: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    svc = MarketService(db)
    instruments = await svc.instruments()
    quotes = await svc.quotes(instruments)
    groups: dict[str, list[InstrumentWithQuote]] = {c: [] for c in AssetClass.ALL}
    for i in instruments:
        groups[i.asset_class].append(InstrumentWithQuote(
            instrument=InstrumentRead.model_validate(i), quote=_q(quotes[i.symbol])))
    return MarketOverview(markets=market_statuses(), groups=groups,
                          data_mode=get_settings().market_data_mode)


@router.get("/instruments", response_model=list[InstrumentRead])
async def instruments(
    asset_class: str | None = Query(None, pattern="^(CRYPTO|FX|STOCK|ETF)$"),
    q: str | None = Query(None, max_length=40),
    _: User = Depends(current_user), db: AsyncSession = Depends(get_db),
):
    return await MarketService(db).instruments(asset_class, q)


@router.get("/instruments/{symbol}", response_model=InstrumentWithQuote)
async def instrument(symbol: str, _: User = Depends(current_user),
                     db: AsyncSession = Depends(get_db)):
    svc = MarketService(db)
    inst = await svc.get(symbol)
    return InstrumentWithQuote(instrument=InstrumentRead.model_validate(inst),
                               quote=_q(await svc.quote(inst)))


@router.get("/instruments/{symbol}/quote", response_model=QuoteRead)
async def quote(symbol: str, _: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    svc = MarketService(db)
    return await svc.quote(await svc.get(symbol))


@router.get("/instruments/{symbol}/positioning", response_model=PositioningResponse)
async def positioning(symbol: str, _: User = Depends(current_user),
                      db: AsyncSession = Depends(get_db)):
    """Venue funding/open interest for crypto perps; explicitly unavailable otherwise."""
    inst = await MarketService(db).get(symbol)
    snap = await PositioningService().snapshot(inst.symbol)
    if snap is None:
        return PositioningResponse(available=False, reason="positioning feed unavailable")
    data = snap.as_dict()
    data["as_of"] = datetime.fromtimestamp(snap.as_of, UTC)
    return PositioningResponse(available=True, data=PositioningRead.model_validate(data))


@router.get("/instruments/{symbol}/candles", response_model=CandlesResponse)
async def candles(
    symbol: str,
    timeframe: str = Query("1h"),
    limit: int = Query(200, ge=1, le=1000),
    indicators: str | None = Query(
        None, max_length=200, description="Comma list: sma20,sma50,ema20,ema50,rsi14,bb20,macd"),
    _: User = Depends(current_user), db: AsyncSession = Depends(get_db),
):
    if timeframe not in TIMEFRAMES:
        raise BusinessRuleViolation(f"timeframe must be one of {', '.join(TIMEFRAMES)}")
    svc = MarketService(db)
    inst = await svc.get(symbol)
    rows = await svc.candles(inst, timeframe, limit)
    requested = {s.strip() for s in (indicators or "").split(",") if s.strip()}
    unknown = requested - ind.SUPPORTED
    if unknown:
        raise BusinessRuleViolation(f"Unknown indicators: {', '.join(sorted(unknown))}")
    closes = [float(r.close) for r in rows]
    return CandlesResponse(
        symbol=inst.symbol, timeframe=timeframe, source=rows[-1].source if rows else None,
        candles=[CandleRead.model_validate(r) for r in rows],
        indicators=ind.compute(requested, closes),
    )


# --- watchlists ------------------------------------------------------------------
async def _default_watchlist(db: AsyncSession, user: User) -> Watchlist:
    wl = await db.scalar(select(Watchlist).where(Watchlist.user_id == user.id,
                                                 Watchlist.name == "Default"))
    if wl is None:
        wl = Watchlist(user_id=user.id, name="Default")
        db.add(wl)
        await db.flush()
        seeds = await db.scalars(select(Instrument).where(Instrument.symbol.in_(DEFAULT_WATCHLIST)))
        order = {s: i for i, s in enumerate(DEFAULT_WATCHLIST)}
        for inst in seeds:
            db.add(WatchlistItem(watchlist_id=wl.id, instrument_id=inst.id,
                                 position=order[inst.symbol]))
        await db.commit()
        await db.refresh(wl, ["items"])
    return wl


async def _watchlist_read(db: AsyncSession, wl: Watchlist) -> WatchlistRead:
    insts = [item.instrument for item in wl.items]
    quotes = await MarketService(db).quotes(insts)
    return WatchlistRead(id=str(wl.id), name=wl.name, items=[
        InstrumentWithQuote(instrument=InstrumentRead.model_validate(i), quote=_q(quotes[i.symbol]))
        for i in insts])


@router.get("/watchlist", response_model=WatchlistRead)
async def get_watchlist(user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    return await _watchlist_read(db, await _default_watchlist(db, user))


@router.post("/watchlist/items", response_model=WatchlistRead, status_code=status.HTTP_201_CREATED)
async def add_to_watchlist(data: WatchlistAdd, user: User = Depends(current_user),
                           db: AsyncSession = Depends(get_db)):
    wl = await _default_watchlist(db, user)
    inst = await MarketService(db).get(data.symbol)
    if any(item.instrument_id == inst.id for item in wl.items):
        raise Conflict(f"{inst.symbol} is already on the watchlist")
    if len(wl.items) >= 50:
        raise BusinessRuleViolation("Watchlist is limited to 50 instruments")
    pos = (await db.scalar(select(func.max(WatchlistItem.position)).where(
        WatchlistItem.watchlist_id == wl.id)) or 0) + 1
    db.add(WatchlistItem(watchlist_id=wl.id, instrument_id=inst.id, position=pos))
    await db.commit()
    await db.refresh(wl, ["items"])
    return await _watchlist_read(db, wl)


@router.delete("/watchlist/items/{symbol}", response_model=WatchlistRead)
async def remove_from_watchlist(symbol: str, user: User = Depends(current_user),
                                db: AsyncSession = Depends(get_db)):
    wl = await _default_watchlist(db, user)
    inst = await MarketService(db).get(symbol)
    item = next((i for i in wl.items if i.instrument_id == inst.id), None)
    if item is None:
        raise NotFound(f"{inst.symbol} is not on the watchlist")
    await db.delete(item)
    await db.commit()
    await db.refresh(wl, ["items"])
    return await _watchlist_read(db, wl)


# --- admin -----------------------------------------------------------------------
@router.post("/backfill", dependencies=[Depends(require_admin)])
async def backfill(data: BackfillRequest, ctx: AuditContext = Depends(get_audit_context),
                   db: AsyncSession = Depends(get_db)):
    if data.timeframe not in TIMEFRAMES:
        raise BusinessRuleViolation(f"timeframe must be one of {', '.join(TIMEFRAMES)}")
    svc = MarketService(db)
    inst = await svc.get(data.symbol)
    count = await svc.backfill(inst, data.timeframe, data.days)
    await AuditService(db).record(ctx, "market.backfill", resource_type="instrument",
                                  resource_id=inst.symbol,
                                  details={"timeframe": data.timeframe, "days": data.days,
                                           "candles": count})
    await db.commit()
    return {"symbol": inst.symbol, "timeframe": data.timeframe, "candles_upserted": count}


# --- streaming -------------------------------------------------------------------
async def _authenticate_ws(token: str) -> uuid.UUID | None:
    try:
        payload = decode_access_token(token)
        user_id, sid = uuid.UUID(payload["sub"]), uuid.UUID(payload["sid"])
    except (jwt.PyJWTError, KeyError, ValueError):
        return None
    async with SessionLocal() as db:
        row = (await db.execute(
            select(User.is_active, UserSession.revoked_at)
            .join(UserSession, UserSession.user_id == User.id)
            .where(User.id == user_id, UserSession.id == sid))).first()
    if row is None or not row[0] or row[1] is not None:
        return None
    return user_id


@router.websocket("/stream")
async def stream(ws: WebSocket):
    """Quote stream.

    Protocol (JSON text frames):
      client → {"type": "auth", "token": "<access token>"}        (first frame, within 10s)
      client → {"type": "subscribe", "symbols": ["BTC-USD", ...]}  (replaces the set)
      server → {"type": "ready"} | {"type": "quotes", "data": [...]} | {"type": "error", ...}
    Tokens are sent in-band rather than in the URL so they never reach access logs.

    Quotes are fetched once per symbol per poll (a short Redis lease elects the
    fetching replica when fan-out is enabled) and published to the shared event
    bus. Every replica's clients receive the same snapshot; no client can see a
    symbol it has not subscribed to.
    """
    s = get_settings()
    await ws.accept()
    try:
        first = await asyncio.wait_for(ws.receive_json(), timeout=10)
    except (TimeoutError, WebSocketDisconnect, ValueError):
        await ws.close(code=4401)
        return
    if first.get("type") != "auth" or not await _authenticate_ws(str(first.get("token", ""))):
        await ws.send_json({"type": "error", "message": "unauthorized"})
        await ws.close(code=4401)
        return
    await ws.send_json({"type": "ready", "interval_seconds": s.stream_interval_seconds})

    symbols: list[str] = []
    allowed: set[str] = set()          # canonical symbols this client subscribed to
    commands: asyncio.Queue[dict] = asyncio.Queue()
    bus = get_bus()
    owner = f"quote-{uuid.uuid4().hex}"
    lease_ttl = max(1.0, s.stream_interval_seconds * 3)

    async def reader():
        while True:
            await commands.put(await ws.receive_json())

    async def fetch_and_publish() -> None:
        async with SessionLocal() as db:
            svc = MarketService(db)
            for raw in symbols:
                try:
                    inst = await svc.get(raw)
                except NotFound:
                    continue
                allowed.add(inst.symbol)
                if not await bus.acquire_lease(f"aurex:lease:quote:{inst.symbol}", lease_ttl, owner):
                    continue                    # another replica owns this symbol this tick
                try:
                    q = await svc.quote(inst)
                except ProviderUnavailable:
                    continue                    # outage: publish nothing, never a fake price
                await bus.publish(f"quote:{inst.symbol}",
                                  QuoteRead.model_validate(q).model_dump(mode="json"))

    async def flush() -> None:
        batch: list[dict] = []
        while True:
            try:
                event = sub.queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            payload = event["data"]
            if payload.get("symbol") in allowed:
                # Keep every snapshot: a newer local poll must not replace a
                # cross-node event that arrived in the same batch.
                batch.append(payload)
        if batch:
            await ws.send_json({
                "type": "quotes", "sent_at": datetime.now(UTC).isoformat(), "data": batch,
            })

    reader_task = asyncio.create_task(reader())
    try:
        async with bus.subscribe("quote:*") as sub:
            while True:
                try:
                    msg = await asyncio.wait_for(commands.get(), timeout=s.stream_interval_seconds)
                except TimeoutError:
                    pass
                else:
                    if msg.get("type") == "subscribe":
                        symbols = [str(x) for x in msg.get("symbols", [])][: s.max_stream_symbols]
                        allowed.clear()            # stale canonical symbols cannot leak
                        await flush()
                    else:
                        await ws.send_json({"type": "error", "message": "unknown message type"})
                if reader_task.done():
                    break
                await fetch_and_publish()
                await flush()
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        reader_task.cancel()
