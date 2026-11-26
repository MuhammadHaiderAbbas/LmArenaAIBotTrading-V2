import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy import func, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import AppError, BusinessRuleViolation, NotFound
from app.market import calendar
from app.market.providers.base import MarketDataProvider
from app.market.providers.coinbase import CoinbaseProvider
from app.market.providers.finnhub import FinnhubProvider
from app.market.providers.frankfurter import FrankfurterProvider
from app.market.providers.oanda import OandaProvider
from app.market.providers.synthetic import SyntheticProvider
from app.market.types import TIMEFRAMES, AssetClass, InstrumentRef, ProviderError, RawQuote
from app.models import Instrument, MarketCandle

# A quote older than this while its market is open is stale and must not be traded on.
STALE_AFTER = {AssetClass.CRYPTO: 60, AssetClass.FX: 60, AssetClass.STOCK: 120,
               AssetClass.ETF: 120}
MAX_CANDLES = 1000


class ProviderUnavailable(AppError):
    status_code = 503
    code = "market_data_unavailable"


def ref(inst: Instrument) -> InstrumentRef:
    return InstrumentRef(inst.symbol, inst.asset_class, inst.market, inst.provider_symbol,
                         inst.price_decimals, inst.reference_price)


def slug(symbol: str) -> str:
    return symbol.replace("/", "")


# --- provider registry -----------------------------------------------------------
_providers: dict[str, MarketDataProvider] = {}


def set_provider(name: str, provider: MarketDataProvider | None) -> None:
    """Override a provider (tests / alternative vendors). None removes the override."""
    if provider is None:
        _providers.pop(name, None)
    else:
        _providers[name] = provider


class UnavailableProvider:
    """Fail closed: no licensed feed means no live prices, never a fake fallback."""

    name = "unavailable"

    def __init__(self, reason: str):
        self.reason = reason

    async def get_candles(self, inst, timeframe, start, end):
        raise ProviderError(self.reason)

    async def get_quote(self, inst):
        raise ProviderError(self.reason)


def provider_for(inst: Instrument) -> MarketDataProvider:
    s = get_settings()
    # In synthetic (public demo) mode nothing is presented as live. In live mode an
    # instrument must name a real provider; "synthetic" is never silently upgraded.
    name = inst.data_provider if s.market_data_mode == "live" else "synthetic"
    if name not in _providers:
        if name == "coinbase":
            _providers[name] = CoinbaseProvider(s.coinbase_base_url)
        elif name == "frankfurter":
            _providers[name] = FrankfurterProvider(s.frankfurter_base_url)
        elif name == "finnhub":
            _providers[name] = (FinnhubProvider(s.finnhub_api_key, s.finnhub_base_url,
                                                s.finnhub_spread_bps)
                                if s.finnhub_api_key else
                                UnavailableProvider("finnhub api key is not configured"))
        elif name == "oanda":
            # With no OANDA credentials FX degrades to ECB fixings, which are labelled
            # ecb_reference and never tradable. No price is invented.
            _providers[name] = (OandaProvider(s.oanda_api_key, s.oanda_account_id, s.oanda_base_url)
                                if s.oanda_api_key and s.oanda_account_id else
                                FrankfurterProvider(s.frankfurter_base_url))
        elif name == "synthetic" and s.market_data_mode == "synthetic":
            _providers[name] = SyntheticProvider()
        else:
            _providers[name] = UnavailableProvider(f"no licensed provider configured for {name}")
    return _providers[name]


# --- quote cache (in-process; Redis once the API runs multiple replicas) ---------
_quote_cache: dict[str, tuple[float, RawQuote]] = {}


def clear_caches() -> None:
    _quote_cache.clear()


@dataclass
class Quote:
    symbol: str
    last: Decimal
    bid: Decimal
    ask: Decimal
    prev_close: Decimal | None
    change: Decimal | None
    change_pct: Decimal | None
    as_of: datetime
    source: str
    market_open: bool
    stale: bool
    tradable: bool
    age_seconds: int
    pricing: str = "actual"


