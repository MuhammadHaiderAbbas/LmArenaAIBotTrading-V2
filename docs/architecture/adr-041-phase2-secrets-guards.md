# ADR-041 — Phase 2: secrets, production guards, CORS and Auth role/MFA mapping

Date: 2026-11-25
Status: Accepted (staging verification complete; production flip pending owner approval)

## Context

Phase 1 delivered a working vertical slice on Supabase: Auth + TOTP MFA, Edge API, Postgres-backed rate limits and RLS. The frontend live page is hosted on GitHub Pages at `https://muhammadhaiderabbas.github.io/AUREX-AI-Foundation/`. Before public launch, keys must live in Supabase secrets, the API must enforce environment/HTTPS/CORS guards, and Supabase Auth users must map to application roles with MFA assurance.

## Decision

1. **Secrets in Supabase, not in code or Git.** Store `AUREX_JWT_SECRET`, `AUREX_TOTP_KEY`, `AUREX_ARTIFACT_KEY`, `AUREX_CORS_ORIGINS`, `AUREX_ENVIRONMENT` and `AUREX_ALLOW_REGISTRATION` as Edge Function secrets. Secret values are never written to workspace files, reports or chat.
2. **Use Supabase Auth as the source of truth for identity.** Gateway JWT verification stays enabled for data functions; TOTP is enrolled and verified through Supabase Auth. The newly provisioned JWT/TOTP/artifact keys are reserved for later server-side verification/signing features, so this phase does not replace or fork Auth.
3. **Exact-origin CORS.** `AUREX_CORS_ORIGINS` is the base origin `https://muhammadhaiderabbas.github.io` — browsers do not send the `/AUREX-AI-Foundation/` path in the `Origin` header. Unknown origins get no `Access-Control-Allow-Origin` header and no reflected header.
4. **Environment-aware guards.** `AUREX_ENVIRONMENT=staging` allows `localhost`/`127.0.0.1` origins for local testing. Setting it to `production` removes those local origins. HTTPS is enforced via `x-forwarded-proto: https` plus the Supabase gateway hostname; the internal function URL is HTTP, so checking `req.url.protocol` alone would block all traffic.
5. **MFA AAL2 + role gates.** Every data function requires `aal === "aal2"` from the verified JWT and a `user`/`admin` role from `aurex.profiles` through `public.aurex_current_role()`. `aurex.set_user_role(uuid,text)` is the controlled role setter, limited to `service_role` or an existing admin.
6. **Auth config points at the real live URL.** Supabase Auth site URL and redirect allowlist were changed from the unrelated personal-portfolio address to the GitHub Pages URL (plus localhost dev URLs). Email confirmation and low-AAL rejection remain enabled.

## Verification

- `health` v7 reports `version: phase-2.0`, `environment: staging`, exact CORS allowlist and database `ok`.
- No token → `401`; AAL1 token → `403 mfa_required`; wrong `Origin` → `403 origin_not_allowed` with no CORS echo; bad preflight origin gets no `Access-Control-Allow-Origin`.
- AAL2 token with role `user`: profile read/upsert, account create (`100`), deposit (`250` → balance `350`), live quote and candles all returned `200/201`.
- Role change to `admin` in `aurex.profiles` changed `aurex_current_role()` to `"admin"` and `aurex_is_admin()` to `true`; role was restored to `user` immediately after the check.
- Local sources match deployed v7 bodies; `health` has `verify_jwt=false`, all others `true`.

## Consequences

- The live page and local dev still work in staging. Before public launch, flip `AUREX_ENVIRONMENT` to `production`, confirm the final `AUREX_ALLOW_REGISTRATION` value, and rerun the preflight/local-origin checks.
- JWT/TOTP/artifact secrets are inert until a later phase wires them into server-side verification/signing; do not assume they are enforced just because they exist.
- Temporary Phase 2 user, MFA factor, API key, audit/rate-limit rows and token files were removed after verification.
- No commit or GitHub push was made.
