import json
import os
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import anthropic
import httpx

from app.core.config import get_settings
from app.research import fetch as research_fetch
from app.research import llm as research_llm
from app.research.text import squash
from tests.conftest import API, admin_headers, auth_headers, new_client
from tests.pdfgen import make_pdf


def set_env(**kv):
    for k, v in kv.items():
        os.environ[f"AUREX_{k.upper()}"] = str(v)
    get_settings.cache_clear()


def teardown_function():
    for k in ("RESEARCH_ENGINE", "RESEARCH_ALLOWED_HOSTS", "RESEARCH_ASKS_PER_HOUR"):
        os.environ.pop(f"AUREX_{k}", None)
    get_settings.cache_clear()


async def seeded(client):
    ah = await admin_headers(client)
    r = await client.post(f"{API}/research/samples", headers=ah)
    assert r.status_code == 200 and r.json()["created"] == 7
    return ah


async def ask(client, h, question, **extra):
    r = await client.post(f"{API}/research/ask", headers=h, json={"question": question, **extra})
    assert r.status_code == 201, r.text
    return r.json()


async def test_ingestion_is_admin_only_and_deduplicated(client):
    uh = await auth_headers(client, email="u@example.com")
    doc = {"title": "Policy update", "text": "The policy committee held the policy rate at 4 percent "
           "and signalled patience.", "source_name": "Test wire",
           "published_at": "2026-11-20T09:00:00Z"}
    assert (await client.post(f"{API}/research/documents", headers=uh, json=doc)).status_code == 403
    ah = await admin_headers(client)
    r = await client.post(f"{API}/research/documents", headers=ah, json=doc)
    assert r.status_code == 201
    d = r.json()["documents"][0]
    assert d["doc_type"] == "central_bank" and r.json()["created"] == 1
    r2 = await client.post(f"{API}/research/documents", headers=ah, json=doc)
    assert r2.json()["created"] == 0 and r2.json()["duplicates"] == 1
    bad = {**doc, "published_at": "2026-11-20T09:00:00"}
    assert (await client.post(f"{API}/research/documents", headers=ah, json=bad)).status_code == 422
    both = {**doc, "html": "<p>x</p>"}
    assert (await client.post(f"{API}/research/documents", headers=ah, json=both)).status_code == 422


async def test_html_and_pdf_ingestion_with_tagging(client):
    ah = await admin_headers(client)
    r = await client.post(f"{API}/research/documents", headers=ah, json={
        "title": "Crypto wrap", "source_name": "Wire", "html":
        "<p>Bitcoin rallied as exchange outflows continued.</p><script>alert(1)</script>"
        "<p>Analysts said volatility could stay elevated near term.</p>"})
    d = r.json()["documents"][0]
    assert d["symbols"] == ["BTC-USD"] and d["content_type"] == "text/html"
    detail = (await client.get(f"{API}/research/documents/{d['id']}", headers=ah)).json()
    assert "alert" not in detail["chunks"][0]["text"]

    pdf = make_pdf(["Apple Inc. quarterly results\nRevenue grew 6 percent.",
                    "Risk factors\nSupply chain concentration remains a risk."])
    r = await client.post(f"{API}/research/documents/upload", headers=ah,
                          files={"file": ("aapl.pdf", pdf, "application/pdf")},
                          data={"source_name": "Issuer filing", "published_at": "2026-11-01T00:00:00Z"})
    assert r.status_code == 201, r.text
    d = r.json()["documents"][0]
    assert d["page_count"] == 2 and d["symbols"] == ["AAPL"] and d["content_type"] == "application/pdf"
    chunks = (await client.get(f"{API}/research/documents/{d['id']}", headers=ah)).json()["chunks"]
    assert [c["page"] for c in chunks] == [1, 2]


async def test_corpus_listing_and_search(client):
    ah = await seeded(client)
    again = (await client.post(f"{API}/research/samples", headers=ah)).json()
    assert again["created"] == 0 and again["duplicates"] == 7
    page = (await client.get(f"{API}/research/documents?symbol=BTC-USD", headers=ah)).json()
    assert page["total"] == 1 and page["items"][0]["is_sample"] is True
    page = (await client.get(f"{API}/research/documents?doc_type=central_bank", headers=ah)).json()
    assert page["total"] == 1
    hits = (await client.get(f"{API}/research/search?q=policy+rate+inflation", headers=ah)).json()
    assert "Central bank" in hits[0]["document"]["title"]
    hits = (await client.get(f"{API}/research/search?q=volatility&symbols=EUR/USD", headers=ah)).json()
    assert {h["document"]["symbols"][0] for h in hits} == {"EUR/USD"}
    status = (await client.get(f"{API}/research/status", headers=ah)).json()
    assert status == {"engine": "extractive", "model": None, "embedding_model": "hashing-v1-384",
                      "documents": 7, "chunks": 7, "url_ingestion_enabled": False,
                      "llm_key_configured": False, "llm_key_source": "none"}


