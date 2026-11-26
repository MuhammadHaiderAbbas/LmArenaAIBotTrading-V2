"""Phase 6: crypto perp positioning/funding feed and its API surface."""

import httpx

from app.market.positioning import PositioningProvider, PositioningService
from tests.conftest import API, auth_headers
from tests.test_security import settings_env

PREMIUM = {"symbol": "BTCUSDT", "markPrice": "90100", "indexPrice": "90050",
           "lastFundingRate": "0.00012", "nextFundingTime": 1795600000000, "time": 1795596400000}
OI = [{"sumOpenInterest": "1000", "timestamp": 1795594000000},
      {"sumOpenInterest": "1100", "timestamp": 1795596400000}]


def provider(handler) -> PositioningProvider:
    client = httpx.AsyncClient(base_url="https://futures.test",
                               transport=httpx.MockTransport(handler))
    return PositioningProvider("https://futures.test", client=client)


def feed(handler):
    calls = []

    def wrapped(req: httpx.Request):
        calls.append(req.url.path)
        return handler(req)

    return provider(wrapped), calls


async def test_positioning_provider_reads_funding_and_open_interest():
    def handler(req: httpx.Request):
        if req.url.path.endswith("/premiumIndex"):
            assert req.url.params["symbol"] == "BTCUSDT"
            return httpx.Response(200, json=PREMIUM)
        assert req.url.path.endswith("/openInterestHist")
        assert req.url.params["period"] == "5m"
        return httpx.Response(200, json=OI)

    p, calls = feed(handler)
    snap = await p.get("BTCUSDT")
    assert len(calls) == 2
    assert snap.source == "binance_futures" and snap.venue_symbol == "BTCUSDT"
    assert snap.funding_rate == 0.00012 and snap.funding_bps == 1.2
    assert snap.mark_price == 90100 and snap.index_price == 90050
    assert snap.open_interest == 1100 and abs(snap.oi_change_pct - 10) < 1e-9
    assert snap.as_of == 1795596400


async def test_positioning_service_is_opt_in_cached_and_fail_open(monkeypatch):
    calls = []

    def handler(req):
        calls.append(req.url.path)
        return httpx.Response(200, json=PREMIUM if req.url.path.endswith("premiumIndex") else OI)

    svc = PositioningService(client=provider(handler)._client)  # disabled by default
    assert await svc.snapshot("BTC-USD") is None
    assert await svc.snapshot("AAPL") is None

    settings_env(monkeypatch, positioning_enabled=True)
    svc = PositioningService(client=provider(handler)._client)
    first = await svc.snapshot("BTC-USD")
    second = await svc.snapshot("BTC-USD")
    assert first is not None and second == first and len(calls) == 2  # TTL cache

    broken = httpx.AsyncClient(base_url="https://futures.test",
                               transport=httpx.MockTransport(lambda r: httpx.Response(503)))
    assert await PositioningService(client=broken).snapshot("ETH-USD") is None


async def test_positioning_endpoint(monkeypatch, client):
    h = await auth_headers(client)
    settings_env(monkeypatch, positioning_enabled=True)
    monkeypatch.setattr("app.api.v1.markets.PositioningService", lambda: PositioningService(
        client=provider(lambda r: httpx.Response(
            200, json=PREMIUM if r.url.path.endswith("premiumIndex") else OI))._client))

    ok = await client.get(f"{API}/markets/instruments/BTC-USD/positioning", headers=h)
    assert ok.status_code == 200
    body = ok.json()
    assert body["available"] is True and body["data"]["source"] == "binance_futures"
    assert body["data"]["funding_bps"] == 1.2

    unsupported = await client.get(f"{API}/markets/instruments/AAPL/positioning", headers=h)
    assert unsupported.status_code == 200 and unsupported.json()["available"] is False
