"""Frankfurter: European Central Bank reference rates (no API key).

These are *daily reference fixings*, not tradable quotes: one value per TARGET
business day, published ~16:00 CET. Candles therefore have O=H=L=C and zero volume,
only the 1d timeframe is supported, and quotes are always older than the FX
staleness threshold — so the service marks them non-tradable. That is intentional:
a real FX feed (broker or licensed vendor) replaces this before paper execution
relies on FX prices.
"""

from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal

import httpx

from app.market.types import Candle, InstrumentRef, ProviderError, RawQuote, UnsupportedTimeframe


class FrankfurterProvider:
    name = "ecb_reference"

    def __init__(self, base_url: str = "https://api.frankfurter.dev/v1",
                 client: httpx.AsyncClient | None = None, timeout: float = 10.0):
        self._client = client or httpx.AsyncClient(
            base_url=base_url, timeout=timeout, headers={"User-Agent": "aurex-ai/0.2"})

    @staticmethod
    def _pair(inst: InstrumentRef) -> tuple[str, str]:
        # Migrated rows use OANDA's GBP_USD form; ECB needs the ISO GBP/USD pair.
        base, quote = inst.provider_symbol.replace("_", "/").split("/")
        return base, quote

    async def _get(self, path: str, params: dict):
        try:
            r = await self._client.get(path, params=params)
        except httpx.HTTPError as e:
            raise ProviderError(f"frankfurter unreachable: {e.__class__.__name__}") from e
        if r.status_code != 200:
            raise ProviderError(f"frankfurter {path} -> HTTP {r.status_code}")
        return r.json()

    async def get_candles(self, inst, timeframe, start, end) -> list[Candle]:
        if timeframe != "1d":
            raise UnsupportedTimeframe("ECB reference rates are daily only")
        base, quote = self._pair(inst)
        data = await self._get(f"/{start.date().isoformat()}..{end.date().isoformat()}",
                               {"base": base, "symbols": quote})
        out = []
        for day, rates in sorted(data.get("rates", {}).items()):
            if quote not in rates:
                continue
            ot = datetime.combine(date.fromisoformat(day), time(0), tzinfo=UTC)
            if not (start <= ot and ot + timedelta(days=1) <= end):
                continue
            v = Decimal(str(rates[quote])).quantize(Decimal(1).scaleb(-inst.price_decimals))
            out.append(Candle(ot, v, v, v, v, Decimal(0)))
        return out

    async def get_quote(self, inst: InstrumentRef) -> RawQuote:
        base, quote = self._pair(inst)
        today = datetime.now(UTC).date()
        data = await self._get(f"/{(today - timedelta(days=10)).isoformat()}..",
                               {"base": base, "symbols": quote})
        series = sorted(data.get("rates", {}).items())
        if not series:
            raise ProviderError("frankfurter: no rates returned")
        q = Decimal(1).scaleb(-inst.price_decimals)
        last_day, last_rates = series[-1]
        last = Decimal(str(last_rates[quote])).quantize(q)
        prev = Decimal(str(series[-2][1][quote])).quantize(q) if len(series) > 1 else None
        # ECB publishes around 16:00 CET (~15:00 UTC).
        as_of = datetime.combine(date.fromisoformat(last_day), time(15, 0), tzinfo=UTC)
        return RawQuote(last=last, bid=last, ask=last, prev_close=prev, as_of=as_of,
                        source=self.name, pricing="reference")
