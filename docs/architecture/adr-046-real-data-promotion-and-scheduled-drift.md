# ADR-046 — Real-data promotion gates, scheduled drift and the demo algorithm boundary

Status: accepted · 2026-11-25

## Context

Phase 6 added nine walk-forward gates and a model registry where only an administrator can
promote a candidate. Promotion still trusted a cached `model_versions.eligible` flag and the
latest drift row. An old or hand-edited row could therefore say `eligible = true` while the
candidate had only ever seen the deterministic synthetic generator. `walk_forward` also
accepted any non-`synthetic` string as "real", including the non-executable ECB reference
feed. Drift checks existed but only ran when an administrator clicked the button; there was
no recurring monitoring, and the static demo advertised algorithms it could not run because
the shared training form defaulted to `lightgbm`.

## Decision

1. **Promotion re-checks the evidence.** `app/ml/promotion.py` re-derives all nine gates from
   the stored walk-forward metrics at promotion time, compares them with the stored gate
   results and the version's eligibility flag, verifies the artifact HMAC, confirms no
   unresolved drift, and requires every candle in the training window to come from the same
   tradable provider (`coinbase`, `finnhub` or `oanda`). `synthetic` and `ecb_reference` are
   explicitly not promotable; unknown names fail closed. A stale synthetic approval is
   cleared rather than honoured. Refusals are audited (`ml.promote`, `outcome = failure`).
   No AI path can call the promotion service; promotion remains human, audited and blocks on
   gates. Nothing retrains automatically.
2. **Drift is scheduled.** `worker.one_pass()` runs `ml_drift_pass()` on both the local loop
   and `worker-once`. Due champions and still-eligible candidates are checked at most once
   per `AUREX_ML_DRIFT_CHECK_INTERVAL_SECONDS` (default 21600) over
   `AUREX_ML_DRIFT_CHECK_WINDOW_DAYS` (default 30). Each check writes a `drift_check`
   evaluation with no human author and an audited `ml.drift_check_scheduled` record; one
   provider failure cannot abort matcher/settlement/anchoring. A drift result revokes
   eligibility only — it never retrains or promotes. Stale synthetic approvals found by the
   worker are revoked and audited as `ml.eligibility_revoked`.
3. **The static demo stays logistic-only.** Random forests and LightGBM require Python
   libraries and licensed data pipelines, neither of which exists in a browser bundle with
   no server. The demo advertises only logistic regression, the training form now defaults
   to the first advertised algorithm, and demo promotion names the synthetic-data reason
   explicitly. Real RF/LightGBM training remains a backend feature of the live build.

## Consequences

- Promotion is slightly stricter than training: a version that passed gates when trained can
  be refused later if its recorded evidence is inconsistent, its provider provenance is not
  real, or its signature is invalid. That is intentional; neither the model nor an agent can
  override it.
- The worker makes at most one drift check per model per interval, so a five-minute
  scheduler tick does not hammer vendor APIs. Operators can disable the pass with
  `AUREX_ML_DRIFT_MONITORING_ENABLED=false`.
- Demo and live ML pages look different in the algorithm dropdown; this is honest rather
  than a broken selector that submits an unsupported algorithm.

## Verification

- Backend lint clean; targeted and full pytest suites green (see final report).
- Frontend typecheck green.
- Tests cover stale synthetic eligibility, flipped gate flags, audited refusals, due/skipped
  scheduled checks, worker isolation and demo algorithm selection.
