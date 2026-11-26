# ADR 048 — Enforceable go-live evidence, off-site copies and alert delivery

Status: Accepted · Date: 2026-11-25 · Supersedes the display-only gate model in Phase 12.

## Context

Phase 12 introduced an admin Operations page with go-live gates, but the gates were largely
informational. Missing external penetration test, UK solicitor review, GDPR DPIA and privacy
policy sign-off were at most one gate, attestations were free text, off-site copies were a
runbook recommendation rather than a recorded control, and the monitoring gate accepted a
metrics token with no proof that alerts could be delivered.

## Decision

1. **Five attestable gates.** `pentest`, `solicitor`, `dpia`, `privacy_policy` and
   `broker_sandbox` are all required. An attestation must include a 64-hex `evidence_sha256`
   and an ISO `reviewed_at` date. `reviewed_at` must be within 365 days; a bare reference is
   rejected by the API and fails the gate in `app/ops/status.py`.
2. **Signed evidence manifest.** `compliance/evidence-manifest.json` names the approved
   documents, their hashes, reviewers and dates. `scripts/check_compliance_evidence.py`
   runs in release/deploy CI and fails while drafts, unsigned placeholder reports, hash
   mismatches or stale reviews exist. `python -m app.cli go-live-check` additionally compares
   attestation hashes with the manifest so a typed reference cannot certify an external review.
3. **Automated off-site copies.** `backend/ops/backup/offsite.sh` uses operator-supplied
   `rclone` config to copy the newest backup and the shared audit-anchor file to an immutable
   off-site remote, reads them back, verifies SHA-256, and records `last_offsite_backup` /
   `last_offsite_anchor` through `ops-record`. The daily scheduler invokes it after every
   successful backup; missing remote configuration is a no-op that leaves gates red.
4. **Freshness gates and alerts.** The two off-site controls must be `ok` and no older than
   `AUREX_MAX_OFFSITE_AGE_HOURS` (default 30 h). Prometheus gauges expose their age and
   `AurexOffsiteBackupStale` / `AurexOffsiteAnchorStale` page after 30 min above threshold.
5. **Monitoring gate.** Requires both `AUREX_METRICS_TOKEN` and
   `AUREX_ALERTMANAGER_WEBHOOK_URL`.
6. **Enforcement.** `python -m app.cli go-live-check` prints JSON and exits 1 unless every
   gate passes, signed evidence matches, and `live_trading_enabled` is false. CI blocks
   release/deploy when evidence is incomplete. This does not create a live-trading switch:
   live trading remains hard-coded off and DB-constrained to `PAPER`.

## Consequences

- Draft legal documents remain intentionally unsigned, so the automated gate fails until a
  real external report, solicitor opinion, DPIA and privacy policy are approved and hashed.
- Operators must provision `OFFSITE_REMOTE`, `secrets/rclone_conf` and the Alertmanager URL;
  the absence of these is visible as red gates rather than a silent pass.
- The static demo mirrors the new gate keys and evidence fields through the parity checker
  but intentionally reports all operational gates as unavailable.
