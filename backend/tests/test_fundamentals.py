"""Phase 6: fundamental ratios/valuation with explicit source provenance."""

from types import SimpleNamespace
from uuid import uuid4

import httpx

from app.agents import specialists as sp
from app.research.fundamentals import FundamentalService, _extract_figures
from tests.conftest import API, admin_headers, auth_headers
from tests.test_security import settings_env

METRICS = {"metric": {"peTTM": 28.5, "pbQuarterly": 45.2, "netMarginTTM": 0.24,
                      "grossMarginTTM": 0.43, "currentRatioQuarterly": 1.1,
                      "marketCapitalization": 3_000_000_000_000,
                      "enterpriseValue": 3_100_000_000_000, "bogus": "not-a-number"}}


def test_document_extraction_computes_ratios_and_keeps_quotes():
    chunk = SimpleNamespace(
        text=("AAPL annual results: revenue was $400 billion and net income of $100 billion. "
              "Earnings per share reached $6.00. Total debt was $100 billion and "
              "shareholders' equity was $50 billion."),
        page=7, id=uuid4())
    doc = SimpleNamespace(id=uuid4(), title="AAPL FY25 results", source_name="Filing wire")
    ratios, evidence = _extract_figures([(chunk, doc)], 120.0)
    assert ratios["pe_ratio"] == 20.0
    assert abs(ratios["net_margin"] - 0.25) < 1e-9
    assert ratios["debt_to_equity"] == 2.0
    assert {e["metric"] for e in evidence} >= {"revenue", "net_income", "eps"}
    assert evidence[0]["quote"] and evidence[0]["page"] == 7


async def test_finnhub_metrics_are_mapped_and_labelled(monkeypatch):
    def handler(req: httpx.Request):
        assert req.url.params["metric"] == "all"
        assert req.headers["x-finnhub-token"] == "licensed-key"
        return httpx.Response(200, json=METRICS)

    client = httpx.AsyncClient(base_url="https://finnhub.test",
                               transport=httpx.MockTransport(handler))
    settings_env(monkeypatch, finnhub_api_key="licensed-key")
    svc = FundamentalService(client=client)
    analysis = await svc.analyse(SimpleNamespace(symbol="AAPL", asset_class="STOCK",
                                                 provider_symbol="AAPL"))
    assert analysis.source == "finnhub" and not analysis.warnings
    assert analysis.ratios["pe_ratio"] == 28.5 and analysis.ratios["net_margin"] == 0.24
    assert analysis.valuation["ev_to_market_cap"] > 1
    assert "bogus" not in analysis.ratios


async def test_fundamentals_endpoint_falls_back_to_documents(client):
    h = await auth_headers(client)
    ah = await admin_headers(client)
    r = await client.post(f"{API}/research/documents", headers=ah, json={
        "title": "AAPL annual report", "source_name": "Filing wire", "doc_type": "filing",
        "text": ("Apple (AAPL) revenue was $400 billion. Net income was $100 billion. "
                 "Earnings per share was $8.00 and total equity was $250 billion.")})
    assert r.status_code == 201, r.text
    out = (await client.get(f"{API}/research/fundamentals?symbol=AAPL", headers=h)).json()
    assert out["source"] == "document_extraction"
    assert out["ratios"]["net_margin"] == 0.25
    assert any("verify" in w for w in out["warnings"])
    assert any(e["document_id"] for e in out["evidence"])
    crypto = (await client.get(f"{API}/research/fundamentals?symbol=BTC-USD", headers=h)).json()
    assert crypto["source"] == "not_applicable" and crypto["ratios"] == {}


def test_fundamental_agent_uses_ratios():
    from tests.test_agents import SHEL, UP_D, UP_H, ctx

    c = ctx(UP_H, UP_D, inst=SHEL, fundamentals={
        "source": "finnhub", "ratios": {"pe_ratio": 40.0, "net_margin": -0.05,
                                        "debt_to_equity": 3.0}})
    f = sp.fundamental(c)
    assert f.status == "ok"
    assert "Ratios from finnhub" in f.summary
    assert f.score < 0 and f.direction == -1
