"""Model registry: train → validate → (human) promote → monitor → (human) retire.

The AI never promotes or rewrites its own production model: promotion requires every
validation gate to pass and an administrator to act, and it is audited.
"""

import asyncio
import hashlib
import pickle  # noqa: S403  # nosec B403 - artifacts are produced by this service and HMAC-verified
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import BusinessRuleViolation, NotFound
from app.core.security import sign_artifact, verify_artifact
from app.market.service import MarketService, provider_for
from app.ml import drift
from app.ml.features import FEATURES, build_dataset, latest_features
from app.ml.models import ALGORITHMS, feature_importance, make_model
from app.ml.validation import brier, walk_forward
from app.models import Instrument, MarketCandle, MLModel, ModelEvaluation, ModelVersion, User

_model_cache: dict[uuid.UUID, Any] = {}


class ArtifactIntegrityError(Exception):
    pass


def clear_cache() -> None:
    _model_cache.clear()


class MLService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.market = MarketService(db)

    # -- data -------------------------------------------------------------------------
    async def history(self, inst: Instrument, days: int) -> tuple[list, list, list, list]:
        await self.market.backfill(inst, "1h", days)
        since = datetime.now(UTC) - timedelta(days=days)
        rows = list(await self.db.scalars(
            select(MarketCandle).where(MarketCandle.instrument_id == inst.id, MarketCandle.timeframe == "1h",
                                       MarketCandle.open_time >= since).order_by(MarketCandle.open_time)))
        return ([r.open_time for r in rows], [float(r.high) for r in rows], [float(r.low) for r in rows],
                [float(r.close) for r in rows])

    # -- training ---------------------------------------------------------------------
    async def train(self, user: User, symbol: str, algorithm: str, horizon: int, days: int) -> ModelVersion:
        if algorithm not in ALGORITHMS:
            raise BusinessRuleViolation(f"Unknown algorithm. Available: {', '.join(ALGORITHMS)}")
        inst = await self.market.get(symbol)
        times, highs, lows, closes = await self.history(inst, days)
        ds = build_dataset(times, highs, lows, closes, horizon)
        source = provider_for(inst).name
        try:
            wf = await asyncio.to_thread(walk_forward, ds, algorithm, inst.asset_class, data_source=source)
        except ValueError as e:
            raise BusinessRuleViolation(str(e)) from e

        def fit_final():
            m = make_model(algorithm)
            m.fit(ds.X, ds.y)
            return m

        final = await asyncio.to_thread(fit_final)
        artifact = pickle.dumps(final)
        spec = await self.db.scalar(select(MLModel).where(
            MLModel.symbol == inst.symbol, MLModel.timeframe == "1h", MLModel.horizon == horizon,
            MLModel.algorithm == algorithm))
        if spec is None:
            spec = MLModel(name=f"{inst.symbol} · {ALGORITHMS[algorithm].label} · {horizon}h",
                           symbol=inst.symbol, timeframe="1h", horizon=horizon, algorithm=algorithm)
            self.db.add(spec)
            await self.db.flush()
        last = await self.db.scalar(select(func.max(ModelVersion.version)).where(ModelVersion.model_id == spec.id))
        failed = [g["name"] for g in wf.gates if not g["passed"]]
        v = ModelVersion(
            model_id=spec.id, symbol=inst.symbol, timeframe="1h", version=(last or 0) + 1, status="candidate",
            eligible=wf.eligible,
            eligibility_note="All validation gates passed" if wf.eligible else "Failed: " + "; ".join(failed),
            gates=wf.gates,
            metrics={"oos": wf.oos, "baselines": wf.baselines, "folds": wf.folds, "calibration": wf.calibration,
                     "curves": wf.curves, "horizon": horizon},
            params=ALGORITHMS[algorithm].params, features=FEATURES,
            feature_importance=feature_importance(final, FEATURES), reference=drift.reference(ds.X),
            data_source=source, train_from=ds.times[0], train_to=ds.times[-1], n_samples=len(ds.y),
            artifact=artifact, artifact_sha256=hashlib.sha256(artifact).hexdigest(),
            artifact_hmac=sign_artifact(artifact), trained_by=user.id,
            trained_at=datetime.now(UTC))
        self.db.add(v)
        await self.db.flush()
        self.db.add(ModelEvaluation(version_id=v.id, kind="walk_forward",
                                    status="eligible" if wf.eligible else "ineligible",
                                    metrics={"oos": wf.oos, "gates": wf.gates,
                                             "baselines": wf.baselines, "folds": wf.folds,
                                             "calibration": wf.calibration, "data_source": source},
                                    created_by=user.id))
        await self.db.flush()
        return v

    # -- registry ---------------------------------------------------------------------
    async def get(self, version_id: uuid.UUID) -> ModelVersion:
        v = await self.db.get(ModelVersion, version_id)
        if v is None:
            raise NotFound("Model version not found")
        return v

    async def champion(self, symbol: str, timeframe: str = "1h") -> ModelVersion | None:
        return await self.db.scalar(select(ModelVersion).where(
            ModelVersion.symbol == symbol, ModelVersion.timeframe == timeframe, ModelVersion.status == "champion"))

    async def latest_drift(self, version_id: uuid.UUID) -> ModelEvaluation | None:
        return await self.db.scalar(select(ModelEvaluation).where(
            ModelEvaluation.version_id == version_id, ModelEvaluation.kind == "drift_check")
            .order_by(ModelEvaluation.created_at.desc()).limit(1))

    async def promote(self, admin: User, v: ModelVersion) -> ModelVersion | None:
        """Returns the previous champion (now retired), if any.

        Every gate is re-derived at promotion time. A stale `eligible = true` on a
        synthetic/non-tradable version is cleared rather than honoured.
        """
        from app.ml.promotion import evaluate_promotion
        from app.ml.validation import REAL_TRAINING_SOURCES

        if v.data_source not in REAL_TRAINING_SOURCES and v.eligible:
            v.eligible = False
            v.eligibility_note = "Synthetic or non-tradable training data cannot be promoted"
        decision = await evaluate_promotion(self.db, v)
        if not decision.ok:
            raise BusinessRuleViolation("Version is not eligible for promotion. " + decision.failed_names,
                                        details=decision.failed)
        previous = await self.champion(v.symbol, v.timeframe)
        now = datetime.now(UTC)
        if previous:
            previous.status, previous.retired_at = "retired", now
            await self.db.flush()   # free the one-champion-per-instrument slot first
        v.status, v.promoted_at, v.promoted_by = "champion", now, admin.id
        await self.db.flush()
        return previous

    async def retire(self, v: ModelVersion) -> None:
        if v.status == "retired":
            raise BusinessRuleViolation("Version is already retired")
        v.status, v.retired_at = "retired", datetime.now(UTC)
        await self.db.flush()

    # -- inference & monitoring ---------------------------------------------------------
    async def load(self, v: ModelVersion) -> Any:
        if v.id in _model_cache:
            return _model_cache[v.id]
        await self.db.refresh(v, ["artifact"])
        if hashlib.sha256(v.artifact).hexdigest() != v.artifact_sha256:
            raise ArtifactIntegrityError(f"Artifact hash mismatch for model version {v.id}")
        if not verify_artifact(v.artifact, v.artifact_hmac):
            # Never unpickle bytes whose origin we cannot prove: a database write alone must
            # not be enough to run code in the API process.
            raise ArtifactIntegrityError(f"Artifact signature missing or invalid for model version {v.id}")
        model = pickle.loads(v.artifact)  # noqa: S301  # nosec B301 - HMAC-verified above
        _model_cache[v.id] = model
        return model

    async def predict_latest(self, v: ModelVersion, times, highs, lows, closes) -> float | None:
        row = latest_features(times, highs, lows, closes)
        if row is None:
            return None
        model = await self.load(v)
        return float(model.predict_proba(row.reshape(1, -1))[0, 1])

    async def drift_check(self, user: User | None, v: ModelVersion, days: int = 30) -> ModelEvaluation:
        inst = await self.market.get(v.symbol)
        times, highs, lows, closes = await self.history(inst, days)
        horizon = int(v.metrics.get("horizon", 4))
        ds = build_dataset(times, highs, lows, closes, horizon)
        if len(ds.y) < 100:
            raise BusinessRuleViolation("Not enough recent data for a drift check")
        model = await self.load(v)
        p = model.predict_proba(ds.X)[:, 1]
        result = drift.assess(drift.psi(v.reference, ds.X), brier(p, ds.y), float(v.metrics["oos"]["brier"]))
        result["window_days"] = days
        result["samples"] = int(len(ds.y))
        ev = ModelEvaluation(version_id=v.id, kind="drift_check", status=result["status"], metrics=result,
                             created_by=user.id if user is not None else None)
        self.db.add(ev)
        if result["status"] == "drift" and v.eligible:
            v.eligible = False   # reduce trading eligibility; never auto-retrain or auto-promote
            v.eligibility_note = "Drift detected: " + "; ".join(result["reasons"])
        await self.db.flush()
        return ev


def summarise(v: ModelVersion) -> dict[str, Any]:
    o = v.metrics.get("oos", {})
    b = v.metrics.get("baselines", {})
    return {"auc": o.get("auc"), "brier": o.get("brier"), "brier_climatology": o.get("brier_climatology"),
            "net_return": o.get("strategy_net_return"), "sharpe": o.get("strategy_sharpe"),
            "buy_hold_return": b.get("buy_hold", {}).get("net_return"), "trades": o.get("strategy_trades")}


