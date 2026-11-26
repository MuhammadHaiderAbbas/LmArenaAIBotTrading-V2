import os
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from starlette.testclient import TestClient

from app.core.config import get_settings
from app.database.session import SessionLocal
from app.main import app
from app.market import service as market_service
from app.market.providers.synthetic import SyntheticProvider
from app.market.types import ProviderError, RawQuote
from app.models import MarketCandle
from tests.conftest import API, admin_headers, auth_headers


class CountingProvider(SyntheticProvider):
    def __init__(self):
        super().__init__()
        self.candle_calls = 0

    async def get_candles(self, inst, timeframe, start, end):
        self.candle_calls += 1
        return await super().get_candles(inst, timeframe, start, end)


class FixedQuote:
    """Provider stub returning a quote of a given age and source."""

    def __init__(self, age: timedelta, source="coinbase", fail=False, pricing="actual"):
        self.name, self.age, self.source, self.fail = source, age, source, fail
        self.pricing = pricing

    async def get_quote(self, inst):
        if self.fail:
            raise ProviderError("upstream down")
        p = Decimal("100")
        return RawQuote(p, p, p, Decimal("90"), datetime.now(UTC) - self.age,
                        self.source, self.pricing)

    async def get_candles(self, inst, timeframe, start, end):
        if self.fail:
            raise ProviderError("upstream down")
        return []


def live_mode():
    os.environ["AUREX_MARKET_DATA_MODE"] = "live"
    get_settings.cache_clear()


def teardown_function():
    os.environ.pop("AUREX_MARKET_DATA_MODE", None)
    get_settings.cache_clear()


async def test_requires_auth(client):
    assert (await client.get(f"{API}/markets/overview")).status_code == 401


async def test_overview_groups_all_asset_classes(client):
    h = await auth_headers(client)
    body = (await client.get(f"{API}/markets/overview", headers=h)).json()
    assert body["data_mode"] == "synthetic"
    assert {k: len(v) for k, v in body["groups"].items()} == {
        "CRYPTO": 3, "FX": 3, "STOCK": 5, "ETF": 3}
    btc = body["groups"]["CRYPTO"][0]
    assert btc["instrument"]["symbol"] == "BTC-USD" and btc["quote"]["source"] == "synthetic"
    assert btc["quote"]["pricing"] == "simulated"
    assert btc["quote"]["market_open"] is True and btc["quote"]["tradable"] is True
    q = btc["quote"]
    assert Decimal(q["bid"]) < Decimal(q["last"]) < Decimal(q["ask"])
    assert {m["market"] for m in body["markets"]} == {
        "CRYPTO_24_7", "FX_24_5", "US_EQUITY", "UK_EQUITY"}


async def test_instrument_lookup_and_search(client):
    h = await auth_headers(client)
    r = await client.get(f"{API}/markets/instruments/EURUSD", headers=h)
    assert r.status_code == 200
    inst = r.json()["instrument"]
    assert inst["symbol"] == "EUR/USD" and inst["slug"] == "EURUSD"
    assert (await client.get(f"{API}/markets/instruments/eth-usd", headers=h)).status_code == 200
    assert (await client.get(f"{API}/markets/instruments/NOPE", headers=h)).status_code == 404
    etfs = (await client.get(f"{API}/markets/instruments?asset_class=ETF", headers=h)).json()
    assert [i["symbol"] for i in etfs] == ["ISF.L", "QQQ", "SPY"]
    found = (await client.get(f"{API}/markets/instruments?q=apple", headers=h)).json()
    assert [i["symbol"] for i in found] == ["AAPL"]
    shares = [i for i in (await client.get(f"{API}/markets/instruments", headers=h)).json()
              if i["asset_class"] == "STOCK"]
    assert {i["instrument_type"] for i in shares} == {"SHARE"}  # cash equities, not CFDs


async def test_candles_are_stored_and_gap_filled(client):
    h = await auth_headers(client)
    provider = CountingProvider()
    market_service.set_provider("synthetic", provider)

    r = await client.get(f"{API}/markets/instruments/BTC-USD/candles?timeframe=1h&limit=120"
                         "&indicators=sma20,rsi14,bb20", headers=h)
    assert r.status_code == 200
    body = r.json()
    assert len(body["candles"]) == 120 and body["source"] == "synthetic"
    assert len(body["indicators"]["sma20"]) == 120 and body["indicators"]["sma20"][18] is None
    assert set(body["indicators"]["bb20"]) == {"upper", "middle", "lower"}
    times = [c["open_time"] for c in body["candles"]]
    assert times == sorted(times)

    async with SessionLocal() as db:
        stored = await db.scalar(select(func.count()).select_from(MarketCandle))
    assert stored >= 120
    calls = provider.candle_calls
    r2 = await client.get(f"{API}/markets/instruments/BTC-USD/candles?timeframe=1h&limit=120",
                          headers=h)
    assert r2.json()["candles"] == body["candles"]
    assert provider.candle_calls == calls  # served from storage, no refetch


