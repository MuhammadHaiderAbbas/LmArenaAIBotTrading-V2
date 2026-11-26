# AUREX AI

Autonomous multi-market research and **paper-trading** platform covering crypto, FX, stocks and ETFs.

> **Stage 1: virtual capital only.** No real money is moved, no broker is connected,
> and live trading is disabled in both the code and the database.

**Live demo:** https://muhammadhaiderabbas.github.io/AUREX-AI-Foundation/ (click **Launch demo**).
**Video walkthrough:** see [docs/video/walkthrough.md](docs/video/walkthrough.md) for the scene-by-scene
script; `frontend/scripts/record-walkthrough.cjs` records a fresh captioned video of the demo.
The demo is a static build that runs entirely in your browser with simulated data
(see ADR-008). The real system runs the FastAPI backend below.

Delivered so far:
- **Phase 1, Foundation:** FastAPI modular monolith, React terminal UI, double-entry
  virtual ledger, auth with roles, a tamper-evident audit trail, Docker and CI.
- **Phase 3, Market data:** instrument registry for crypto, FX, stocks and ETFs; DST-aware
  session calendars; a provider interface (synthetic, Coinbase, ECB); stored candles;
  indicators; stale and tradable quote rules; watchlists; WebSocket streaming; candlestick
  charts.
- **Phase 4, Research engine:** document ingestion (text, HTML, PDF, URL, RSS);
  classification and instrument tagging; pgvector + full-text hybrid retrieval; grounded
  research reports with quote-checked citations, labelled interpretation, contradictions,
  staleness and heuristic confidence; offline engine plus an optional Claude engine.
- **Phase 5, AI agent department:** technical, quant, fundamental, news, sentiment, regime,
  portfolio and risk agents; an orchestrator and consensus engine with explicit NO TRADE
  rules; sized trade proposals that await the independent risk gate.
- **Phase 6, Quantitative models:** leak-free features; logistic, random forest and LightGBM
  models; purged walk-forward validation against baselines after costs; nine promotion gates
  (including plausibility and real-data checks); a model registry with human promotion; PSI
  drift monitoring; and an ML agent.
- **Phase 7, Strategy and backtesting:** an event-driven simulator (latency fills, spread,
  slippage, fees, gap-aware stops, market closures, daily-loss and drawdown breakers); SMA,
  RSI, Donchian and agent-consensus strategies; in-sample optimisation with a single
  out-of-sample evaluation against buy & hold.
- **Phase 8, Paper execution:** an order management system (market, limit and stop orders,
  GTC/DAY, idempotent client IDs), fills on the live bid/ask with spread, slippage and fees,
  average-cost positions, balanced ledger postings for trades, fees and realised P&L, a
  background order matcher, and a marked-to-market portfolio with equity history.
- **Phase 9, Risk engine:** an independent pre-trade gate for every order (risk per trade,
  position size, gross exposure, open positions, order-rate and price-collar checks);
  daily-loss and drawdown breakers on contribution-neutral equity; account and platform kill
  switches; bracket orders with one-cancels-other; AI proposals executed only through the
  gate; an autopilot with an emergency stop; and append-only decision and event logs.
- **Phase 10, Analytics:** time-weighted performance (Sharpe, Sortino, drawdown, CAGR, Calmar)
  against a benchmark; round-trip statistics attributed by source and exit; execution cost in
  basis points; risk-gate summaries; AI signal evaluation and calibration; hashed, audited
  reports and CSV exports.
- **Phase 11, Security hardening:**
  - a STRIDE threat model with 13 findings fixed, including spoofable proxy headers, a
    vulnerable Starlette and unkeyed model artifacts;
  - TOTP two-factor authentication, account lockout, a password block-list and session
    management;
  - JWT key rotation, request and rate limits, and stricter production guards;
  - an audit export with offline verification;
  - hardened containers, and dependency, SAST, secret and image scanning in CI.