async def test_extractive_report_is_grounded(client):
    ah = await seeded(client)
    rep = await ask(client, ah, "What is the outlook for Northwind Robotics margins and inventory?")
    body = rep["body"]
    assert rep["engine"] == "extractive-v1" and body["insufficient_evidence"] is False
    assert body["facts"], body
    sources = {s["n"]: s for s in body["sources"]}
    for f in body["facts"]:
        assert f["verified"] is True
        assert any(squash(f["quote"]) in squash(sources[n]["excerpt"]) for n in f["citations"])
    s1 = body["sources"][0]
    for key in ("title", "source_name", "published_at", "retrieved_at", "paragraph", "stale",
                "doc_type", "age_days"):
        assert key in s1
    assert body["interpretation"]["basis"] == "system"
    assert "Interpretation" in body["interpretation"]["label"]
    assert body["contradictions"], "earnings (positive) vs analyst note (negative) should conflict"
    assert any("fictional sample" in w for w in body["warnings"])
    c = body["confidence"]
    assert 0 <= c["score"] <= 1 and c["label"] in ("low", "medium", "high")
    assert "uncalibrated" in c["method"]
    assert "never converted into an order" in body["disclaimer"]


async def test_insufficient_evidence_and_staleness(client):
    ah = await seeded(client)
    rep = await ask(client, ah, "volcanic eruptions in Iceland tourism")
    assert rep["insufficient_evidence"] is True and rep["body"]["facts"] == []
    assert rep["body"]["interpretation"] is None
    assert rep["confidence"] <= 0.2

    rep = await ask(client, ah, "Northwind supplier concentration customer risk factors")
    stale = [s for s in rep["body"]["sources"] if s["stale"]]
    assert stale and stale[0]["doc_type"] == "filing"
    assert any("stale" in w for w in rep["body"]["warnings"])

    rep = await ask(client, ah, "Northwind supplier concentration risk factors", max_age_days=30)
    assert all(not s["stale"] for s in rep["body"]["sources"])


async def test_reports_are_private_and_audited(client):
    ah = await seeded(client)
    rep = await ask(client, ah, "central bank policy rate inflation")
    listing = (await client.get(f"{API}/research/reports", headers=ah)).json()
    assert listing["total"] == 1 and listing["items"][0]["id"] == rep["id"]
    async with new_client() as other:
        oh = await auth_headers(other, email="other@example.com")
        assert (await other.get(f"{API}/research/reports/{rep['id']}", headers=oh)).status_code == 404
        assert (await other.get(f"{API}/research/reports", headers=oh)).json()["total"] == 0
    audit = (await client.get(f"{API}/admin/audit?action=research.ask", headers=ah)).json()
    assert audit["total"] == 1 and audit["items"][0]["details"]["engine"] == "extractive-v1"


async def test_ask_rate_limit(client):
    set_env(research_asks_per_hour=2)
    ah = await seeded(client)
    for _ in range(2):
        await ask(client, ah, "policy rate")
    r = await client.post(f"{API}/research/ask", headers=ah, json={"question": "policy rate"})
    assert r.status_code == 429


class FakeClaude:
    def __init__(self, payload=None, stop_reason="end_turn", exc=None):
        self.payload, self.stop_reason, self.exc, self.calls = payload, stop_reason, exc, []
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    async def _create(self, **kwargs):
        self.calls.append(kwargs)
        if self.exc:
            raise self.exc
        return SimpleNamespace(
            stop_reason=self.stop_reason, model=kwargs["model"],
            content=[SimpleNamespace(type="thinking", thinking=""),
                     SimpleNamespace(type="text", text=json.dumps(self.payload))])


