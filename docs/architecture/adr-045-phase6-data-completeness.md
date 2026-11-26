# ADR-045 — Phase 6: OCR, positioning, fundamentals and server-side Claude credentials

**Status:** Accepted (implemented locally; production credentials and Docker rebuild required)
**Date:** 2026-11-25

## Context

The research and agent stack had three visible gaps and one deployment gap:

- Scanned PDF filings were rejected: pypdf found no text layer and the error said OCR was
  planned for later. Important primary sources could not enter the corpus.
- The sentiment specialist explicitly reported "no positioning data is connected yet", and
  there was no funding/open-interest feed for crypto instruments.
- The fundamental specialist reported that ratio/valuation analysis was not implemented.
- Claude credentials relied on the SDK's ambient resolution; there was no explicit
  server-side setting or safe way to report whether a key was configured.

## Decision

1. **OCR for scanned PDFs.** `pypdf` remains the first reader. Pages with under 20 characters
   are rendered with PyMuPDF and read by Tesseract (`AUREX_OCR_ENABLED`, `OCR_LANGUAGE`,
   `OCR_DPI`, `OCR_MAX_PAGES`). OCR failures degrade to no text rather than failing ingestion.
   Each document records `ocr_pages` (migration 0014) so OCR-derived evidence is labelled.
   The API image installs `tesseract-ocr`; ingestion runs extraction in a worker thread.

2. **Positioning/funding feed.** `app/market/positioning.py` reads Binance USDⓈ-M public
   `premiumIndex` and `openInterestHist` endpoints for BTC/ETH/SOL perps, with a TTL cache,
   venue symbol/source labels and fail-open behaviour. It is opt-in
   (`AUREX_POSITIONING_ENABLED=false` by default). `GET /markets/instruments/{symbol}/positioning`
   exposes it, and the sentiment agent uses a small contrarian funding tilt with evidence.
   No values are invented for unsupported instruments or feed outages.

3. **Fundamental ratios/valuation.** `app/research/fundamentals.py` has two non-mixed paths:
   licensed Finnhub `/stock/metric` figures (`source=finnhub`) when the Phase 5 key is set,
   or regex extraction of explicitly stated figures from ingested earnings/filing chunks
   (`source=document_extraction`) with the source quote retained as evidence. Missing values
   are omitted and warnings explain provenance. `GET /research/fundamentals?symbol=AAPL` and
   the fundamental agent expose the analysis with a conservative valuation tilt — never a
   price target or trade recommendation.

4. **Server-side Claude key.** `AUREX_CLAUDE_API_KEY` / `AUREX_CLAUDE_API_KEY_FILE` are
   explicit settings passed to `AsyncAnthropic`; `ANTHROPIC_API_KEY` remains a fallback.
   `/research/status` returns only `llm_key_configured` and `llm_key_source`, never the key.
   Staging/production refuse to start with the Claude engine and no credential.

## Alternatives rejected

- **Send scanned PDFs to Claude vision** — costs per page and sends private filings off-host;
  local OCR is deterministic and auditable.
- **Treat ECB/related macro text as positioning data** — not venue funding or open interest.
- **Compute ratios from an LLM summary** — would be unverifiable. Only licensed fields or
  quoted figures from indexed documents are used.
- **Expose the Claude key in admin API responses** — status booleans/source are enough and
  cannot leak the secret into logs or browser state.

## Consequences

- The backend image grows by Tesseract and PyMuPDF; OCR is bounded by page count to avoid
  denial of service via large scanned uploads.
- Positioning is opt-in and crypto-only; the API explicitly reports `available=false`
  otherwise. Agent behaviour is unchanged when the feed is off.
- Document-extracted ratios are low-confidence and labelled; they can be superseded by the
  licensed Finnhub path without changing the schema.
- Deployments must rebuild the backend image, apply migration 0014, and optionally add the
  Claude key secret. All 261 backend tests pass, including real Tesseract OCR against a
  scanned-PDF fixture.