- **Phase 12, Production:**
  - a production compose stack with automatic HTTPS, secrets as files and API replicas;
  - background-worker leader election;
  - Redis-shared rate limits;
  - Prometheus metrics, alert rules and a Grafana dashboard;
  - backups with automated restore drills;
  - external audit anchoring and an integrity checker;
  - an admin Operations page with go-live gates, runbooks, and tag-triggered image releases.
- **Small accounts and binary options (paper):**
  - fractional shares (0.0001) and 1-unit FX lots, a minimum order of 1 in the account
    currency, and a £100 GBP default account (Launch demo with £100 in the live demo);
  - a binary options simulator: HIGHER/LOWER fixed-payout contracts on live prices with a
    double-entry ledger, a dedicated risk gate, automatic settlement, and win-rate statistics
    against the break-even rate. Binary options are banned for UK retail customers (FCA); this
    is a paper simulator only.
- **Live everywhere:** a WebSocket account stream pushes fills, orders, ledger, position,
  binary and risk changes the moment they happen, plus a mark-to-market valuation every two
  seconds. Price candles tick with each quote, the equity chart grows live, and the Binary page
  has a live price chart with your strikes drawn on it. A Live badge shows the connection.

## Quick start (Docker)

```bash
cp .env.example .env             # set AUREX_JWT_SECRET
docker compose up -d --build     # → http://localhost:8080
docker compose exec backend python -m app.cli create-admin --email you@example.com --name "Your Name"
```

API docs: http://localhost:8080/api/v1/docs

## Native development

Requirements: Python 3.12+, Node 22, PostgreSQL 16.

```bash
./scripts/setup-local-postgres.sh          # creates aurex + aurex_test
make backend-install migrate
make backend-dev                           # API on :8000
make frontend-install frontend-dev         # UI on :5173 (proxies /api → :8000)
```

Instead of Postgres installed locally, you can run `docker compose up -d db redis`.

## Tests