async def test_candle_validation(client):
    h = await auth_headers(client)
    base = f"{API}/markets/instruments/AAPL/candles"
    assert (await client.get(f"{base}?timeframe=2h", headers=h)).status_code == 422
    assert (await client.get(f"{base}?indicators=foo", headers=h)).status_code == 422
    assert (await client.get(f"{base}?limit=5000", headers=h)).status_code == 422
    daily = (await client.get(f"{base}?timeframe=1d&limit=30", headers=h)).json()["candles"]
    assert len(daily) == 30
    assert all(datetime.fromisoformat(c["open_time"]).weekday() < 5 for c in daily)


async def test_stale_quotes_are_not_tradable(client):
    h = await auth_headers(client)
    live_mode()
    market_service.set_provider("coinbase", FixedQuote(timedelta(minutes=10)))
    q = (await client.get(f"{API}/markets/instruments/BTC-USD/quote", headers=h)).json()
    assert q["stale"] is True and q["tradable"] is False and q["age_seconds"] >= 600
    assert q["change_pct"] == "11.11"

    market_service.clear_caches()
    market_service.set_provider("coinbase", FixedQuote(timedelta(seconds=5)))
    q = (await client.get(f"{API}/markets/instruments/BTC-USD/quote", headers=h)).json()
    assert q["stale"] is False and q["tradable"] is True


async def test_reference_rates_are_never_tradable(client):
    h = await auth_headers(client)
    live_mode()
    market_service.set_provider("frankfurter", FixedQuote(timedelta(seconds=1),
                                                          source="ecb_reference"))
    q = (await client.get(f"{API}/markets/instruments/GBPUSD/quote", headers=h)).json()
    assert q["source"] == "ecb_reference" and q["tradable"] is False


async def test_live_equities_fail_closed_without_licensed_key(client):
    h = await auth_headers(client)
    live_mode()
    market_service.set_provider("coinbase", FixedQuote(timedelta(0), fail=True))  # no real HTTP
    r = await client.get(f"{API}/markets/instruments/AAPL/quote", headers=h)
    assert r.status_code == 503 and r.json()["error"]["code"] == "market_data_unavailable"
    r = await client.get(f"{API}/markets/instruments/AAPL/candles", headers=h)
    assert r.status_code == 503
    body = (await client.get(f"{API}/markets/overview", headers=h)).json()
    assert body["groups"]["STOCK"][0]["quote"] is None
    assert all(q is None for q in (g["quote"] for g in body["groups"]["STOCK"] +
                                   body["groups"]["ETF"]))
    # No STOCK/ETF quote is silently replaced with synthetic data when the license is absent.


async def test_quote_pricing_is_labelled_and_reference_never_tradable(client):
    h = await auth_headers(client)
    live_mode()
    market_service.set_provider("oanda", FixedQuote(timedelta(seconds=1), source="ecb_reference",
                                                    pricing="reference"))
    q = (await client.get(f"{API}/markets/instruments/GBPUSD/quote", headers=h)).json()
    assert q["source"] == "ecb_reference" and q["pricing"] == "reference"
    assert q["tradable"] is False

    market_service.clear_caches()
    market_service.set_provider("oanda", FixedQuote(timedelta(seconds=1), source="oanda"))
    q = (await client.get(f"{API}/markets/instruments/GBPUSD/quote", headers=h)).json()
    assert q["source"] == "oanda" and q["pricing"] == "actual"
    assert q["tradable"] is (q["market_open"] and not q["stale"])

    market_service.clear_caches()
    market_service.set_provider("finnhub", FixedQuote(timedelta(seconds=1), source="finnhub",
                                                      pricing="estimated_spread"))
    q = (await client.get(f"{API}/markets/instruments/AAPL/quote", headers=h)).json()
    assert q["source"] == "finnhub" and q["pricing"] == "estimated_spread"
    assert q["tradable"] is (q["market_open"] and not q["stale"])


