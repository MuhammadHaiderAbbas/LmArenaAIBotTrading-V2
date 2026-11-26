# ADR 049 — Soft launch: visible paper boundary, status, feedback and legal change gate

Status: Accepted · Date: 2026-11-25 (user local) · Builds on ADR 047/048.

## Context

The platform is ready for a limited, invitation-led soft launch, but public visitors need an
unmistakable disclosure that nothing is real-money, operators need a safe public health
surface, and product feedback must be captured without weakening tenant boundaries. Marketing
copy, market-data sources and privacy disclosures also need a re-review trigger: an external
legal review done once cannot silently authorise later data or claims changes.

## Decision

1. **Persistent banners.** `PaperTradingBanner` renders on every auth state in the full app,
   the static demo, and both authenticated and unauthenticated live-build screens. Text:
   “PAPER TRADING ONLY · VIRTUAL CAPITAL · NO REAL MONEY OR LIVE ORDERS”, with Status and
   Feedback links.
2. **Public status.** `GET /api/v1/system/status` and the demo mirror expose phase, version,
   operational checks and plain-language announcements. They deliberately omit admin gates,
   user counts and other sensitive ops detail. A public `/status` page polls it every 30 s.
3. **Feedback loop.** `POST /api/v1/feedback` accepts category, message and optional reply
   email without an account, rate-limited per IP (5/hour), audited and stored in the
   `feedback_submissions` migration (0015). Admins review via `GET /api/v1/admin/feedback`.
   The demo mirrors the same contract in localStorage; the public `/feedback` page works in
   both builds. No credentials or personal financial data should be submitted.
4. **Legal re-review gate.** `compliance/protected-paths.txt` lists marketing and data paths.
   `scripts/check_legal_gate.py` fails CI when a commit touches any of them unless
   `compliance/legal-review.json` records a fresh, signed review whose SHA-256 matches
   `docs/compliance/legal-review.md` and whose date is at or after that commit (max 90 days).
   The same item blocks the go-live evidence check. It is intentionally unsigned today.
5. **No scope creep.** Live trading stays hard-coded off, accounts remain DB-constrained to
   `PAPER`, and no real-money, payment, custody or broker integration was added.

## Consequences

- Public status and feedback endpoints are unauthenticated by design; their payloads are
  narrowly scoped and rate-limited where they accept input.
- Any marketing or data change is blocked until counsel/DPO re-reviews; an old sign-off does
  not carry forward automatically.
- Demo/backend parity now covers the banner, public status and feedback routes (34 groups).
