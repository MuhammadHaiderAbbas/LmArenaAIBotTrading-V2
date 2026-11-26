# ADR-039 — Supabase database, Supabase Auth and Edge Functions (Phase 0)

**Status:** Accepted, implemented as a vertical slice on 2026-11-25.
**Scope:** Phase 0 only — real app path, not the existing static demo.

## Context

The repository is a FastAPI + React paper-trading platform. The public site is hosted on GitHub Pages, which serves static files only: no Python runtime, no server-side secrets, no response headers.

A dedicated new Supabase project could not be created because the organisation has reached its free-plan limit of 2 active projects. The user chose to isolate AUREX in a dedicated `aurex` PostgreSQL schema inside the existing active project `MHaiderAbbas Portfolio` (`iemfjnspqlobfjvucdsi`), with its own grants, roles and RLS policies.

## Decisions

1. **Database:** Supabase Postgres 17, schema `aurex`. Alembic-style migrations are recorded through the Supabase migration tool. Tables: `instruments`, `profiles`, `paper_accounts`, `ledger_accounts`, `ledger_transactions`, `ledger_entries`, `quotes`, `audit_logs`, view `account_balances`. A deferred constraint trigger enforces balanced double-entry postings.
2. **RLS:** enabled on every `aurex` table. Ownership policies use `auth.uid()`. Anon has read-only access to instruments; all other access is authenticated and owner-scoped. Because PostgREST exposes only `public`, `security_invoker = true` views in `public` mirror the `aurex` tables so RLS still applies.
3. **Auth:** Supabase Auth (email + password, TOTP MFA enabled at project level, refresh rotation enabled, email confirmation required). Roles are stored in `aurex.profiles`; `admin` is reserved and never self-assigned. No passwords, JWT secrets or service-role keys exist in the browser bundle.
4. **API runtime:** six Deno Edge Functions — `health`, `profile`, `accounts`, `deposit`, `quote`, `candles`. `verify_jwt = false` only for `health`; all others require a valid Supabase user JWT. CORS allows the GitHub Pages origin and localhost dev origins only.
5. **Edge runtime constraint:** importing `@supabase/supabase-js` from `esm.sh` caused `BOOT_ERROR` at cold start. The deployed functions therefore use plain `fetch` against Supabase PostgREST with the caller's JWT. This is simpler and has no third-party module dependency. Local `edge-functions/*/index.ts` files are the original draft; the deployed v2 bodies in Supabase are authoritative until a local Deno/Supabase CLI workflow is added in Phase 1.
6. **Market data:** `quote` and `candles` call Coinbase Exchange from the server. Failures return 503; the system never substitutes synthetic prices for a requested live price. FX/equities return `live_feed_not_configured` until Phase 5.
7. **Frontend:** new static page `live.html` built alongside the existing demo. It is GitHub Pages-compatible (CSP meta tag, publishable anon key only). It contains the entire vertical slice: Supabase sign-in → profile → paper account → double-entry deposit → live BTC/USD quote → 1h candle chart.
8. **Hybrid ML decision confirmed:** heavy numpy/scikit-learn/LightGBM training and backtesting remain in a Python worker for a later phase; Edge Functions handle auth, ledger, market data and risk. Rewriting ML in TypeScript is not in scope.

## Verification performed

- `npx tsc -b && vite build` — pass, both `index.html` and `live.html` emitted.
- Edge Functions: `health` 200 with `database=ok`; unauthenticated `accounts` 401; all protected functions 200/201 with a real Supabase JWT.
- Ledger: account created at £100, deposit of 250 → balance 350; balanced-entry trigger active.
- Live data: BTC-USD quote returned with source Coinbase and was persisted to `aurex.quotes`; 200 real candles returned and rendered in the chart.
- RLS emulation as `authenticated`: user 1 sees 1 account, a stranger sees 0.
- Browser E2E: `e2e/live-phase0.spec.ts` — 1 passed, no page errors.

## Consequences / open items for Phase 1

- Schema is shared with an existing project; avoid naming collisions by keeping all objects in `aurex`.
- Supabase Auth stores the session in browser storage in this slice; evaluate http-only cookie/session hardening before public launch.
- Add the TOTP enrolment UI and MFA enforcement for admins.
- Add shared rate limits, audit anchoring off-database, and a scheduled order-matcher worker.
- Sync deployed Edge Function bodies into version control via Supabase CLI.
- Remove the temporary test users before any public release.
- Email confirmation currently redirects to the existing portfolio site; set the Phase 0 site URL/allow-list when the live domain is final.
