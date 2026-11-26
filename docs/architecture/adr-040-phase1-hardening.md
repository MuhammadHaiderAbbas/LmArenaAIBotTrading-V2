# ADR-040 — Phase 1 auth and session hardening

**Status:** Accepted, implemented 2026-11-25.

## Decisions

1. **MFA is mandatory in the live build.** After password sign-in the UI calls `mfa.listFactors()` and `getAuthenticatorAssuranceLevel()`. A user without a verified TOTP factor must enrol; a verified user at AAL1 must pass a TOTP challenge. No account, ledger or market data is loaded before AAL2.
2. **Enrolment and challenge use `mfa.challengeAndVerify`** with a 6-digit TOTP code. The secret is shown once during enrolment; recovery codes are a Phase 2 item.
3. **Session storage is `sessionStorage`**, not `localStorage`, with `detectSessionInUrl: false` (no tokens in URLs) and `autoRefreshToken: true`. This limits persistence after the tab closes. A true httpOnly-cookie session still needs a server-side BFF and is deferred.
4. **Idle timeout:** any click, keypress or mouse movement resets a 15-minute timer; expiry calls `supabase.auth.signOut({ scope: 'global' })`, invalidating all refresh tokens for that user.
5. **Global sign-out** is the only sign-out control in the UI, so a compromised browser session can be revoked everywhere.
6. **Shared rate limits** are implemented in Postgres (`aurex.rate_limit_hits` + `public.aurex_rate_limit`) and applied inside every Edge Function with per-user or per-IP keys. They fail open on DB failure; alerting is a later phase.
7. **Source sync:** all six deployed function bodies are now stored verbatim in `edge-functions/*/index.ts`; the old v1 drafts were replaced. A CLI deploy command is documented, but no GitHub push was made.

## Verification

- `tsc -b && vite build` — pass, both pages emitted.
- Playwright live E2E — pass: enrol TOTP → verify → balance/quote/chart → deposit → sign out everywhere → password + TOTP challenge → AAL2 badge and data restored. No page errors.
- Rate limit RPC — `true, true, true, false` for limit 3; live `quote` function returned 30×200 then 5×429 in one minute.
- Temporary test user and all of its `aurex` rows were deleted after the run.

## Residual risks

- No TOTP recovery codes or MFA recovery UI yet.
- No audit trail for MFA enrolment/challenge events in `aurex.audit_logs` (Supabase keeps its own auth audit log).
- Rate-limit fail-open needs alerting.
- Email confirmation still redirects to the existing portfolio site; configure the final domain before launch.
