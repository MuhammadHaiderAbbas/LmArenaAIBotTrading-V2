# Production deployment

AUREX ships as three images, published by `.github/workflows/release.yml` when a version tag
is pushed (`git tag v1.0.0 && git push origin v1.0.0`):

| Image | Contents |
|---|---|
| `ghcr.io/<owner>/aurex-backend:<tag>` | API, background worker, migrations on start |
| `ghcr.io/<owner>/aurex-ops:<tag>` | same plus the PostgreSQL client and the backup scheduler |
| `ghcr.io/<owner>/aurex-web:<tag>` | Caddy edge: the SPA, the reverse proxy, automatic HTTPS, CSP and HSTS |

Every image is scanned with Trivy before it is pushed; a fixable critical vulnerability stops
the release.

## Reference topology (single host, `infrastructure/deployment/docker-compose.prod.yml`)

```
Internet ─443─► web (Caddy, TLS) ─► backend ×2 (FastAPI) ─► managed PostgreSQL 16 + pgvector
                                         │  ├─ Redis (shared rate limits, private network)
                                         │  └─ /anchors volume (audit head anchors)
                ops (daily backup 02:15 UTC, weekly restore drill) ─► /backups volume
                prometheus + grafana (profile "monitoring", Grafana on 127.0.0.1 only)
```

- **Replicas:** run as many backend replicas as you like. They serve API traffic only
  (`AUREX_BACKGROUND_WORKER=false`). Matcher, monitor, autopilot and audit anchor run as an
  external scheduler; the Postgres advisory lock prevents a scheduled tick from overlapping
  another runner.
- **Database:** use a managed PostgreSQL with point-in-time recovery. Our own logical backups
  and restore drills are an *additional*, provider-independent layer.
- **Secrets:** stored as files under `infrastructure/deployment/secrets/` (created by
  `make-secrets.sh`, mode 600, git-ignored) and mounted as Docker secrets. The app reads them
  through `AUREX_*_FILE`. Nothing secret goes in `.env.prod`.

## First deployment
1. DNS: point `AUREX_DOMAIN` at the host. Open ports 80 and 443 only.
2. Database: create a PostgreSQL 16 database with the `vector` extension and a dedicated
   application role (not superuser). Put its URL in `secrets/database_url`. Put a
   higher-privilege URL (allowed to create databases and the `vector` extension) in
   `secrets/drill_admin_url`; it is only used by restore drills.
3. Configure:
   ```bash
   cd infrastructure/deployment
   cp .env.prod.example .env.prod      # set AUREX_DOMAIN, AUREX_IMAGE_OWNER, AUREX_VERSION
   ./make-secrets.sh                   # then edit secrets/database_url and secrets/drill_admin_url
   docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
   docker compose -f docker-compose.prod.yml --env-file .env.prod --profile monitoring up -d
   ```
4. Create the first administrator:
   ```bash
   docker compose -f docker-compose.prod.yml exec backend python -m app.cli create-admin --email you@example.com
   ```
   In production, admin endpoints require two-factor authentication. Sign in and enable 2FA in
   Settings first.
5. Verify:
   - `https://<domain>/api/v1/system/ready` returns `ready`;
   - **Operations** (admin menu) shows the worker leader, backups and anchors;
   - Grafana (via SSH tunnel to port 3000) shows the AUREX overview dashboard.
6. Ship the off-host copies: sync the `backups` and `audit_anchors` volumes to object
   storage with retention or object lock (for example a daily `rclone sync`). The anchors only
   protect against database rewrites if they are kept where database administrators cannot
   edit them.

## Edge API, scheduler and CI/CD (Supabase)

The browser-facing API is the Supabase Edge Function set in `edge-functions/`. It is deployed
from the exact local sources by `scripts/deploy-edge-functions.sh` (Management API), which is
called by `.github/workflows/deploy.yml` on a version tag via `release.yml`, or manually from
the Actions tab. `scripts/supabase-health.sh` then polls `/functions/v1/health` until the
database probe is healthy — a cold start after a Supabase free-tier pause is handled by
retrying rather than failing the deploy.

Background jobs run from `.github/workflows/scheduler.yml` every five minutes. Each tick runs
`python -m app.cli worker-once`, which takes the same advisory lock as the old in-process loop
and writes the same heartbeat. `/api/v1/system/ready` watches that heartbeat when
`AUREX_EXTERNAL_SCHEDULER=true`.

Required GitHub secrets/variables (names only — never commit values):

| Name | Used for |
|---|---|
| `SUPABASE_PROJECT_REF` (repo variable or secret) | Edge deploy, wake and health checks |
| `SUPABASE_ACCESS_TOKEN` | Management API deploy + paused-project restore |
| `SUPABASE_DB_URL` | Scheduler's database connection |
| `AUREX_REDIS_URL` | Shared Python rate limits (optional but recommended) |
| `AUREX_AUDIT_ANCHOR_WEBHOOK_URL` / `AUREX_AUDIT_ANCHOR_WEBHOOK_SECRET` | External audit anchoring from the scheduler |
| `AUREX_SSH_HOST` / `AUREX_SSH_USER` / `AUREX_SSH_KEY` / `AUREX_DEPLOY_DIR` / `AUREX_PUBLIC_DOMAIN` | Optional Python-host rollout and readiness probe |

Supabase free projects pause after inactivity. An application cannot wake a paused project
because its functions and database are not running. The scheduler and deploy workflows call
`scripts/wake-supabase.sh`, which checks project status and POSTs `/restore` when paused using
`SUPABASE_ACCESS_TOKEN`. If that token is not configured, the scripts print a notice and the
health check still fails loudly so the pause is visible.

## Upgrades and rollback
- **Upgrade:** set `AUREX_VERSION` to the new tag, then `docker compose ... pull && docker compose ... up -d`.
  Migrations run automatically on backend start (`AUREX_RUN_MIGRATIONS=true`). Replicas roll
  over one by one, and the readiness check holds traffic until the schema is at head.
- **Rollback (application only):** set the previous tag and run `up -d`. Migrations are
  additive within a phase. If a release notes a destructive migration, take a backup first
  and restore it to roll back (see the runbook).

## Go-live gates
The **Operations** page lists the operational gates:
- production settings;
- 2FA enforced for administrators;
- backups and restore drills on schedule;
- audit anchoring;
- monitoring;
- shared rate limits;
- an intact audit chain;
- two human attestations: an external penetration test, and broker sandbox certification.

Meeting every gate does **not** enable live trading. That requires a reviewed code change (see
ADR-035). The gates are the precondition for even proposing it.
