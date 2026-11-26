# External penetration test — scope and rules of engagement

> This is a briefing template for an independent tester. **No external test has been
> performed.** The go-live pentest gate remains red until a signed report is recorded.

## Target

Production URL `[DOMAIN]`, the GitHub Pages static demo `[DEMO_URL]`, and, if supplied, a
staging deployment with the same configuration. Test accounts will be provided by the owner.

## In scope

- Authentication: registration/login (if enabled), session cookies, JWT handling, TOTP,
  recovery codes, logout/revocation, rate limits and lockout.
- RBAC and tenant isolation across all `/api/v1` resources, including admin endpoints.
- Research upload/extraction (file types, size limits, XXE/SSRF), retrieval and report generation.
- Trading/risk APIs: order validation, idempotency, negative/large values, decimal precision,
  decimal/FX edge cases, protective orders, breakers, halt behaviour.
- Binary simulator: stake limits, expiry/settlement, idempotency, no real-money path.
- WebSocket/Redis stream fan-out and cross-user leakage.
- ML model registry: promotion gates, artifact integrity, drift, admin-only actions.
- Ops: metrics token, audit export/verify, anchoring, integrity, backup scripts (review only).
- Static demo: localStorage boundaries, CSP, absence of credential submission to third parties.

## Out of scope

- Denial-of-service/load testing without written approval.
- Social engineering of staff or customers; physical premises.
- Testing third-party provider systems (Finnhub, OANDA, Coinbase, Anthropic, Supabase hosted
  infrastructure) beyond standard client-side misuse.
- Real-money trading: none exists.

## Rules of engagement

- Written authorisation from `[OWNER]`; agreed test window `[DATES]`.
- Use test accounts only; no destructive actions against production data; no dumping personal
  data — report proof-of-concept hashes/screenshots instead.
- Stop immediately on evidence of production instability or exposure of real user data. Report
  critical findings by `[SECURITY EMAIL]` within 24 hours.
- Do not modify audit chain or backups; read-only verification is permitted.

## Required report

Executive summary; scope and dates; methodology; findings with CVSS/severity, affected
endpoint, reproduction steps, evidence hashes, impact, remediation and retest status; explicit
statement that no high/critical findings remain unresolved; tester name/firm and signature.
Save the signed PDF at `docs/compliance/penetration-test-report.md` (or a linked PDF with the
manifest pointing at the PDF), then update `compliance/evidence-manifest.json`.
