"""Crypto derivatives positioning feed (funding rate + open interest).

Uses Binance USDⓈ-M public endpoints:
  GET /fapi/v1/premiumIndex?symbol=BTCUSDT -> markPrice, indexPrice, lastFundingRate,
                                              nextFundingTime, time
  GET /futures/data/openInterestHist?symbol=BTCUSDT&period=5m&limit=6 -> OI history

These are venue data, not broker order flow: funding shows the perp basis and open
interest shows positioning size. The service is fail-open (returns None) so an
outage never blocks the agent department; the snapshot always carries its source
and as-of time. No data is invented for FX or equities.
"""

import logging
import time
from dataclasses import asdict, dataclass
from typing import Any

import httpx

from app.core.config import get_settings

log = logging.getLogger("aurex.market.positioning")

SYMBOLS = {"BTC-USD": "BTCUSDT", "ETH-USD": "ETHUSDT", "SOL-USD": "SOLUSDT"}


@dataclass(frozen=True)
class PositioningSnapshot:
    symbol: str
    venue_symbol: str
    funding_rate: float             # per funding interval (usually 8h), e.g. 0.0001
    funding_bps: float
    mark_price: float
    index_price: float
    open_interest: float
    oi_change_pct: float            # change over the returned OI window
    as_of: float                    # epoch seconds from the venue
    source: str = "binance_futures"

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class PositioningProvider:
    def __init__(self, base_url: str, client: httpx.AsyncClient | None = None,
                 timeout: float = 10.0):
        self._client = client or httpx.AsyncClient(
            base_url=base_url.rstrip("/"), timeout=timeout,
            headers={"User-Agent": "aurex-ai/0.4"})

    async def _get(self, path: str, params: dict) -> Any:
        r = await self._client.get(path, params=params)
        r.raise_for_status()
        return r.json()

    async def get(self, venue_symbol: str) -> PositioningSnapshot:
        premium = await self._get("/fapi/v1/premiumIndex", {"symbol": venue_symbol})
        history = await self._get("/futures/data/openInterestHist", {
            "symbol": venue_symbol, "period": "5m", "limit": 6})
        if not isinstance(premium, dict) or not isinstance(history, list) or not history:
            raise ValueError("positioning feed: unexpected payload")
        funding = float(premium["lastFundingRate"])
        raw_time = float(premium.get("time", time.time()))
        as_of = raw_time / 1000 if raw_time > 1e11 else raw_time   # Binance sends ms
        oi = float(history[-1]["sumOpenInterest"])
        first = float(history[0]["sumOpenInterest"])
        return PositioningSnapshot(
            symbol=venue_symbol, venue_symbol=venue_symbol, funding_rate=funding,
            funding_bps=funding * 10000,
            mark_price=float(premium["markPrice"]), index_price=float(premium["indexPrice"]),
            open_interest=oi,
            oi_change_pct=((oi / first) - 1) * 100 if first > 0 else 0.0,
            as_of=as_of,
        )


class PositioningService:
    """TTL-cached accessor used by both the REST endpoint and the agent context."""

    def __init__(self, client: httpx.AsyncClient | None = None):
        s = get_settings()
        self.enabled = bool(s.positioning_enabled)
        self.s = s
        self._provider = PositioningProvider(s.positioning_base_url, client=client)
        self._cache: dict[str, tuple[float, PositioningSnapshot]] = {}

    async def snapshot(self, symbol: str) -> PositioningSnapshot | None:
        venue = SYMBOLS.get(symbol.upper())
        if not self.enabled or venue is None:
            return None
        cached = self._cache.get(venue)
        if cached and time.monotonic() - cached[0] < self.s.positioning_ttl_seconds:
            return cached[1]
        try:
            snap = await self._provider.get(venue)
        except (httpx.HTTPError, ValueError, KeyError, TypeError, ArithmeticError) as e:
            log.warning("positioning feed unavailable for %s: %s", venue, e.__class__.__name__)
            return None
        self._cache[venue] = (time.monotonic(), snap)
        return snap


async def positioning_for(symbol: str) -> dict[str, Any] | None:
    """Convenience wrapper for request handlers (own service instance)."""
    return (await PositioningService().snapshot(symbol)) or None
