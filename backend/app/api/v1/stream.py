"""Live account stream: pushes trade, ledger, position, binary and risk changes, and a
mark-to-market valuation, for every paper account the user owns.

Protocol (JSON text frames, same auth handshake as the quote stream):
  client → {"type": "auth", "token": "<access token>"}       (first frame, within 10s)
  server → {"type": "ready", "accounts": [...], "interval_seconds": 1.0}
  server → {"type": "changed", "account_id": "...", "topics": ["orders", "executions", ...]}
  server → {"type": "valuation", "account_id": "...", "as_of": "...", "equity": "...", ...}

Changes are detected from database fingerprints (row counts and latest update times).
One subscriber per user polls and publishes changes and valuations to a shared Redis
Stream (when configured), so fills made by a worker on any replica reach every
client on every API node. Without Redis the same bus works in process.
"""

import asyncio
import json
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.encoders import jsonable_encoder
from sqlalchemy import func, or_, select

from app.api.v1.markets import _authenticate_ws
from app.core.config import get_settings
from app.database.session import SessionLocal
from app.models import (
    BinaryContract,
    Execution,
    LedgerTransaction,
    Order,
    Position,
    RiskEvent,
    RiskProfile,
    TradingAccount,
)
from app.realtime.bus import get_bus

router = APIRouter(tags=["stream"])
MAX_ACCOUNTS = 10


def _sub(model, *cols, where):
    return select(*cols).select_from(model).where(where).scalar_subquery()


async def fingerprints(db, account_ids: list[uuid.UUID]) -> dict[uuid.UUID, dict[str, Any]]:
    """One cheap row per account: counts and latest update times per topic."""
    out: dict[uuid.UUID, dict[str, Any]] = {}
    for aid in account_ids:
        row = (await db.execute(select(
            _sub(Order, func.count(), where=Order.account_id == aid),
            _sub(Order, func.max(Order.updated_at), where=Order.account_id == aid),
            _sub(Execution, func.count(), where=Execution.account_id == aid),
            _sub(LedgerTransaction, func.count(), where=LedgerTransaction.trading_account_id == aid),
            _sub(Position, func.max(Position.updated_at), where=Position.account_id == aid),
            _sub(Position, func.count(), where=Position.account_id == aid),
            _sub(BinaryContract, func.count(), where=BinaryContract.account_id == aid),
            _sub(BinaryContract, func.max(BinaryContract.updated_at), where=BinaryContract.account_id == aid),
            _sub(RiskEvent, func.count(), where=or_(RiskEvent.account_id == aid, RiskEvent.account_id.is_(None))),
            _sub(RiskProfile, func.max(RiskProfile.updated_at), where=RiskProfile.account_id == aid),
        ))).one()
        out[aid] = {"orders": (row[0], row[1]), "executions": row[2], "ledger": row[3], "positions": (row[4], row[5]),
                    "binary": (row[6], row[7]), "risk": (row[8], row[9])}
    return out


def changed_topics(before: dict[str, Any] | None, after: dict[str, Any]) -> list[str]:
    if before is None:
        return []
    return [k for k, v in after.items() if before.get(k) != v]


def valuation(summary: dict[str, Any]) -> dict[str, Any]:
    keys = ("equity", "cash", "available_cash", "market_value", "unrealised_pnl", "realised_pnl", "fees", "exposure",
            "binary_at_risk", "open_positions")
    return {
        **{k: summary.get(k) for k in keys},
        "as_of": datetime.now(UTC),
        "positions": [{k: p[k] for k in ("symbol", "last", "bid", "market_value", "unrealised_pnl", "unrealised_pct",
                                         "price_as_of", "stale")} for p in summary["positions"]],
    }


@router.websocket("/stream/account")
async def account_stream(ws: WebSocket):
    from app.trading.service import TradingService

    s = get_settings()
    interval = s.account_stream_interval_seconds
    await ws.accept()
    try:
        first = await asyncio.wait_for(ws.receive_json(), timeout=10)
    except (TimeoutError, WebSocketDisconnect, ValueError):
        await ws.close(code=4401)
        return
    user_id = await _authenticate_ws(str(first.get("token", ""))) if first.get("type") == "auth" else None
    if user_id is None:
        await ws.send_json({"type": "error", "message": "unauthorized"})
        await ws.close(code=4401)
        return

    async def owned() -> list[uuid.UUID]:
        async with SessionLocal() as db:
            return list(await db.scalars(select(TradingAccount.id).where(TradingAccount.owner_id == user_id)
                                         .order_by(TradingAccount.created_at).limit(MAX_ACCOUNTS)))

    accounts = await owned()
    await ws.send_json({"type": "ready", "accounts": [str(a) for a in accounts], "interval_seconds": interval})

    async def watch_disconnect():
        while True:
            await ws.receive_text()            # clients send nothing after auth; any frame is ignored

    bus = get_bus()
    owner = f"account-{uuid.uuid4().hex}"
    channel = f"account:{user_id}"
    lease_ttl = max(1.0, interval * 5)

    reader = asyncio.create_task(watch_disconnect())
    last: dict[uuid.UUID, dict[str, Any]] = {}
    seen_fingerprints: set[str] = set()
    tick = 0

    async def publish(event: dict) -> None:
        await bus.publish(channel, jsonable_encoder(event))

    try:
        async with bus.subscribe(channel) as sub:
            while not reader.done():
                # One subscriber per user polls, so N sockets do not emit the same change N
                # times. The lease is refreshed on every tick by its owner.
                if await bus.acquire_lease(f"aurex:lease:account:{user_id}", lease_ttl, owner):
                    fresh = await owned()
                    if tick:                            # pick up accounts created after connecting
                        for aid in set(fresh) - set(accounts):
                            await publish({"type": "changed", "account_id": str(aid),
                                           "topics": ["accounts"]})
                    accounts = fresh
                    async with SessionLocal() as db:
                        fps = await fingerprints(db, accounts)
                        for aid, fp in fps.items():
                            topics = changed_topics(last.get(aid), fp)
                            encoded = jsonable_encoder(fp)
                            key = json.dumps(encoded, sort_keys=True, default=str)
                            if topics and key not in seen_fingerprints:
                                seen_fingerprints.add(key)
                                await publish({"type": "changed", "account_id": str(aid),
                                               "topics": topics, "_fp": encoded})
                        last = fps
                        if tick % max(1, round(s.account_valuation_interval_seconds / interval)) == 0:
                            ts = TradingService(db)
                            for aid in accounts:
                                acct = await db.get(TradingAccount, aid)
                                if acct is None:
                                    continue
                                summary = await ts.summary(acct, take_snapshot=False)
                                await publish({"type": "valuation", "account_id": str(aid),
                                               **valuation(summary)})
                        await db.rollback()         # read-only: never keep a transaction open between ticks
                tick += 1
                await asyncio.wait({reader}, timeout=interval)
                while not sub.queue.empty():
                    event = sub.queue.get_nowait()["data"]
                    fp = event.pop("_fp", None)
                    if fp is not None:
                        seen_fingerprints.add(json.dumps(fp, sort_keys=True, default=str))
                    # The channel itself is scoped to the authenticated user; only
                    # that user's poller publishes to it.
                    await ws.send_json(event)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        reader.cancel()
