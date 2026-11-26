import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import httpx
import pytest

from app.market.providers.coinbase import CoinbaseProvider
from app.market.providers.finnhub import FinnhubProvider
from app.market.providers.frankfurter import FrankfurterProvider
from app.market.providers.oanda import OandaProvider
from app.market.types import InstrumentRef, ProviderError, UnsupportedTimeframe

BTC = InstrumentRef("BTC-USD", "CRYPTO", "CRYPTO_24_7", "BTC-USD", 2, Decimal("90000"))
EUR = InstrumentRef("EUR/USD", "FX", "FX_24_5", "EUR/USD", 5, Decimal("1.08"))
AAPL = InstrumentRef("AAPL", "STOCK", "US_EQUITY", "AAPL", 2, Decimal("230"))
EUR_OANDA = InstrumentRef("EUR/USD", "FX", "FX_24_5", "EUR_USD", 5, Decimal("1.08"))


def coinbase(handler) -> CoinbaseProvider:
    client = httpx.AsyncClient(base_url="https://cb.test", transport=httpx.MockTransport(handler))
    return CoinbaseProvider(client=client)


async def test_coinbase_candles_chunked_sorted_and_filtered():
    calls = []

    def handler(req: httpx.Request):
        calls.append(dict(req.url.params))
        start = datetime.fromisoformat(req.url.params["start"])
        end = datetime.fromisoformat(req.url.params["end"])
        rows, t = [], start
        while t < end:
            rows.append([int(t.timestamp()), 99, 102, 100, 101, 1.5])
            t += timedelta(hours=1)
        return httpx.Response(200, json=list(reversed(rows)))  # newest first, like upstream

    end = datetime(2026, 11, 20, tzinfo=UTC)
    start = end - timedelta(hours=400)
    out = await coinbase(handler).get_candles(BTC, "1h", start, end)
    assert len(calls) == 2  # 300-row upstream limit forces chunking
    assert len(out) == 400 and out == sorted(out, key=lambda c: c.open_time)
    assert out[0].open == Decimal("100") and out[0].high == Decimal("102")


async def test_coinbase_4h_is_aggregated_from_1h():
    def handler(req):
        assert req.url.params["granularity"] == "3600"
        start = datetime.fromisoformat(req.url.params["start"])
        rows = [[int((start + timedelta(hours=i)).timestamp()), 100 - i, 110 + i, 100 + i,
                 101 + i, 1] for i in range(8)]
        return httpx.Response(200, json=rows)

    start = datetime(2026, 11, 20, tzinfo=UTC)
    out = await coinbase(handler).get_candles(BTC, "4h", start, start + timedelta(hours=8))
    assert len(out) == 2
    first = out[0]
    assert first.open == Decimal("100") and first.close == Decimal("104")
    assert first.high == Decimal("113") and first.low == Decimal("97")
    assert first.volume == Decimal("4")


async def test_coinbase_quote_and_errors():
    def ok(req):
        if req.url.path.endswith("/ticker"):
            return httpx.Response(200, json={"price": "91000.5", "bid": "91000.1", "ask": "91000.9",
                                             "time": "2026-11-23T12:00:00.123Z"})
        return httpx.Response(200, json={"open": "90000"})

    q = await coinbase(ok).get_quote(BTC)
    assert q.last == Decimal("91000.5") and q.prev_close == Decimal("90000")
    assert q.as_of.tzinfo is not None and q.source == "coinbase"

    with pytest.raises(ProviderError):
        await coinbase(lambda r: httpx.Response(429, json={})).get_quote(BTC)
    with pytest.raises(ProviderError):
        await coinbase(lambda r: httpx.Response(200, json={"weird": 1})).get_quote(BTC)

    def boom(req):
        raise httpx.ConnectError("down")

    with pytest.raises(ProviderError, match="unreachable"):
        await coinbase(boom).get_quote(BTC)


def frankfurter(handler) -> FrankfurterProvider:
    client = httpx.AsyncClient(base_url="https://fx.test", transport=httpx.MockTransport(handler))
    return FrankfurterProvider(client=client)


async def test_frankfurter_daily_fixings():
    payload = {"rates": {"2026-11-18": {"USD": 1.0712}, "2026-11-19": {"USD": 1.07345678},
                         "2026-11-20": {"USD": 1.0751}}}

    def handler(req):
        assert req.url.params["base"] == "EUR" and req.url.params["symbols"] == "USD"
        return httpx.Response(200, content=json.dumps(payload))

    p = frankfurter(handler)
    start, end = datetime(2026, 11, 18, tzinfo=UTC), datetime(2026, 11, 21, tzinfo=UTC)
    out = await p.get_candles(EUR, "1d", start, end)
    assert [c.close for c in out] == [Decimal("1.07120"), Decimal("1.07346"), Decimal("1.07510")]
    assert all(c.open == c.high == c.low == c.close and c.volume == 0 for c in out)
    with pytest.raises(UnsupportedTimeframe):
        await p.get_candles(EUR, "1h", start, end)
    q = await p.get_quote(EUR)
    assert q.last == Decimal("1.07510") and q.prev_close == Decimal("1.07346")
    assert q.source == "ecb_reference"


