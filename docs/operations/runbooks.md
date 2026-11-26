# Runbooks

All commands assume the production compose project:
`alias dc='docker compose -f infrastructure/deployment/docker-compose.prod.yml --env-file infrastructure/deployment/.env.prod'`.

## Incident: suspicious trading activity or a market-data fault
1. **Halt the platform:** Administration → Platform kill switch → *Halt all trading*, with a
   reason. This blocks all new exposure on every account immediately; exits and protective
   stops keep working.
2. For a single account, use its kill switch or the emergency stop (Risk Centre). Emergency
   stop with *flatten* sells everything at market.
3. Investigate:
   - Operations → integrity check;
   - Admin → audit log (filter `order.submit`, `risk.*`);
   - `/admin/audit/export` for an offline copy.
4. Resume from the same switch. Every step is audited.

## Alert: AurexWorkerStalled / AurexNoWorkerLeader
The matcher, breaker monitor, protective stops, autopilots and anchoring are not running.
1. `dc ps` shows whether the backends are healthy, and `dc logs backend | grep -i worker` shows
   the worker's own messages.
2. Leadership is a Postgres advisory lock, so a database outage or a saturated connection
   pool stops it. Check database health first.
3. Restarting one backend is safe: `dc restart backend`. Another replica takes the lease on
   its next pass.

## Alert: AurexBackupStale / restore drill failed
1. `dc logs ops` shows the error from `backup.sh` or `restore-drill.sh`. Failed drills are
   also recorded, with the reason, on the Operations page.
2. Run them by hand:
   `dc exec ops /opt/aurex/backup/backup.sh` and `dc exec ops /opt/aurex/backup/restore-drill.sh`.
3. "cannot create extension vector": `secrets/drill_admin_url` must belong to a role that may
   create databases and the `vector` extension.

## Restore after data loss
1. Halt the platform (above) and stop the backends: `dc stop backend`.
2. Choose a backup in the `backups` volume (or the off-host copy) and check it:
   `sha256sum -c <file>.sha256`.
3. Restore into the live database (this overwrites it):
   `dc run --rm ops sh -c 'DATABASE_URL="$(cat /run/secrets/database_url)" /opt/aurex/backup/restore.sh /backups/<file> --yes'`.
4. `dc run --rm ops python -m app.cli integrity-check`. Every line must be OK.
5. Compare with the external anchors:
   `python -m app.cli audit-verify-anchors <off-host copy of aurex-anchors.jsonl>`.
   Anchors written after the backup will report missing records. That is expected after a
   restore, but record which actions were lost.
6. Start the backends, then resume trading.

## Alert: AurexAuditAnchorStale / verifying the audit trail
- To anchor now: Operations → *Anchor now*, or `python -m app.cli audit-anchor`.
- To verify against the off-host copy:
  `python -m app.cli audit-verify-anchors aurex-anchors.jsonl`. A failure ("rewritten" or
  "truncated") means the database audit chain no longer matches what was published. Treat it
  as a security incident: preserve evidence and halt.

## Alert: AurexOffsiteBackupStale / AurexOffsiteAnchorStale
- Check the recorded control: Operations → status → `offsite.backups` / `offsite.anchors`, or
  the `aurex_last_offsite_*_age_seconds` gauges.
- Check the remote with `rclone ls "$OFFSITE_REMOTE"` and compare its SHA-256 with the local
  manifest. Off-site objects must be versioned/retention-locked; never delete them from a
  routine cleanup job.
- Run `dc exec ops /opt/aurex/backup/offsite.sh` to copy and verify again. If
  `OFFSITE_REMOTE` is empty or `secrets/rclone_conf` is missing, configure them: the
  scheduler deliberately does not fake success.
- A stale control for more than 30 h fails the go-live gate; a page fires after 30 min above
  the alert threshold. If the remote checksum differs, treat it as a possible integrity
  incident and preserve both copies.

## Alert delivery and go-live verification
- Set `AUREX_ALERTMANAGER_WEBHOOK_URL` in `.env.prod` and configure a receiver in
  Alertmanager. Both the metrics token and the webhook are required by the monitoring gate.
- Run `python -m app.cli go-live-check` from a release checkout. Any nonzero exit blocks
  launch. Run `python scripts/check_compliance_evidence.py` to see which signed evidence is
  still missing. Neither command changes runtime state.

## Key rotation (JWT / data key)
1. Generate a new secret. Put the old one in a `secrets/jwt_previous` file (one secret per line)
   mounted as `AUREX_JWT_PREVIOUS_SECRETS_FILE`, set the new `secrets/jwt_secret`, then `dc up -d`.
   - Existing sessions keep working (the `kid` selects the key).
   - TOTP seeds still decrypt, because previous secrets are tried.
2. After the refresh-token lifetime (7 days), remove the previous secret.
3. If you use a dedicated `data_key` or `artifact_key`:
   - a new `data_key` needs TOTP re-enrolment (or keep the old one until users re-enrol);
   - a new `artifact_key` needs `python -m app.cli ml-sign-artifacts --yes` after
     verifying the models.

## A user lost their 2FA device and recovery codes
Administration → users → *Reset 2FA* (audited). The user signs in with their password and
enrols again. Administrators cannot reset their own 2FA; another admin must do it.

## Scaling out
Add backend replicas (`deploy.replicas`). Requirements:
- `AUREX_REDIS_URL`, so rate limits are shared;
- one database;
- the worker lease handles the rest.

Watch `aurex_worker_is_leader`: exactly one replica should report 1.
