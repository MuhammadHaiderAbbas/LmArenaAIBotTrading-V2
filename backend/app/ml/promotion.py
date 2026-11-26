"""Promotion-time gate re-check for the model registry.

Promotion is always an explicit, audited administrator action. This module makes the
server re-derive the decision from stored validation evidence and market-data provenance
instead of trusting a cached `eligible` flag: a synthetic-only model stays unpromotable even
if an old row still says `eligible = true`, and a version whose recorded metrics no longer
satisfy the gates is refused. No AI action calls this module; there is no auto-promotion.
"""

from dataclasses import asdict, dataclass
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import verify_artifact
from app.ml.validation import REAL_TRAINING_SOURCES, recheck_gates
from app.models import Instrument, MarketCandle, ModelEvaluation, ModelVersion


@dataclass(frozen=True)
class PromotionCheck:
    name: str
    passed: bool
    value: str
    threshold: str


@dataclass(frozen=True)
class PromotionDecision:
    ok: bool
    checks: list[PromotionCheck]

    @property
    def failed(self) -> list[dict[str, Any]]:
        return [asdict(c) for c in self.checks if not c.passed]

    @property
    def failed_names(self) -> str:
        return ", ".join(c.name for c in self.checks if not c.passed)


async def evaluate_promotion(db: AsyncSession, v: ModelVersion) -> PromotionDecision:
    """Re-check every promotion gate. Returns evidence; never mutates the version."""
    checks: list[PromotionCheck] = []

    def check(name: str, passed: bool, value: Any, threshold: str) -> None:
        checks.append(PromotionCheck(name, bool(passed), str(value), threshold))

    check("Candidate status", v.status == "candidate", v.status, "candidate")

    source_ok = v.data_source in REAL_TRAINING_SOURCES
    check("Real market data source", source_ok, v.data_source,
          "one of " + ", ".join(sorted(REAL_TRAINING_SOURCES)))

    instrument_id = await db.scalar(select(Instrument.id).where(Instrument.symbol == v.symbol))
    counts: dict[str, int] = {}
    if instrument_id is not None:
        rows = await db.execute(
            select(MarketCandle.source, func.count())
            .where(MarketCandle.instrument_id == instrument_id,
                   MarketCandle.timeframe == v.timeframe,
                   MarketCandle.open_time >= v.train_from,
                   MarketCandle.open_time <= v.train_to)
            .group_by(MarketCandle.source))
        counts = {str(row[0]): int(row[1]) for row in rows}
    candles = sum(counts.values())
    check("Real candles in training window",
          source_ok and candles >= v.n_samples and set(counts) == {v.data_source},
          f"{candles} candles from {', '.join(sorted(counts)) or 'no provider'}",
          f"all {v.n_samples}+ candles from {v.data_source}")

    wf = await db.scalar(select(ModelEvaluation)
                         .where(ModelEvaluation.version_id == v.id, ModelEvaluation.kind == "walk_forward")
                         .order_by(ModelEvaluation.created_at.desc(), ModelEvaluation.id.desc()).limit(1))
    recomputed: list[dict[str, Any]] = []
    if wf is None:
        check("Walk-forward gates on real data", False, "no validation record", "9 gates passed")
    else:
        try:
            recomputed = recheck_gates(wf.metrics, v.data_source)
        except (KeyError, TypeError, ValueError, ZeroDivisionError):
            recomputed = []
        # Expose each re-derived gate as its own check so the API error names exactly
        # which gates failed, rather than only a summary string.
        for g in recomputed:
            check(g["name"], g["passed"], g["value"], g["threshold"])
        failed = [g["name"] for g in recomputed if not g["passed"]]
        source_on_record = wf.metrics.get("data_source", v.data_source)
        check("Walk-forward gates on real data", bool(recomputed) and not failed
              and source_on_record == v.data_source and source_ok,
              ("all 9 passed" if recomputed and not failed else
               ("failed: " + ", ".join(failed) if failed else "no valid metrics")),
              "9 gates passed with the same real provider")
        stored = {str(g.get("name")): bool(g.get("passed")) for g in (wf.metrics.get("gates") or [])}
        derived = {g["name"]: g["passed"] for g in recomputed}
        agreement = bool(recomputed) and stored == derived and v.gates == wf.metrics.get("gates")
        check("Validation evidence consistent", agreement,
              f"{sum(1 for k in derived if stored.get(k) == derived[k])} of {len(derived)} gates agree",
              "stored gates match recomputed gates")

    check("Current eligibility", v.eligible is True, str(v.eligible).lower(),
          "true after all gates pass")

    await db.refresh(v, ["artifact"])
    check("Artifact signature", verify_artifact(v.artifact, v.artifact_hmac), "HMAC-SHA256",
          "signature valid")

    last_drift = await db.scalar(select(ModelEvaluation)
                                 .where(ModelEvaluation.version_id == v.id,
                                        ModelEvaluation.kind == "drift_check")
                                 .order_by(ModelEvaluation.created_at.desc(),
                                           ModelEvaluation.id.desc()).limit(1))
    check("No unresolved drift", last_drift is None or last_drift.status != "drift",
          "none" if last_drift is None else last_drift.status, "not drift")

    return PromotionDecision(ok=all(c.passed for c in checks), checks=checks)