async def test_provider_outage_returns_503_not_fake_data(client):
    h = await auth_headers(client)
    live_mode()
    market_service.set_provider("coinbase", FixedQuote(timedelta(0), fail=True))
    r = await client.get(f"{API}/markets/instruments/BTC-USD/quote", headers=h)
    assert r.status_code == 503 and r.json()["error"]["code"] == "market_data_unavailable"
    r = await client.get(f"{API}/markets/instruments/BTC-USD/candles", headers=h)
    assert r.status_code == 503
    # Overview degrades gracefully: the failed quote is null, others still present.
    body = (await client.get(f"{API}/markets/overview", headers=h)).json()
    assert body["groups"]["CRYPTO"][0]["quote"] is None
    # Live mode must never present an unlicensed/synthetic equity quote as real.
    assert body["groups"]["STOCK"][0]["quote"] is None


async def test_watchlist(client):
    h = await auth_headers(client)
    wl = (await client.get(f"{API}/markets/watchlist", headers=h)).json()
    assert [i["instrument"]["symbol"] for i in wl["items"]] == ["BTC-USD", "EUR/USD", "AAPL", "SPY"]
    r = await client.post(f"{API}/markets/watchlist/items", headers=h, json={"symbol": "NVDA"})
    assert r.status_code == 201 and r.json()["items"][-1]["instrument"]["symbol"] == "NVDA"
    r = await client.post(f"{API}/markets/watchlist/items", headers=h, json={"symbol": "nvda"})
    assert r.status_code == 409
    r = await client.delete(f"{API}/markets/watchlist/items/EURUSD", headers=h)
    assert r.status_code == 200
    assert "EUR/USD" not in [i["instrument"]["symbol"] for i in r.json()["items"]]
    r = await client.delete(f"{API}/markets/watchlist/items/EURUSD", headers=h)
    assert r.status_code == 404


async def test_backfill_is_admin_only_and_audited(client):
    h = await auth_headers(client)
    body = {"symbol": "ETH-USD", "timeframe": "1d", "days": 60}
    assert (await client.post(f"{API}/markets/backfill", headers=h, json=body)).status_code == 403
    ah = await admin_headers(client)
    r = await client.post(f"{API}/markets/backfill", headers=ah, json=body)
    assert r.status_code == 200 and r.json()["candles_upserted"] >= 59
    # idempotent upsert
    r2 = await client.post(f"{API}/markets/backfill", headers=ah, json=body)
    async with SessionLocal() as db:
        n = await db.scalar(select(func.count()).select_from(MarketCandle))
    assert n == r2.json()["candles_upserted"]
    audit = (await client.get(f"{API}/admin/audit?action=market.backfill", headers=ah)).json()
    assert audit["total"] == 2


async def test_market_status_endpoint(client):
    h = await auth_headers(client)
    rows = (await client.get(f"{API}/markets/status", headers=h)).json()
    crypto = next(r for r in rows if r["market"] == "CRYPTO_24_7")
    assert crypto["is_open"] is True and crypto["next_change"] is None


async def test_websocket_stream(client):
    token = (await auth_headers(client))["Authorization"].split()[1]
    os.environ["AUREX_STREAM_INTERVAL_SECONDS"] = "0.2"
    get_settings.cache_clear()
    try:
        with TestClient(app) as tc:
            with tc.websocket_connect(f"{API}/markets/stream") as ws:
                ws.send_json({"type": "auth", "token": "garbage"})
                assert ws.receive_json()["type"] == "error"
            with tc.websocket_connect(f"{API}/markets/stream") as ws:
                ws.send_json({"type": "auth", "token": token})
                assert ws.receive_json()["type"] == "ready"
                ws.send_json({"type": "subscribe", "symbols": ["BTC-USD", "EURUSD", "BOGUS"]})
                msg = ws.receive_json()
                assert msg["type"] == "quotes"
                assert {q["symbol"] for q in msg["data"]} == {"BTC-USD", "EUR/USD"}
                assert ws.receive_json()["type"] == "quotes"  # periodic push
    finally:
        os.environ.pop("AUREX_STREAM_INTERVAL_SECONDS", None)
        get_settings.cache_clear()


async def test_large_backfill_is_batched(client):
    """Regression: 180 days of 24/7 hourly candles exceeded Postgres' bind-parameter limit."""
    ah = await admin_headers(client)
    r = await client.post(f"{API}/markets/backfill", headers=ah, json={"symbol": "ETH-USD", "timeframe": "1h", "days": 365})
    assert r.status_code == 200, r.text
    assert r.json()["candles_upserted"] > 8000
