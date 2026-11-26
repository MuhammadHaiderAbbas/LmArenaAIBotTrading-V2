"""Licensed US/UK stock and ETF data from Finnhub.

Docs: GET /quote?symbol=AAPL -> {c, d, dp, h, l, o, pc, t}; GET /stock/candle
      ?symbol=AAPL&resolution=D&from=<epoch>&to=<epoch> -> {s, t, o, h, l, c, v}
      where s is "ok" or "no_data". Auth: X-Finnhub-Token header or token query param;
      the header keeps the key out of URLs and access logs.

Finnhub's quote endpoint exposes a last price, not an exchange order book. We derive
bid/ask from that price with AUREX_FINNHUB_SPREAD_BPS and label the quote
``pricing="estimated_spread"`` so callers never mistake it for a real NBBO. The
last price and OHLCV candles are the licensed feed's real data: when the key is
missing or the call fails this provider raises, never a synthetic price.
"""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import httpx

from app.market.types import TIMEFRAMES, Candle, InstrumentRef, ProviderError, RawQuote

NATIVE = {"1m": "1", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "1d": "D"}
MAX_ROWS = 1000


class FinnhubProvider:
    name = "finnhub"

    def __init__(self, api_key: str, base_url: str = "https://finnhub.io/api/v1",
                 spread_bps: float = 2.0, client: httpx.AsyncClient | None = None,
                 timeout: float = 10.0):
        if not api_key:
            raise ProviderError("finnhub api key is not configured")
        self._client = client or httpx.AsyncClient(
            base_url=base_url, timeout=timeout,
            headers={"X-Finnhub-Token": api_key, "User-Agent": "aurex-ai/0.2"})
        self._client.headers.update({"X-Finnhub-Token": api_key})  # also for injected clients
        self.spread_bps = Decimal(str(spread_bps))

    async def _get(self, path: str, params: dict) -> dict:
        try:
            r = await self._client.get(path, params=params)
        except httpx.HTTPError as e:
            raise ProviderError(f"finnhub unreachable: {e.__class__.__name__}") from e
        if r.status_code in (401, 403, 429):
            raise ProviderError(f"finnhub {path} -> HTTP {r.status_code}")
        if r.status_code != 200:
            raise ProviderError(f"finnhub {path} -> HTTP {r.status_code}")
        try:
            data = r.json()
        except ValueError as e:
            raise ProviderError("finnhub: invalid JSON") from e
        if not isinstance(data, dict):
            raise ProviderError("finnhub: unexpected payload")
        return data

    async def get_candles(self, inst: InstrumentRef, timeframe: str, start: datetime,
                          end: datetime) -> list[Candle]:
        end = min(end, datetime.now(UTC))
        if timeframe not in NATIVE:
            raise ProviderError(f"unsupported timeframe {timeframe}")
        gran = NATIVE[timeframe]
        seconds = TIMEFRAMES[timeframe]
        rows: dict[int, Candle] = {}
        cursor = start
        while cursor < end:
            chunk_end = min(end, cursor + timedelta(seconds=seconds * MAX_ROWS))
            data = await self._get("/stock/candle", {
                "symbol": inst.provider_symbol, "resolution": gran,
                "from": str(int(cursor.timestamp())), "to": str(int(chunk_end.timestamp())),
            })
            if data.get("s") == "no_data":
                cursor = chunk_end
                continue
            if data.get("s") != "ok" or not all(k in data for k in ("t", "o", "h", "l", "c", "v")):
                raise ProviderError("finnhub candles: unexpected payload")
            try:
                for i, epoch in enumerate(data["t"]):
                    ot = datetime.fromtimestamp(int(epoch), UTC)
                    if start <= ot and ot + timedelta(seconds=seconds) <= end:
                        rows[int(epoch)] = Candle(
                            ot, Decimal(str(data["o"][i])), Decimal(str(data["h"][i])),
                            Decimal(str(data["l"][i])), Decimal(str(data["c"][i])),
                            Decimal(str(data["v"][i])))
            except (ValueError, TypeError, ArithmeticError, IndexError) as e:
                raise ProviderError("finnhub candles: unexpected payload") from e
            cursor = chunk_end
        out = [rows[k] for k in sorted(rows)]
        return out

    async def get_quote(self, inst: InstrumentRef) -> RawQuote:
        data = await self._get("/quote", {"symbol": inst.provider_symbol})
        try:
            last = Decimal(str(data["c"]))
            if last <= 0 or not data.get("t"):
                raise ProviderError("finnhub quote: no current price")
            as_of = datetime.fromtimestamp(int(data["t"]), UTC)
            prev = Decimal(str(data["pc"])) if data.get("pc") and Decimal(str(data["pc"])) > 0 else None
        except (ValueError, TypeError, ArithmeticError, KeyError) as e:
            raise ProviderError("finnhub quote: unexpected payload") from e
        half = (last * self.spread_bps / Decimal(10000) / 2).quantize(Decimal("0.000001"))
        return RawQuote(last=last, bid=last - half, ask=last + half, prev_close=prev,
                        as_of=as_of, source=self.name, pricing="estimated_spread")
