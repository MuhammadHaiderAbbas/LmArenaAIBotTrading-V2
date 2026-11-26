# Research engine (Phases 4 and 6)

```
ingest ─► extract ─► classify + tag ─► chunk ─► embed ─► index
 (text, HTML,    (HTML/PDF→text,  (doc type, instruments,  (paragraph-aware,  (hashing-v1-384)  (pgvector HNSW +
  PDF upload,     page numbers)    lexical tone)            ≤ ~900 chars,                       Postgres tsvector GIN)
  URL / RSS)                                                page + ¶ refs)

ask ─► hybrid retrieve (vector ⊕ full-text, RRF) ─► engine drafts claims ─► VERIFY ─► report (persisted, audited)
                                                    extractive | Claude      quotes must appear
                                                                             in cited source text
```

## Ingestion
| Input | Path | Notes |
|---|---|---|
| Pasted text / HTML | `POST /research/documents` (admin) | HTML is stripped of script, style, nav and footer |
| File upload | `POST /research/documents/upload` (admin) | PDF (per-page text via pypdf, then Tesseract OCR on pages with no text layer), HTML, text; 10 MB cap; encrypted PDFs rejected |
| URL or RSS/Atom | `POST /research/documents/fetch` (admin) | https only, host allow-list (`AUREX_RESEARCH_ALLOWED_HOSTS`), no redirects, size cap, `defusedxml` |
| Sample corpus | `POST /research/samples` (admin) | **Fictional**, labelled everywhere, idempotent |

Documents are deduplicated by the SHA-256 of their normalised text. Each document is
classified (`earnings`, `filing`, `central_bank`, `economic_data`, `news`, `analysis`,
`other`), tagged with registry instruments, and given a lexical tone score. Each record keeps
its source, URL, publication date and retrieval timestamp, and each chunk keeps its page and
paragraph. OCR-derived pages are listed in `document.ocr_pages` so their provenance is visible.
OCR is bounded by `AUREX_OCR_MAX_PAGES` and needs the `tesseract-ocr` binary in the image.

## Positioning and fundamentals
- `GET /markets/instruments/{symbol}/positioning` returns crypto perp funding basis,
  mark/index prices and open interest from Binance USDⓈ-M futures, labelled
  `source=binance_futures`. The feed is opt-in (`AUREX_POSITIONING_ENABLED`), TTL-cached and
  fail-open (unavailable → `available=false`, never invented data). The sentiment agent uses
  a small contrarian tilt from crowded funding and records it as evidence.
- `GET /research/fundamentals?symbol=AAPL` returns ratios and valuation with a `source`
  of `finnhub` (licensed `/stock/metric`) or `document_extraction` (figures parsed from
  ingested earnings/filings with the source quote retained). The two paths are never mixed
  silently, and missing figures are omitted. The fundamental agent uses the ratios with a
  conservative, labelled valuation tilt.

## Retrieval
Two candidate lists are fused with reciprocal-rank fusion (k = 60):
- **Vector:** pgvector cosine search over `hashing-v1-384` embeddings (HNSW index).
- **Full text:** Postgres `ts_rank_cd` over a generated `tsvector` (GIN index).

Results can be filtered by instrument and maximum age. Every chunk records which embedder
produced it, so a stronger embedding model can be added and the corpus re-indexed without
mixing vector spaces.

## Reports
Every report contains:
- **Verified facts:** verbatim, cited, and **quote-checked** against the cited chunk.
  Claims that fail the check are removed and listed under `validation.rejected`.
- **Interpretation:** labelled *automated heuristic* (offline engine) or *model-generated*
  (Claude). It is never presented as fact.
- **Contradictory evidence:** sources that disagree, with citations.
- **Confidence:** computed by code from query coverage, independent sources, freshness, tonal
  agreement and the verification ratio. It is **heuristic and uncalibrated**, and is capped
  at *medium* when sources contradict each other. The model never scores itself.
- **Sources:** title, publisher, type, publication and retrieval times, page and paragraph,
  age, stale flag (per-type thresholds: news 7 days … filings 400 days), and sample flag.
- **Warnings:** insufficient evidence, stale sources, fictional samples, removed claims.

Reports are persisted per user and audited (`research.ask`). They have **no path to order
execution**.

## Engines (`AUREX_RESEARCH_ENGINE`)
| Engine | What it does |
|---|---|
| `extractive` (default) | Offline and deterministic. Ranks sentences by query overlap; facts are verbatim sentences. Contradictions come from lexical tone. |
| `claude` | `claude-opus-5-5` (configurable via `AUREX_LLM_MODEL`), adaptive thinking, effort `high`, schema-constrained JSON output, and server-side refusal fallbacks. Source text is passed as untrusted data. Any refusal, API error, missing credentials or malformed output falls back to the extractive engine, with a warning in the report. |

Credentials prefer the server-side `AUREX_CLAUDE_API_KEY` / `AUREX_CLAUDE_API_KEY_FILE`,
falling back to the SDK's `ANTHROPIC_API_KEY`. The key is passed to the Anthropic client in
code and never returned by the API: `/research/status` reports only `llm_key_configured` and
`llm_key_source` (`server_setting`, `environment`, `none`). Staging/production refuse to start
with `AUREX_RESEARCH_ENGINE=claude` and no credential. Questions are rate-limited per user
(`AUREX_RESEARCH_ASKS_PER_HOUR`, default 30).

## Demo build
The GitHub Pages demo runs a TypeScript port of the offline pipeline in the browser: text
and HTML ingestion, tagging, hashing embeddings, hybrid retrieval and the extractive report.
PDF extraction, URL/RSS ingestion and the Claude engine need the backend.