def build_quote(inst: Instrument, raw: RawQuote, now: datetime) -> Quote:
    market_open = calendar.is_open(inst.market, now)
    age = max(0, int((now - raw.as_of).total_seconds()))
    stale = market_open and age > STALE_AFTER[inst.asset_class]
    change = change_pct = None
    if raw.prev_close:
        change = raw.last - raw.prev_close
        change_pct = (change / raw.prev_close * 100).quantize(Decimal("0.01"))
    # Reference fixings and demo simulations are never executable. In live mode a
    # simulated quote (e.g. a misconfigured instrument) must not be tradable either.
    live = get_settings().market_data_mode == "live"
    executable = raw.pricing != "reference" and not (
        live and (raw.pricing == "simulated" or raw.source == "synthetic"))
    return Quote(
        symbol=inst.symbol, last=raw.last, bid=raw.bid, ask=raw.ask, prev_close=raw.prev_close,
        change=change, change_pct=change_pct, as_of=raw.as_of, source=raw.source,
        market_open=market_open, stale=stale,
        tradable=market_open and not stale and raw.source not in ("ecb_reference",) and executable,
        age_seconds=age, pricing=raw.pricing,
    )


class MarketService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.settings = get_settings()

    # -- registry -----------------------------------------------------------------
    async def instruments(self, asset_class: str | None = None, q: str | None = None,
                          ) -> list[Instrument]:
        stmt = select(Instrument).where(Instrument.is_active.is_(True))
        if asset_class:
            stmt = stmt.where(Instrument.asset_class == asset_class)
        if q:
            like = f"%{q.lower()}%"
            stmt = stmt.where(or_(func.lower(Instrument.symbol).like(like),
                                  func.lower(Instrument.display_name).like(like)))
        rows = await self.db.scalars(stmt.order_by(Instrument.asset_class, Instrument.symbol))
        return list(rows)

    async def get(self, symbol: str) -> Instrument:
        key = symbol.upper().replace("/", "")
        inst = await self.db.scalar(select(Instrument).where(
            func.replace(func.upper(Instrument.symbol), "/", "") == key,
            Instrument.is_active.is_(True)))
        if inst is None:
            raise NotFound(f"Unknown instrument {symbol}")
        return inst

    # -- quotes -------------------------------------------------------------------
    async def quote(self, inst: Instrument) -> Quote:
        cached = _quote_cache.get(inst.symbol)
        if cached and time.monotonic() - cached[0] < self.settings.quote_cache_seconds:
            return build_quote(inst, cached[1], datetime.now(UTC))
        try:
            raw = await provider_for(inst).get_quote(ref(inst))
        except ProviderError as e:
            raise ProviderUnavailable(f"Market data unavailable for {inst.symbol}",
                                      details={"reason": str(e)})
        _quote_cache[inst.symbol] = (time.monotonic(), raw)
        return build_quote(inst, raw, datetime.now(UTC))

    async def quotes(self, instruments: list[Instrument]) -> dict[str, Quote | None]:
        out: dict[str, Quote | None] = {}
        for inst in instruments:
            try:
                out[inst.symbol] = await self.quote(inst)
            except ProviderUnavailable:
                out[inst.symbol] = None
        return out

    # -- candles ------------------------------------------------------------------
    async def candles(self, inst: Instrument, timeframe: str, limit: int) -> list[MarketCandle]:
        """Read-through store: gap-fill from the provider, persist, then serve from DB."""
        if timeframe not in TIMEFRAMES:
            raise BusinessRuleViolation(f"Unsupported timeframe {timeframe}")
        limit = min(limit, MAX_CANDLES)
        await self.fill(inst, timeframe, limit)
        rows = await self.db.scalars(
            select(MarketCandle).where(MarketCandle.instrument_id == inst.id,
                                       MarketCandle.timeframe == timeframe)
            .order_by(MarketCandle.open_time.desc()).limit(limit))
        return list(reversed(list(rows)))

    def _lookback(self, inst: Instrument, timeframe: str, limit: int) -> timedelta:
        tf = TIMEFRAMES[timeframe]
        # Session markets need extra calendar time to collect `limit` trading candles.
        factor = {"CRYPTO_24_7": 1.0, "FX_24_5": 1.5}.get(inst.market, 1.0)
        if inst.market in ("US_EQUITY", "UK_EQUITY"):
            factor = 1.6 if timeframe == "1d" else (24 / 6.5) * 1.5
        return timedelta(seconds=tf * limit * factor + tf)

    async def fill(self, inst: Instrument, timeframe: str, limit: int) -> int:
        now = datetime.now(UTC)
        tf = TIMEFRAMES[timeframe]
        last = await self.db.scalar(select(func.max(MarketCandle.open_time)).where(
            MarketCandle.instrument_id == inst.id, MarketCandle.timeframe == timeframe))
        start = now - self._lookback(inst, timeframe, limit)
        if last is not None:
            if now - last < timedelta(seconds=2 * tf):
                return 0
            start = max(start, last + timedelta(seconds=tf))
        return await self._ingest(inst, timeframe, start, now)

    async def backfill(self, inst: Instrument, timeframe: str, days: int) -> int:
        now = datetime.now(UTC)
        return await self._ingest(inst, timeframe, now - timedelta(days=days), now)

    async def _ingest(self, inst: Instrument, timeframe: str, start: datetime,
                      end: datetime) -> int:
        try:
            candles = await provider_for(inst).get_candles(ref(inst), timeframe, start, end)
        except ProviderError as e:
            raise ProviderUnavailable(f"Market data unavailable for {inst.symbol}",
                                      details={"reason": str(e)})
        if not candles:
            return 0
        source = provider_for(inst).name
        rows = [{
            "instrument_id": inst.id, "timeframe": timeframe, "open_time": c.open_time,
            "open": c.open, "high": c.high, "low": c.low, "close": c.close, "volume": c.volume,
            "source": source,
        } for c in candles]
        # Postgres caps bind parameters at 32,767 per statement (9 per row): upsert in batches.
        for i in range(0, len(rows), 2000):
            stmt = insert(MarketCandle).values(rows[i:i + 2000])
            stmt = stmt.on_conflict_do_update(
                index_elements=["instrument_id", "timeframe", "open_time"],
                set_={k: stmt.excluded[k] for k in ("open", "high", "low", "close", "volume",
                                                     "source")} | {"ingested_at": func.now()},
            )
            await self.db.execute(stmt)
        await self.db.commit()
        return len(rows)


async def fx_rate(svc: "MarketService", src: str, dst: str) -> Decimal | None:
    """Units of `dst` per unit of `src`, from live FX quotes (direct, inverse or via USD)."""
    if src == dst:
        return Decimal(1)

    async def rate(a: str, b: str) -> Decimal | None:
        for sym, invert in ((f"{a}/{b}", False), (f"{b}/{a}", True)):
            inst = await svc.db.scalar(select(Instrument).where(Instrument.symbol == sym))
            if inst:
                try:
                    last = (await svc.quote(inst)).last
                except ProviderUnavailable:
                    return None
                return (Decimal(1) / last) if invert else last
        return None

    direct = await rate(src, dst)
    if direct is not None:
        return direct
    a, b = await rate(src, "USD"), await rate("USD", dst)
    return a * b if a is not None and b is not None else None


def market_statuses(now: datetime | None = None) -> list[dict]:
    now = now or datetime.now(UTC)
    labels = {"CRYPTO_24_7": "Crypto (24/7)", "FX_24_5": "Forex (24/5)",
              "US_EQUITY": "US equities (NYSE/Nasdaq)", "UK_EQUITY": "UK equities (LSE)"}
    return [{**calendar.status(m, now), "label": labels[m]} for m in labels]


