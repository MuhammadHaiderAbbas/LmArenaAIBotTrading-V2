"""Tradable spot FX quotes from the OANDA v20 API.

Docs: GET /v3/accounts/{accountID}/pricing?instruments=EUR_USD returns ClientPrice
      objects with real ``bids``/``asks``, a ``tradeable`` flag and an RFC 3339 ``time``.
      GET /v3/accounts/{accountID}/candles?instrument=EUR_USD&granularity=H1
      &priceType=MIDPOINT&from=...&to=... returns OHLC candles with a ``complete`` flag.

Unlike ECB fixings these are executable bid/ask prices for a real venue, so the
service can mark them tradable. A price whose ``tradeable`` flag is false, or with
an empty side, is treated as a provider failure rather than being faked.
"""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import httpx

from app.market.types import TIMEFRAMES, Candle, InstrumentRef, ProviderError, RawQuote

GRANULARITY = {"1m": "M1", "5m": "M5", "15m": "M15", "30m": "M30", "1h": "H1",
               "4h": "H4", "1d": "D"}
MAX_ROWS = 1000


def oanda_symbol(symbol: str) -> str:
    return symbol.replace("/", "_")


class OandaProvider:
    name = "oanda"

    def __init__(self, api_key: str, account_id: str, base_url: str = "https://api-fxpractice.oanda.com/v3",
                 client: httpx.AsyncClient | None = None, timeout: float = 10.0):
        if not api_key or not account_id:
            raise ProviderError("oanda api key or account id is not configured")
        self.account_id = account_id
        self._client = client or httpx.AsyncClient(
            base_url=base_url.rstrip("/"), timeout=timeout,
            headers={"Authorization": f"Bearer {api_key}", "User-Agent": "aurex-ai/0.2"})
        self._client.headers.update({"Authorization": f"Bearer {api_key}"})  # injected clients too

    async def _get(self, path: str, params: dict) -> dict:
        try:
            r = await self._client.get(path, params=params)
        except httpx.HTTPError as e:
            raise ProviderError(f"oanda unreachable: {e.__class__.__name__}") from e
        if r.status_code != 200:
            raise ProviderError(f"oanda {path} -> HTTP {r.status_code}")
        try:
            data = r.json()
        except ValueError as e:
            raise ProviderError("oanda: invalid JSON") from e
        if not isinstance(data, dict):
            raise ProviderError("oanda: unexpected payload")
        return data

    async def get_quote(self, inst: InstrumentRef) -> RawQuote:
        symbol = oanda_symbol(inst.provider_symbol)
        data = await self._get(f"/accounts/{self.account_id}/pricing", {"instruments": symbol})
        prices = data.get("prices") or []
        price = next((p for p in prices if p.get("instrument") == symbol), None)
        if price is None:
            raise ProviderError("oanda pricing: instrument not returned")
        if price.get("tradeable") is False:
            raise ProviderError("oanda pricing: instrument not tradeable")
        try:
            bid = Decimal(str(price["bids"][0]["price"]))
            ask = Decimal(str(price["asks"][0]["price"]))
            as_of = datetime.fromisoformat(str(price["time"]).replace("Z", "+00:00"))
            if bid <= 0 or ask < bid or as_of.tzinfo is None:
                raise ProviderError("oanda pricing: invalid quote")
        except (ValueError, TypeError, ArithmeticError, KeyError, IndexError) as e:
            raise ProviderError("oanda pricing: unexpected payload") from e
        return RawQuote(last=(bid + ask) / 2, bid=bid, ask=ask, prev_close=None,
                        as_of=as_of, source=self.name, pricing="actual")

    async def get_candles(self, inst: InstrumentRef, timeframe: str, start: datetime,
                          end: datetime) -> list[Candle]:
        end = min(end, datetime.now(UTC))
        if timeframe not in GRANULARITY:
            raise ProviderError(f"unsupported timeframe {timeframe}")
        seconds = TIMEFRAMES[timeframe]
        rows: dict[datetime, Candle] = {}
        cursor = start
        while cursor < end:
            chunk_end = min(end, cursor + timedelta(seconds=seconds * MAX_ROWS))
            data = await self._get(f"/accounts/{self.account_id}/candles", {
                "instrument": oanda_symbol(inst.provider_symbol),
                "granularity": GRANULARITY[timeframe], "priceType": "MIDPOINT",
                "from": cursor.isoformat(), "to": chunk_end.isoformat(),
            })
            candles = data.get("candles")
            if not isinstance(candles, list):
                raise ProviderError("oanda candles: unexpected payload")
            try:
                for c in candles:
                    if not c.get("complete"):
                        continue
                    ot = datetime.fromisoformat(str(c["time"]).replace("Z", "+00:00")).astimezone(UTC)
                    if start <= ot and ot + timedelta(seconds=seconds) <= end:
                        rows[ot] = Candle(ot, Decimal(c["open"]), Decimal(c["high"]),
                                          Decimal(c["low"]), Decimal(c["close"]), Decimal(c.get("volume", 0)))
            except (ValueError, TypeError, ArithmeticError, KeyError) as e:
                raise ProviderError("oanda candles: unexpected payload") from e
            cursor = chunk_end
        return [rows[k] for k in sorted(rows)]