| Suite | Command | Coverage |
|---|---|---|
| Backend (pytest, real Postgres + pgvector) | `make backend-test` | 239 tests: auth, token rotation/reuse, RBAC, tenant isolation, ledger maths and DB invariants, concurrency, idempotency, audit tampering, session calendars (DST/holidays), indicators, synthetic determinism, provider adapters (mocked HTTP), staleness, outage handling, watchlists, WebSocket, research extraction (HTML/PDF/RSS/XXE), retrieval, quote verification, Claude-engine validation and fallbacks, agents (trend/flat/bear, gates, drift, disagreement, sizing, FX, failure isolation), proposals, ML (no look-ahead, purge, metrics, gates, PSI, registry lifecycle, drift, artifact integrity), backtesting (fill timing, costs, gaps, closures, sizing, breakers, causality, IS-only optimisation), paper execution (fill maths, ledger postings, realised P&L, FX conversion, limit/stop matching, expiry, cancel, idempotency, rejections, privacy, append-only executions, DB constraints), risk engine (every check and its boundary, exits through halts, breakers incl. deposits/withdrawals, kill switches, abnormal activity, platform halt, brackets/OCO/resizing, proposal execution and refusal, autopilot, emergency stop), analytics (TWR with cash flows, ratio definitions and minimum history, drawdown duration, trade stats reconciled to the ledger, attribution, execution costs, rejection reasons, signal forward returns, calibration, report hash, CSV exports and formula-injection guard, privacy), security (headers, docs exposure, body and rate limits, password policy, lockout, registration limit, origin checks, session management, JWT rotation and forgery, artifact HMAC, audit export tamper detection, filename sanitising, production guards), two-factor authentication (RFC 6238 vectors, replay, drift, encryption at rest and key rotation, enrolment, recovery codes, attempt limits, admin reset), operations (Redis-shared limits across replicas, fail-open on outage, worker leader election and failover, readiness, metrics auth and route labels, file and signed-webhook anchoring with rewrite/truncation detection, integrity checks, admin 2FA enforcement, go-live gates and attestations, monitoring config consistent with exported metrics) |
| Frontend | `make frontend-build` | strict TypeScript + production build |
| Supabase Edge Functions | `deno check edge-functions/*/index.ts && bash scripts/check-edge-functions.sh` | Deno type-check plus CORS allowlist, proxied HTTPS, AAL2, shared Postgres limits and paper-only contract; runs in CI without project credentials |
| Rule parity | `npm run check:parity` (from `frontend/`) | static check that the browser demo and Python backend agree on calendar, risk, cost and binary rules |
| End-to-end (Playwright) | `make e2e` (builds first, then `vite preview`) | register → paper account → deposit/withdraw → session restore → logout; admin audit verification; RBAC; live market streaming and charts; research corpus and grounded reports; agent desk; model lab; backtesting; paper trading (market buy, resting limit, rejection, cancel, close position, history, ledger); risk centre (limit change, rejection with checks, bracket order, kill switch, autopilot cycle, emergency stop; platform halt in the demo); analytics (every tab, report hash, CSV download); sessions panel; audit export; two-factor enrolment and sign-in; operations page (integrity check, attestation, anchoring in the demo) |
| Static demo | `npm run build:demo` then `AUREX_E2E_DEMO=1 AUREX_WEB_URL=… npx playwright test e2e/demo.spec.ts` | the GitHub Pages build, served under its sub-path; SIMULATED DATA banner |
| Deployed builds | `AUREX_E2E_DEPLOYED=1 AUREX_E2E_DEMO=1 AUREX_WEB_URL=<site root> npx playwright test e2e/deployed.spec.ts e2e/demo.spec.ts` | post-deploy Pages job exercises the published demo and the paper-only live shell |
| Live API build | `npm run build:live` (needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`) | `live.html` → `dist-live/index.html`, real Supabase Edge API, bundled CSP meta |

GitHub Pages publishes both: the simulated demo at `/<repo>/` and the real-API build at `/<repo>/live/`. The live build fails fast if its Supabase build-time values are missing.

For the admin e2e test, set `AUREX_E2E_ADMIN_EMAIL` and `AUREX_E2E_ADMIN_PASSWORD`.

## Repository layout

```
backend/          FastAPI app, Alembic migrations, tests
  app/api/        routers (v1), auth dependencies
  app/core/       config, security, errors, middleware, rate limiting
  app/models/     SQLAlchemy models (identity, accounts, ledger, audit)
  app/services/   auth, accounts, ledger, audit
  app/market/     calendars, providers, indicators, market service (Phase 3)
  app/research/   extraction, chunking, embeddings, retrieval, reports, Claude engine (Phase 4)
  app/agents/     specialists, consensus, orchestrator (Phase 5)
  app/ml/         features, models, walk-forward validation, drift, registry (Phase 6)
  app/backtest/   event-driven engine, strategies, IS/OOS evaluation (Phase 7)
  app/trading/    order management, execution model, positions, portfolio (Phase 8)
  app/risk/       pre-trade engine, breakers, kill switches, autopilot (Phase 9)
  app/analytics/  performance, attribution, execution quality, AI evaluation, reports (Phase 10)
  app/ops/        worker leadership, readiness, metrics, anchoring, integrity, go-live gates (Phase 12)
  ops/backup/     backup, restore, restore-drill and scheduler scripts
  app/integrations/   reserved for later phases
frontend/         React + TypeScript + Vite + Tailwind; Caddy image for serving
  src/components/ design system (shadcn-style primitives) and app shell
  src/features/   auth + accounts state
  src/pages/      Overview, Markets, Portfolio, Trade History, Wallet, labs, Settings, Administration
  src/charts/     candlestick chart (TradingView Lightweight Charts)
  src/services/demo/  in-browser API used only by the GitHub Pages demo build
  e2e/            Playwright specs
docs/             architecture, ADRs, data model, API, security, compliance
infrastructure/   monitoring and deployment (populated in Phase 11)
```

## Phase 1 deliverables

- [x] Repository, Docker development environment, CI
- [x] FastAPI backend with versioned API and OpenAPI docs
- [x] PostgreSQL with Alembic migrations (including integrity triggers)
- [x] Secure registration and login (Argon2id, rotating refresh tokens, rate limiting)
- [x] Administrator and user roles; admin user management
- [x] React terminal UI: dashboard, sidebar navigation, wallet, settings, admin
- [x] Paper account creation with a virtual starting balance
- [x] Double-entry ledger; virtual deposits and withdrawals
- [x] Hash-chained audit logging with verification
- [x] Automated backend, build and end-to-end tests

## Phase 3 deliverables

- [x] Asset and instrument registry (cash instruments only: spot, spot FX, shares, ETFs)
- [x] Market session calendars (24/7, 24/5, NYSE, LSE; DST and holidays)
- [x] Provider interface: synthetic (default), Coinbase (crypto), ECB reference (FX)
- [x] Candle storage with gap-fill and admin backfill; 1m–1d timeframes
- [x] Indicators: SMA, EMA, RSI, Bollinger Bands, MACD
- [x] Stale-data protection and `tradable` flag for the future risk gate
- [x] Watchlists and WebSocket quote streaming
- [x] Markets screen with candlestick charts; public GitHub Pages demo

Market data runs in `synthetic` mode by default (clearly labelled simulated data). In `live`
mode crypto stays on Coinbase, stocks/ETFs need `AUREX_FINNHUB_API_KEY` (licensed feed;
no synthetic fallback), and FX uses `AUREX_OANDA_API_KEY` + `AUREX_OANDA_ACCOUNT_ID`
for real bid/ask quotes. Without OANDA credentials FX degrades to ECB fixings labelled
`ecb_reference`, which are never tradable. Every quote carries a `pricing` label
(`actual`, `estimated_spread`, `reference`, `simulated`). Set `AUREX_REDIS_URL` and
`AUREX_STREAM_FANOUT_ENABLED=true` for cross-replica WebSocket fan-out via Redis Streams.

## Phase 4 deliverables

- [x] Ingestion of pasted text and HTML, uploads (PDF, HTML, text), and allow-listed URLs and RSS/Atom feeds
- [x] Extraction with page and paragraph references; deduplication by content hash
- [x] Document classification, instrument tagging and lexical tone
- [x] Chunking and embeddings in pgvector (HNSW) plus Postgres full text, fused with RRF
- [x] Grounded reports: quote-checked facts, labelled interpretation, contradictions, staleness, heuristic confidence
- [x] Offline extractive engine (default) and a Claude engine (`claude-opus-5-5`) with automatic fallback
- [x] Research Lab UI (ask, report view with citations, corpus management, search); works in the static demo

Set `AUREX_RESEARCH_ENGINE=claude` and provide `AUREX_CLAUDE_API_KEY` (server-side; file
form supported) or `ANTHROPIC_API_KEY` to use Claude. `/research/status` reports only the
credential source, never the key.

## Data completeness additions

- [x] OCR fallback for scanned PDFs (Tesseract), with OCR pages recorded on the document
- [x] Crypto perp positioning/funding feed (opt-in, venue-labelled, fail-open) feeding sentiment evidence
- [x] Fundamental ratios/valuation with licensed vendor metrics or cited document extraction
- [x] Server-side Claude key configuration and non-leaking status reporting
- [x] Promotion-time real-data gates re-derived from stored evidence; stale synthetic flags cleared and failed attempts audited
- [x] Scheduled drift monitoring via `worker-once` (6-hour default), with no auto-retrain or auto-promote
- [x] Static demo deliberately stays logistic-only: RF/LightGBM need the Python backend, so the demo advertises only what it can run

## Final hardening

- [x] Live trading stays hard-disabled: no environment override, a `PAPER`-only database constraint, and automated source guard checks
- [x] `npm run check:parity` compares 23 demo/backend rule groups (calendar, early closes, costs, risk limits, binary terms, safety boundaries) and runs in CI and both Pages builds
- [x] Calendar/order edge cases: early sessions in the demo match the backend, and DAY orders expire at the trading-session close (including half days) instead of UTC midnight
- [x] Admin MFA cannot be disabled in staging/production; live surfaces still show `PAPER ONLY · MFA REQUIRED`
- [x] Binary contracts remain paper-only with a machine-readable `paper_only` flag and an explicit UK/EU retail warning in both builds

## Phase 5 deliverables

- [x] Eight specialist agents with evidence, uncertainty and abstention
- [x] Regime gate with a volatility percentile and a KS concept-drift test
- [x] Portfolio sizing at 0.5% risk of equity, no leverage, exposure caps and FX conversion
- [x] Advisory risk pre-check (market state, staleness, spread, events, limits)
- [x] Consensus engine that defaults to NO TRADE and explains every reason
- [x] Trade proposals in the blueprint format, inert by database constraint, with expiry and dismissal
- [x] Agent registry with admin weights and toggles; runs persisted and audited
- [x] Agent desk UI (decision, agent cards, evidence, proposal, activity timeline); works in the static demo

## Phase 6 deliverables

- [x] Leak-free feature pipeline (tested) and forward-return labels
- [x] Logistic regression, random forest and LightGBM, conservatively regularised
- [x] Purged walk-forward validation with costs, against buy & hold, momentum and climatology
- [x] Nine promotion gates, including plausibility and real-data checks
- [x] Model registry: candidate, champion (human, audited) and retired; one champion per instrument
- [x] Drift monitoring (PSI and calibration decay) that revokes eligibility, never auto-retrains
- [x] Integrity-checked artifacts; ML agent with zero default vote weight
- [x] Model Lab UI (train, gates, equity curves, calibration, importance, folds, drift); logistic regression in the static demo

## Phase 7 deliverables

- [x] Event-driven engine: next-open fills after latency, spread, volatility-scaled slippage, fees
- [x] Gap-aware stops, pessimistic stop-vs-target ordering, session closures
- [x] Blueprint risk limits inside the backtest: 0.5% risk per trade, 20% position cap, no leverage, 2% daily loss halt, 10% drawdown breaker
- [x] Four strategies, including a replay of the Phase 5 agent consensus; causal signals (tested)
- [x] In-sample grid optimisation, one-shot out-of-sample evaluation, fully invested buy & hold benchmark, overfitting warnings
- [x] Backtest Lab UI (equity and drawdown with OOS marker, IS/OOS table, sensitivity grid, trades, risk events); works in the static demo

## Phase 8 deliverables

- [x] Order management: MARKET, LIMIT and STOP orders; GTC (30 days) and DAY; idempotent `client_order_id`; cancel; expiry
- [x] Execution model on the live bid/ask with the Phase 7 slippage and fee schedule; FX conversion to the account currency
- [x] Spot-only, no-leverage rules: no short sells, buying power net of open buy orders, maximum 5 open positions, closed-market and stale-quote rejections
- [x] Rejected orders stored with their reason; submissions and cancels audited
- [x] One atomic transaction per fill: append-only execution and order events, balanced ledger posting (trade, fee, realised P&L), average-cost position, snapshot
- [x] Background matcher (`FOR UPDATE SKIP LOCKED`) plus an admin trigger
- [x] Portfolio (KPIs, positions marked at the bid, allocation, equity history, closed positions), Trade History (orders, timeline, executions) and an order ticket on Markets; all work in the static demo

## Phase 9 deliverables

- [x] Pure pre-trade engine with final authority over every order source: risk per trade (actual or default stop), position size, gross exposure incl. working buys, open positions, order rate, price collar
- [x] Per-account limits with blueprint defaults, user tightening and capped loosening (DB-enforced ceilings), audited
- [x] Daily-loss (auto-reset at 00:00 UTC) and drawdown (manual reset) breakers on contribution-neutral equity, valued on every order, fill, view and background pass
- [x] Account kill switch (manual or automatic on abnormal activity) and admin platform halt; halts block exposure but never exits
- [x] Bracket orders: protective stop and take-profit placed on fill, one-cancels-other, resized or cancelled as the position shrinks
- [x] AI proposals executable only through the gate (`EXECUTED` / `RISK_REJECTED`); autopilot with start, pause, stop, scheduled cycles and an emergency stop (optional flatten)
- [x] Append-only `risk_decisions` and `risk_events`; Risk Centre UI (status, limit meters, controls, limits editor, decision log with every check, events), autopilot on the agent desk, risk checks in the order ticket and trade history; all of it works in the static demo

## Phase 10 deliverables

- [x] Time-weighted, flow-neutral daily returns; Sharpe, Sortino, volatility, CAGR and Calmar (only from ≥ 20 days); max drawdown and time under water; benchmark comparison
- [x] Round-trip analytics reconciled to the ledger: win rate, profit factor, payoff, expectancy, holding time, return on cost; by source (manual / AI / autopilot), exit (manual / stop / target / emergency), symbol and asset class
- [x] Execution quality: fees, spread and slippage in bp by asset class; fill rate; rejection reasons (business vs. the risk check that failed)
- [x] Risk analytics: gate decisions by source, refusing checks, breaker and emergency timeline
- [x] AI quality: forward-return evaluation of every agent decision (BUY vs NO TRADE edge), confidence calibration (Brier, ECE) for signals and executed proposals, champion drift status
- [x] Hashed, audited full report (JSON and printable view) and audited CSV exports with formula-injection protection; periodic snapshots from the background monitor
- [x] Analytics UI with six tabs, all working in the static demo

## Phase 11 deliverables

- [x] STRIDE threat model and internal security review (`docs/security/threat-model.md`); 13 findings fixed, including:
  - uvicorn trusting spoofed `X-Forwarded-For`;
  - 7 Starlette advisories (FastAPI 0.115 → 0.165);
  - pickle artifacts guarded only by a same-row hash (now HMAC);
  - a CSP that would have blocked the deployed fonts.
- [x] TOTP two-factor authentication: encrypted seeds, replay protection, recovery codes, rate-limited verification, admin reset; full UI and demo support
- [x] Password block-list and personal-info check, per-account lockout, registration limit, session list and revocation, Origin check on cookie endpoints
- [x] JWT key rotation (`kid`, previous secrets), `*_FILE` secrets, stricter production guards (CORS, DB password, docs off)
- [x] Per-IP API rate limit and body-size limits (chunked included); full security headers on the API
- [x] Audit export (JSON Lines) with offline verification; `audit-verify`, `audit-export`, `audit-verify-file`, `ml-sign-artifacts` CLIs
- [x] Hardened compose (read-only, `cap_drop`, `no-new-privileges`, private network), tightened CSP, CSP for the static demo
- [x] `security.yml`: pip-audit, npm audit, Bandit, detect-secrets, Trivy, run on every PR and weekly; Dependabot

## Phase 12 deliverables

- [x] Production stack (`infrastructure/deployment/`):
  - Caddy with automatic HTTPS;
  - two API replicas;
  - Redis on a private network;
  - a backup scheduler container;
  - an optional Prometheus/Grafana profile;
  - every secret as a file (`*_FILE`), created by `make-secrets.sh`.
- [x] Background worker leader election (Postgres advisory lock) with a heartbeat; safe to run any number of replicas
- [x] Redis-shared sliding-window rate limits (atomic Lua, Redis clock), failing open with a counted error
- [x] `/system/ready` readiness (schema at head, Redis, worker heartbeat); `/metrics` for Prometheus (token-protected): HTTP, trading-safety and integrity gauges
- [x] Alert rules (worker stalled, no leader, 5xx rate, latency, backups or drills stale, anchors stale, rate-limit backend errors) and a Grafana dashboard. A test checks they only use exported metrics.
- [x] Backup / restore / restore-drill scripts. Every drill restores into a scratch database, runs `integrity-check` and records its outcome. They run in CI on every PR.
- [x] External audit anchoring (append-only file and/or HMAC-signed webhook), `audit-verify-anchors`, and an append-only `audit_anchors` table
- [x] Admin 2FA enforced outside development; admin Operations page (health, worker, backups, anchoring, integrity check, go-live gates, attestations)
- [x] Tag-triggered release workflow: builds, scans and pushes the backend, ops and web images to GHCR
- [x] Deployment guide and runbooks (`docs/operations/`)

## Soft launch (ADR 049)

- [x] Unmistakable paper-trading banner on every screen and auth state in the full app, the
      static demo and the live build. Live trading stays disabled; balances are virtual.
- [x] Unauthenticated `/status` page and `GET /api/v1/system/status`: phase, version, safe
      readiness checks and plain-language announcements, with no admin/ops leakage.
- [x] Feedback loop: public `/feedback` page → rate-limited `POST /api/v1/feedback` → audited
      `feedback_submissions` table → admin review at `GET /api/v1/admin/feedback`. The demo
      stores the same records in localStorage only.
- [x] Legal re-review gate: changes under `compliance/protected-paths.txt` (marketing copy,
      data providers, privacy disclosures, public copy) fail CI unless a fresh signed review
      is recorded in `compliance/legal-review.json`. The go-live evidence check blocks too.

The legal review is deliberately unsigned: soft launch may proceed, but marketing or data
changes cannot ship until UK counsel/the DPO signs `docs/compliance/legal-review.md`.

## Enforceable go-live evidence (ADR 048)

- [x] Five required attestations: external penetration test, UK solicitor review, GDPR DPIA,
      privacy policy and broker sandbox certification. Each needs a reviewer, an ISO review
      date and a 64-hex `evidence_sha256`, not just a reference string.
- [x] `compliance/evidence-manifest.json` + `python scripts/check_compliance_evidence.py`
      verify signed documents, hashes, review dates and off-site automation. The check is a
      required job in the release and deploy workflows.
- [x] Automated verified off-site copies of backups and audit anchors via rclone
      (`backend/ops/backup/offsite.sh`), wired into the daily backup scheduler with freshness
      gates (30 h) and Prometheus page alerts.
- [x] Monitoring gate requires both a metrics token and an Alertmanager webhook.
- [x] `python -m app.cli go-live-check` prints JSON and exits **1** while any gate is red,
      evidence is unsigned/mismatched, or live trading is enabled.

Draft compliance documents in `docs/compliance/` are deliberately **unsigned**: the gate
blocks until an independent tester, UK counsel and the privacy owner sign real reports and
their hashes are recorded. No live trading has been enabled.

Live trading remains disabled by design. The go-live gates are the precondition for a future,
separately reviewed change. They are not a switch.

## Small accounts and binary options deliverables

- [x] Fractional lots (migration 0012) and `AUREX_MIN_ORDER_VALUE`; the portfolio agent will not propose dust orders
- [x] Account presets (£100, £500, £1,000, $10,000, $100,000); "Launch demo with £100"
- [x] Binary contracts (`/binary/config`, `/binary/contracts`, `/binary/stats`): HIGHER/LOWER, expiries 1m to 1d, 80% payout (`AUREX_BINARY_PAYOUT_RATE`)
- [x] Ledger postings (`BINARY_OPEN`, `BINARY_SETTLE`); open stakes count in equity and the `BINARY` allocation
- [x] Binary risk gate: stake cap (% of equity), max open contracts, on/off switch in the Risk Centre, plus halts, kill switch, breakers and order rate; every decision recorded
- [x] Settlement by the background worker and on read; void and refund when no price arrives
- [x] Binary Options page with the regulatory warning, break-even and expected-value maths, open contracts with countdowns, history and statistics; ported to the static demo
- [x] ADR-036, ADR-037

See `docs/architecture/overview.md` for the architecture and `docs/architecture/decisions.md` for the ADRs.