async def test_claude_engine_claims_are_verified(client):
    ah = await seeded(client)
    set_env(research_engine="claude")
    fake = FakeClaude({
        "answerable": True,
        "facts": [
            {"statement": "The committee held the policy rate at 4.25%.", "source_ids": [1],
             "quote": "voted seven to two to hold the policy rate at 4.25 percent"},
            {"statement": "Rates were cut by 50bp.", "source_ids": [1],
             "quote": "the committee cut rates by 50 basis points"},
            {"statement": "Unsupported citation.", "source_ids": [99],
             "quote": "voted seven to two to hold the policy rate"},
        ],
        "interpretation": "Policy looks set to stay restrictive near term.",
        "contradictions": [], "open_questions": ["What does the next CPI print show?"],
    })
    research_llm.set_client(fake)
    rep = await ask(client, ah, "What did the central bank decide on the policy rate?")
    body = rep["body"]
    assert rep["engine"] == "claude:claude-opus-5-5"
    assert [f["statement"] for f in body["facts"]] == ["The committee held the policy rate at 4.25%."]
    reasons = sorted(r["reason"] for r in body["validation"]["rejected"])
    assert reasons == ["cites no retrieved source", "quote not found in the cited source"]
    assert body["interpretation"] == {"text": "Policy looks set to stay restrictive near term.",
                                      "basis": "model", "label": "Interpretation (model-generated)"}
    assert body["open_questions"] == ["What does the next CPI print show?"]
    assert any("failed citation verification" in w for w in body["warnings"])

    call = fake.calls[0]
    assert call["model"] == "claude-opus-5-5" and call["thinking"] == {"type": "adaptive"}
    assert call["output_config"]["effort"] == "high"
    assert call["output_config"]["format"]["type"] == "json_schema"
    assert call["fallbacks"] == "default" and call["betas"] == ["server-side-fallback-2026-07-01"]
    assert "untrusted" in call["system"]
    assert '<source id="1"' in call["messages"][0]["content"]


async def test_claude_failures_degrade_to_offline_engine(client):
    ah = await seeded(client)
    set_env(research_engine="claude")
    research_llm.set_client(FakeClaude({}, stop_reason="refusal"))
    rep = await ask(client, ah, "central bank policy rate decision")
    assert rep["engine"] == "extractive-v1 (Claude unavailable)"
    assert any("declined" in w for w in rep["body"]["warnings"]) and rep["body"]["facts"]

    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    research_llm.set_client(FakeClaude(exc=anthropic.APIConnectionError(request=req)))
    rep = await ask(client, ah, "central bank policy rate decision")
    assert any("network error" in w for w in rep["body"]["warnings"])

    research_llm.set_client(FakeClaude({"answerable": "yes"}))
    rep = await ask(client, ah, "central bank policy rate decision")
    assert any("malformed" in w for w in rep["body"]["warnings"])

    research_llm.set_client(FakeClaude({"answerable": False, "facts": [], "interpretation": "",
                                        "contradictions": [], "open_questions": ["Need CPI"]}))
    rep = await ask(client, ah, "central bank policy rate decision")
    assert rep["insufficient_evidence"] is True


async def test_url_and_feed_ingestion_guards(client):
    ah = await admin_headers(client)
    url = {"url": "https://news.example/feed.xml"}
    r = await client.post(f"{API}/research/documents/fetch", headers=ah, json=url)
    assert r.status_code == 403  # disabled until hosts are allow-listed

    set_env(research_allowed_hosts="news.example")
    feed = (b'<?xml version="1.0"?><rss><channel>'
            b"<item><title>Bitcoin flows</title><link>https://news.example/1</link>"
            b"<pubDate>Mon, 16 Nov 2026 10:00:00 GMT</pubDate>"
            b"<description>Bitcoin exchange outflows continued for a fifth week.</description></item>"
            b"<item><title>Tiny</title><description>x</description></item>"
            b"</channel></rss>")

    def handler(req: httpx.Request):
        if req.url.path == "/redirect":
            return httpx.Response(302, headers={"location": "https://evil.example/"})
        return httpx.Response(200, content=feed, headers={"content-type": "application/rss+xml"})

    research_fetch.set_http_client(httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    r = await client.post(f"{API}/research/documents/fetch", headers=ah, json=url)
    assert r.status_code == 201, r.text
    docs = r.json()["documents"]
    assert len(docs) == 1 and docs[0]["symbols"] == ["BTC-USD"]
    assert docs[0]["source_url"] == "https://news.example/1"

    for bad, code in [("http://news.example/a", 422), ("https://evil.example/a", 403),
                      ("https://news.example/redirect", 422)]:
        r = await client.post(f"{API}/research/documents/fetch", headers=ah, json={"url": bad})
        assert r.status_code == code, (bad, r.text)


async def test_delete_document_cascades(client):
    ah = await seeded(client)
    docs = (await client.get(f"{API}/research/documents", headers=ah)).json()["items"]
    target = docs[0]["id"]
    assert (await client.delete(f"{API}/research/documents/{target}", headers=ah)).status_code == 204
    assert (await client.get(f"{API}/research/documents/{target}", headers=ah)).status_code == 404
    status = (await client.get(f"{API}/research/status", headers=ah)).json()
    assert status["documents"] == 6 and status["chunks"] == 6
    _ = datetime.now(UTC) - timedelta(days=1)
