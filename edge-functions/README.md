# Edge Functions — Phase 2 (secrets + guards)

Project: `iemfjnspqlobfjvucdsi` (`MHaiderAbbas Portfolio`). Base URL: `https://iemfjnspqlobfjvucdsi.supabase.co/functions/v1`.

The TypeScript files in `health/`, `profile/`, `accounts/`, `deposit/`, `quote/` and `candles/` are the **deployed v7 bodies** and are kept in sync with Supabase. Each function is standalone (no external imports) and calls PostgREST with the caller's JWT; RLS still applies.

## Secrets (names only — values are never stored in Git)

Supabase Edge Function secrets configured for this project:

| Secret | Purpose |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_DB_URL` | Built-in project access |
| `AUREX_JWT_SECRET` | JWT secret reserved for future token verification |
| `AUREX_TOTP_KEY` | TOTP/HMAC key reserved for future server-side MFA verification |
| `AUREX_ARTIFACT_KEY` | Artifact HMAC key reserved for future signed exports |
| `AUREX_CORS_ORIGINS` | Exact allowlist; currently `https://muhammadhaiderabbas.github.io` |
| `AUREX_ENVIRONMENT` | `staging` while final launch checks are pending |
| `AUREX_ALLOW_REGISTRATION` | `true` while staging validation is open |

`AUREX_JWT_SECRET`, `AUREX_TOTP_KEY` and `AUREX_ARTIFACT_KEY` are stored but **not yet read by the functions**. Supabase Auth still verifies access JWTs at the gateway; MFA is verified through Supabase Auth. This avoids duplicating/breaking authentication while the keys are provisioned.

## Guards in every function

- `Origin` allowlist: exact match from `AUREX_CORS_ORIGINS`; no wildcard, no reflected unknown origin. `http://localhost:*` / `http://127.0.0.1:*` are additionally allowed **only while `AUREX_ENVIRONMENT != production`**.
- HTTPS: trusts `x-forwarded-proto: https`, `https:` URLs, Supabase's own gateway hostname, and local dev hosts. (Supabase presents an internal `http://` URL to Edge Functions, so a naive `u.protocol === "https:"` check blocks all real traffic.)
- JWT: gateway verification (`verify_jwt=true`) for everything except `health`; functions additionally require a valid `sub` claim.
- MFA: data functions require `aal === "aal2"`, returning `403 mfa_required` for AAL1.
- Role: `public.aurex_current_role()` must return `user` or `admin`, otherwise `403 role_not_mapped`. Roles live in `aurex.profiles.role` and can be set with `aurex.set_user_role(uuid, text)`.
- Rate limits: shared Postgres `aurex.rate_limit_hits`, keyed by user where authenticated.

| Function | Auth | MFA + role | Limit/min | Purpose |
|---|---|---|---|---|
| `health` | public | no | 60/IP | Status, environment, guard report, database check |
| `profile` | JWT | yes | 20/user | Read/upsert profile, write audit |
| `accounts` | JWT | yes | 60 GET / 10 POST per user | List/create paper accounts with balanced opening deposit |
| `deposit` | JWT | yes | 20/user | Balanced virtual cash deposit |
| `quote` | JWT | yes | 30/user | Live Coinbase quote, persisted to `aurex.quotes` |
| `candles` | JWT | yes | 20/user | Coinbase OHLCV (60/300/3600/86400) |

Migrations applied: `aurex_phase0_schema`, `aurex_phase0_public_views`, `aurex_phase0_quotes_insert`, `aurex_phase1_rate_limits`, `aurex_phase2_roles`.

Auth configuration: site URL and redirect allowlist now point at the GitHub Pages live page (plus local dev URLs); email confirmation, TOTP enrolment/verification, low-AAL rejection and refresh-token rotation remain enabled.

Deployment is reproducible from the tag-driven GitHub Actions workflow, or locally with:

```bash
SUPABASE_PROJECT_REF=iemfjnspqlobfjvucdsi SUPABASE_ACCESS_TOKEN=... \
  bash scripts/deploy-edge-functions.sh
SUPABASE_PROJECT_REF=iemfjnspqlobfjvucdsi bash scripts/supabase-health.sh
```

The script PATCHes each existing function with the exact local `index.ts` and `verify_jwt`
setting, and falls back to POST when a function does not exist yet. `health` is the only
function with `verify_jwt=false`.

Never put service-role keys, DB passwords, JWT secrets, TOTP keys or artifact HMAC keys in the frontend or Git. The browser uses only the publishable anon key from a local, ignored `.env.local`.
