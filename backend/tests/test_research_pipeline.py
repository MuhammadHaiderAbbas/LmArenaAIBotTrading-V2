import pytest

from app.core.errors import BusinessRuleViolation
from app.research import classify as cls
from app.research.chunking import chunk_sections
from app.research.embeddings import HashingEmbedder, cosine
from app.research.extract import Section, extract, sniff
from app.research.fetch import parse_feed
from app.research.text import html_to_text, sentences, squash, tokens
from tests.pdfgen import make_pdf


def test_tokens_and_sentences():
    assert tokens("The revenues ROSE 18% in EUR/USD terms") == ["revenu", "rose", "18", "eur/usd", "term"]
    assert sentences("Revenue rose 18%. Margins improved to 21.5%! Outlook: cautious.") == [
        "Revenue rose 18%.", "Margins improved to 21.5%!", "Outlook: cautious."]
    assert squash("  “Quoted”  text\n here ") == '"quoted" text here'


def test_html_extraction_drops_scripts_and_navigation():
    title, text = html_to_text(
        "<html><head><title>Rate decision</title><script>steal()</script></head>"
        "<body><nav>Home | About</nav><h1>Policy</h1><p>Rates held at <b>4.25%</b>.</p>"
        "<style>p{}</style><footer>cookie banner</footer></body></html>")
    assert title == "Rate decision"
    assert text == "Policy\n\nRates held at 4.25%."


def test_pdf_extraction_keeps_page_numbers():
    pdf = make_pdf(["Quarterly results\nRevenue rose to 4.2 billion.",
                    "Risk factors\nSupply constraints may limit deliveries."])
    assert sniff(None, "report.bin", pdf) == "application/pdf"
    out = extract(pdf, "application/pdf", "fallback")
    assert [s.page for s in out.sections] == [1, 2]
    assert "Supply constraints" in out.sections[1].text
    chunks = chunk_sections(out.sections)
    assert [c.page for c in chunks] == [1, 2]
    with pytest.raises(BusinessRuleViolation):
        extract(b"%PDF-1.4 garbage", "application/pdf")


def test_classification_sentiment_and_tagging():
    assert cls.classify("Q3", "Quarterly results: revenue up, guidance raised") == "earnings"
    assert cls.classify("Decision", "The policy committee held the policy rate") == "central_bank"
    assert cls.classify("Hello", "Something happened today") == "news"
    assert cls.sentiment("Revenue rose and margins improved") > 0
    assert cls.sentiment("The outlook was not strong; risks remain elevated") == -0.75
    assert cls.sentiment("Sales did not decline") > 0
    aliases = {"BTC-USD": ["BTC-USD", "Bitcoin", "BTC"], "SPY": ["SPY"], "AAPL": ["Apple Inc.", "AAPL"]}
    assert cls.tag_instruments("bitcoin and the SPY ETF, not SPYGLASS or spy novels", aliases) == [
        "BTC-USD", "SPY"]


def test_chunking_respects_sizes_and_paragraphs():
    long_para = " ".join(f"Sentence number {i} talks about margins." for i in range(80))
    chunks = chunk_sections([Section(f"Intro paragraph.\n\n{long_para}\n\nClosing note.")])
    assert all(len(c.text) <= 1400 for c in chunks)
    assert chunks[0].paragraph == 1 and chunks[-1].text.endswith("Closing note.")
    assert [c.ordinal for c in chunks] == list(range(len(chunks)))


def test_hashing_embedder_similarity():
    e = HashingEmbedder()
    a, b, c = e.embed(["central bank holds policy rate", "policy rate held by the central bank",
                       "bitcoin exchange outflows"])
    assert len(a) == 384 and abs(cosine(a, a) - 1) < 1e-4
    assert cosine(a, b) > 0.5 > abs(cosine(a, c))


def test_feed_parsing_rss_atom_and_xxe():
    rss = b"""<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
      <item><title>Rates held</title><link>https://news.example/a</link>
      <pubDate>Mon, 16 Nov 2026 10:00:00 GMT</pubDate>
      <description>&lt;p&gt;The committee held rates at 4.25 percent today.&lt;/p&gt;</description></item>
    </channel></rss>"""
    items = parse_feed(rss)
    assert items[0].title == "Rates held" and items[0].link == "https://news.example/a"
    assert items[0].text == "The committee held rates at 4.25 percent today."
    assert items[0].published_at.isoformat() == "2026-11-16T10:00:00+00:00"
    atom = b"""<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom item</title>
      <link href="https://news.example/b"/><updated>2026-11-17T08:00:00Z</updated>
      <summary>Unemployment rose to 4.4 percent in the month.</summary></entry></feed>"""
    assert parse_feed(atom)[0].link == "https://news.example/b"
    xxe = b"""<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]>
      <rss><channel><item><title>&x;</title><description>x</description></item></channel></rss>"""
    with pytest.raises(BusinessRuleViolation):
        parse_feed(xxe)


def test_ocr_extracts_text_from_scanned_pdf():
    import shutil

    from tests.pdfgen import make_scanned_pdf

    if not shutil.which("tesseract"):
        pytest.skip("tesseract binary not installed")
    pdf = make_scanned_pdf("Revenue grew 18 percent")
    out = extract(pdf, "application/pdf", "scan")
    assert out.ocr_pages == [1]
    assert "Revenue grew" in out.sections[0].text
    chunks = chunk_sections(out.sections)
    assert chunks[0].page == 1
