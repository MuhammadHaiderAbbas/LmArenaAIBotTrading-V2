# ADR-047 — Final boundaries: no live trading, automated rule parity, session-aware orders

Status: accepted · 2026-11-25

## Context

The project already described itself as paper-only and required 2FA for admins outside
development, but some boundaries were implicit rather than enforced: an operator could set
`AUREX_REQUIRE_ADMIN_MFA=false` in production, a plausible `AUREX_LIVE_TRADING_ENABLED`
variable would have been silently ignored, and the browser demo's calendar and order rules
were hand-ported copies of backend constants with no automated drift check. The demo also
used UTC midnight for DAY order expiry and did not know about the backend's early closes.
Binary options were labelled as a paper simulator in the UI, but the config response did not
say so in a machine-readable way.

## Decision

1. **Live trading remains off and fails loudly.** `Settings.live_trading_enabled` is still
   hard-coded `False`; the database still constrains `trading_accounts.mode = 'PAPER'`; and
   any true-ish `AUREX_LIVE_TRADING_ENABLED` value now raises a settings validation error.
   The parity checker also asserts both source invariants on every frontend build.
2. **Demo/backend rule parity is automated.** `scripts/check-rule-parity.mjs` compares 21
   rule groups: NYSE/LSE holidays, early closes, risk defaults and ceilings, assumed stops,
   execution fees/slippage, synthetic spreads, binary payout/expiries/void window/minimum
   stake/disclosure, and the `paper_only`, live-trading and admin-MFA boundaries. It runs as
   `npm run check:parity` in CI and as a `prebuild` hook for every demo/live bundle.
3. **Calendar and order edge cases are finished in both builds.** The demo now carries the
   same early-close table as `app/market/calendar.py`, and both builds expire DAY orders at
   the end of the current trading session (including half days) rather than at UTC midnight;
   24/7 crypto still uses the next UTC midnight. FX uses the Friday New York close.
4. **Admin MFA is mandatory in staging/production.** `AUREX_REQUIRE_ADMIN_MFA=false` is a
   configuration error there, not a supported override. The live build continues to show
   `PAPER ONLY · MFA REQUIRED`, and the Supabase Edge data functions keep requiring AAL2.
5. **Binary options stay paper-only and warned.** `/binary/config` and `/binary/stats` now
   return `paper_only: true` (demo matches), while the page keeps the regulatory warning,
   the below-even-money payout maths and a testable disclaimer. Nothing creates a real-money
   binary contract.

## Consequences

- A drift in a mirrored rule fails the build before a Pages deployment. Adding a new mirrored
   rule requires updating the checker alongside both implementations.
- DAY orders no longer rest overnight for session markets; their expiry matches the actual
  trading day, including early closes. Tests pin the Black Friday, FX-week and UK half-day
  cases.
- Production misconfiguration fails at startup rather than silently reducing security.
- No change to the Stage 1 boundary: live trading still needs a reviewed code change, not a
  flag, migration or gate combination.

## Verification

- Backend lint clean; full pytest suite green (see final report).
- `node scripts/check-rule-parity.mjs` → 23 rule groups match.
- Frontend typecheck, demo build and static-demo Playwright smoke green.