def finnhub(handler) -> FinnhubProvider:
    client = httpx.AsyncClient(base_url="https://finnhub.test", transport=httpx.MockTransport(handler))
    return FinnhubProvider("licensed-key", client=client, spread_bps=2)


async def test_finnhub_licensed_quote_and_candles():
    t = int(datetime(2026, 11, 23, 12, tzinfo=UTC).timestamp())

    def handler(req: httpx.Request):
        if req.url.path.endswith("/quote"):
            assert req.url.params["symbol"] == "AAPL"
            assert req.headers["x-finnhub-token"] == "licensed-key"  # key never in the URL
            return httpx.Response(200, json={"c": 230.5, "pc": 228, "t": t, "h": 231, "l": 229})
        assert req.url.params["resolution"] == "60"
        rows = [[t - 3600, 100, 102, 99, 101, 500], [t, 101, 103, 100, 102, 600]]
        return httpx.Response(200, json={"s": "ok", "t": [r[0] for r in rows],
                                         "o": [r[1] for r in rows], "h": [r[2] for r in rows],
                                         "l": [r[3] for r in rows], "c": [r[4] for r in rows],
                                         "v": [r[5] for r in rows]})

    p = finnhub(handler)
    q = await p.get_quote(AAPL)
    assert q.source == "finnhub" and q.pricing == "estimated_spread"
    assert q.last == Decimal("230.5") and q.prev_close == Decimal("228")
    assert q.bid < q.last < q.ask and q.as_of == datetime.fromtimestamp(t, UTC)

    start = datetime.fromtimestamp(t - 7200, UTC)
    end = datetime.fromtimestamp(t + 3600, UTC)
    candles = await p.get_candles(AAPL, "1h", start, end)
    assert len(candles) == 2            # the in-progress hour is excluded
    assert candles[0].open == Decimal("100") and candles[-1].volume == Decimal("600")

    with pytest.raises(ProviderError):
        await finnhub(lambda r: httpx.Response(403, json={})).get_quote(AAPL)
    assert await finnhub(lambda r: httpx.Response(200, json={"s": "no_data"})).get_candles(
        AAPL, "1h", start, end) == []
    with pytest.raises(ProviderError):
        await finnhub(lambda r: httpx.Response(200, json={"s": "ok", "t": [1]})).get_candles(
            AAPL, "1h", start, end)


def oanda(handler) -> OandaProvider:
    client = httpx.AsyncClient(base_url="https://fx.test/v3", transport=httpx.MockTransport(handler))
    return OandaProvider("broker-key", "001", client=client)


async def test_oanda_real_bid_ask_and_candles():
    t = datetime(2026, 11, 23, 12, tzinfo=UTC)
    seen = {}

    def handler(req: httpx.Request):
        seen["path"] = req.url.path
        if req.url.path.endswith("/pricing"):
            assert req.url.params["instruments"] == "EUR_USD"
            assert req.headers["authorization"] == "Bearer broker-key"
            return httpx.Response(200, json={"prices": [{
                "instrument": "EUR_USD", "tradeable": True,
                "time": "2026-11-23T12:00:00.123Z",
                "bids": [{"price": "1.07000"}], "asks": [{"price": "1.07020"}],
            }]})
        assert req.url.params["granularity"] == "H1" and req.url.params["priceType"] == "MIDPOINT"
        return httpx.Response(200, json={"candles": [
            {"time": "2026-11-23T10:00:00Z", "open": "1.0690", "high": "1.0710",
             "low": "1.0680", "close": "1.0700", "volume": 12, "complete": True},
            {"time": "2026-11-23T11:00:00Z", "open": "1.0700", "high": "1.0705",
             "low": "1.0695", "close": "1.0701", "volume": 3, "complete": False},
        ]})

    p = oanda(handler)
    q = await p.get_quote(EUR_OANDA)
    assert q.source == "oanda" and q.pricing == "actual"
    assert q.bid == Decimal("1.07000") and q.ask == Decimal("1.07020")
    assert q.last == Decimal("1.07010") and q.as_of.microsecond == 123000

    rows = await p.get_candles(EUR_OANDA, "1h", t - timedelta(hours=3), t)
    assert len(rows) == 1 and rows[0].close == Decimal("1.0700")  # incomplete bar excluded
    assert seen["path"].endswith("/accounts/001/candles")

    def not_tradeable(req):
        return httpx.Response(200, json={"prices": [{
            "instrument": "EUR_USD", "tradeable": False, "time": "2026-11-23T12:00:00Z",
            "bids": [{"price": "1.07"}], "asks": [{"price": "1.0702"}],
        }]})

    with pytest.raises(ProviderError, match="not tradeable"):
        await oanda(not_tradeable).get_quote(EUR_OANDA)
