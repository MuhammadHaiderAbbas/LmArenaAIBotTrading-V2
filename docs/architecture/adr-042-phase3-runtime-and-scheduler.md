# ADR-042 — Phase 3: deployed API, health probes, external scheduler and CI/CD

Date: 2026-11-25
Status: Accepted. Workflows are in the workspace; execution needs a tag push and repository secrets.

## Context

Phase 2 put the browser-facing API on Supabase Edge Functions with secrets, CORS, MFA and role guards. The Python backend already has matcher/monitor/autopilot/anchoring logic, but it ran as a loop inside every API process; it also has Redis-backed rate limits whose test harness did not reset shared counters between tests. Supabase free projects pause after inactivity, so an in-process scheduler is not reliable for a public demo.

## Decision

1. **Edge Functions remain the browser API.** The six deployed functions are deployed from the exact local `edge-functions/*/index.ts` bodies. `scripts/deploy-edge-functions.sh` uses the Supabase Management API (PATCH, with POST fallback), sets `verify_jwt=false` only for `health`, and prints no secret values.
2. **Health before traffic.** `scripts/supabase-health.sh` polls `/functions/v1/health` until `database == "ok"` and the expected version prefix matches. Python keeps `/api/v1/system/health` (liveness) and `/api/v1/system/ready` (schema, Redis, heartbeat); Docker Compose uses the readiness endpoint for its container healthcheck.
3. **Jobs move to an external scheduler.** `.github/workflows/scheduler.yml` runs every five minutes and calls `python -m app.cli worker-once`. The new `worker.run_once()` takes the same Postgres session advisory lock as the old loop, performs one pass (matcher, monitor, binary settlement, autopilot, anchor when due), writes the same heartbeat, then releases the lock. Deployed API replicas set `AUREX_BACKGROUND_WORKER=false`; `/system/ready` treats a fresh heartbeat as proof the scheduler is alive via `AUREX_EXTERNAL_SCHEDULER=true`.
4. **Shared rate limits are real and tested.** Edge functions use the shared Postgres RPC from Phase 1. Python uses Redis when `AUREX_REDIS_URL` is set. CI now sets a Redis test URL, and the autouse test fixture flushes `aurex:rl:*` before every test. Redis clients are keyed by event loop so TestClient shutdown does not close a connection owned by the pytest loop.
5. **CI/CD from a tag.** `release.yml` builds/scans/pushes images, then calls the reusable `deploy.yml`: deploy Edge Functions, optionally roll the Python host over SSH, then probe health/readiness. Manual `workflow_dispatch` is allowed. No push is made from this workspace.
6. **Free-tier pauses are handled outside the app.** A paused project cannot run its own functions to wake itself. The deploy and scheduler workflows call `scripts/wake-supabase.sh`, which checks the Management API project status and POSTs `/restore` when paused. Health checks retry through cold starts. If no token is configured the scripts warn and health still fails visibly.

## Verification

- `ruff check .` passed.
- Full backend suite with Redis enabled: `241 passed in 83.41s`.
- `worker-once` smoke test produced one balanced pass and wrote a fresh `worker_heartbeat`.
- Local `supabase-health.sh` against the live project returned version `phase-2.0`, environment `staging`, database `ok` and the exact CORS allowlist.
- Supabase project status: `ACTIVE_HEALTHY`; no restore was needed.
- All workflow YAML files parse; all shell scripts pass `bash -n`.

## Consequences

- Paper-trading passes are now at most five minutes apart instead of one second. This is a deliberate trade for a scheduler that survives API restarts and free-tier pauses; it needs revisiting before any real-time claim.
- A scheduled tick exits when another runner holds the lease, so overlapping GitHub Actions runs or an old in-process worker cannot double-execute autopilot/anchor work.
- Repository secrets must be configured before the workflows can deploy: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_URL`, optional Redis/webhook secrets, and the optional SSH host secrets (names listed in `docs/operations/deployment.md`).
- `AUREX_ENVIRONMENT` remains `staging` in the Edge API; the production flip still needs owner approval.
