import uuid

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user, get_audit_context, require_admin
from app.core.errors import BusinessRuleViolation, NotFound, RateLimited
from app.core.rate_limit import SlidingWindowLimiter
from app.database.session import get_db
from app.ml.models import ALGORITHMS
from app.ml.service import MLService, summarise
from app.models import MLModel, ModelEvaluation, ModelVersion, User
from app.schemas.ml import (
    AlgorithmRead,
    EvaluationRead,
    ModelRead,
    TrainRequest,
    VersionDetail,
    VersionSummary,
)
from app.services.audit_service import AuditContext, AuditService

router = APIRouter(prefix="/ml", tags=["ml"])
train_limiter = SlidingWindowLimiter("ml_train")
TRAININGS_PER_HOUR = 20


def _summary(v: ModelVersion) -> VersionSummary:
    return VersionSummary.model_validate({**{k: getattr(v, k) for k in VersionSummary.model_fields
                                              if k != "summary"}, "summary": summarise(v)})


async def _detail(db: AsyncSession, v: ModelVersion) -> VersionDetail:
    evs = await db.scalars(select(ModelEvaluation).where(ModelEvaluation.version_id == v.id)
                           .order_by(ModelEvaluation.created_at.desc()))
    m = await db.get(MLModel, v.model_id)
    return VersionDetail.model_validate({
        **_summary(v).model_dump(), "gates": v.gates, "metrics": v.metrics, "params": v.params,
        "features": v.features, "feature_importance": v.feature_importance, "train_from": v.train_from,
        "train_to": v.train_to, "artifact_sha256": v.artifact_sha256,
        "model": {"name": m.name, "algorithm": m.algorithm, "horizon": m.horizon, "timeframe": m.timeframe},
        "evaluations": [EvaluationRead.model_validate(e) for e in evs]})


@router.get("/algorithms", response_model=list[AlgorithmRead])
async def algorithms(_: User = Depends(current_user)):
    return [AlgorithmRead(key=a.key, label=a.label, description=a.description, params=a.params)
            for a in ALGORITHMS.values()]


@router.get("/models", response_model=list[ModelRead])
async def list_models(symbol: str | None = Query(None, max_length=32), _: User = Depends(current_user),
                      db: AsyncSession = Depends(get_db)):
    stmt = select(MLModel).order_by(MLModel.symbol, MLModel.created_at)
    if symbol:
        stmt = stmt.where(MLModel.symbol == symbol)
    models = list(await db.scalars(stmt))
    out = []
    for m in models:
        vs = await db.scalars(select(ModelVersion).where(ModelVersion.model_id == m.id)
                              .order_by(ModelVersion.version.desc()))
        out.append(ModelRead(id=m.id, name=m.name, symbol=m.symbol, timeframe=m.timeframe, horizon=m.horizon,
                             algorithm=m.algorithm, created_at=m.created_at,
                             versions=[_summary(v) for v in vs]))
    return out


@router.post("/train", response_model=VersionDetail, status_code=status.HTTP_201_CREATED)
async def train(data: TrainRequest, admin: User = Depends(require_admin),
                ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    """Train a candidate with purged walk-forward validation. Never promotes automatically."""
    if not await train_limiter.hit(str(admin.id), TRAININGS_PER_HOUR, 3600):
        raise RateLimited("Training limit reached for this hour")
    v = await MLService(db).train(admin, data.symbol, data.algorithm, data.horizon, data.days)
    await AuditService(db).record(ctx, "ml.train", resource_type="model_version", resource_id=v.id,
                                  details={"symbol": v.symbol, "algorithm": data.algorithm, "version": v.version,
                                           "eligible": v.eligible, "data_source": v.data_source})
    await db.commit()
    return await _detail(db, v)


@router.get("/versions/{version_id}", response_model=VersionDetail)
async def get_version(version_id: uuid.UUID, _: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    return await _detail(db, await MLService(db).get(version_id))


@router.post("/versions/{version_id}/promote", response_model=VersionDetail)
async def promote(version_id: uuid.UUID, admin: User = Depends(require_admin),
                  ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    svc = MLService(db)
    v = await svc.get(version_id)
    try:
        previous = await svc.promote(admin, v)
    except BusinessRuleViolation as e:
        # Failed promotion attempts are audited too: an operator must not be able to
        # silently probe or override the gates without a record.
        await AuditService(db).record(ctx, "ml.promote", resource_type="model_version", resource_id=v.id,
                                      outcome="failure", details={"version": v.version, "reasons": e.details})
        await db.commit()
        raise
    await AuditService(db).record(ctx, "ml.promote", resource_type="model_version", resource_id=v.id,
                                  details={"symbol": v.symbol, "version": v.version,
                                           "retired": str(previous.id) if previous else None})
    await db.commit()
    return await _detail(db, v)


@router.post("/versions/{version_id}/retire", response_model=VersionDetail)
async def retire(version_id: uuid.UUID, _: User = Depends(require_admin),
                 ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    svc = MLService(db)
    v = await svc.get(version_id)
    await svc.retire(v)
    await AuditService(db).record(ctx, "ml.retire", resource_type="model_version", resource_id=v.id)
    await db.commit()
    return await _detail(db, v)


@router.post("/versions/{version_id}/drift-check", response_model=EvaluationRead, status_code=status.HTTP_201_CREATED)
async def drift_check(version_id: uuid.UUID, days: int = Query(30, ge=14, le=120),
                      admin: User = Depends(require_admin), ctx: AuditContext = Depends(get_audit_context),
                      db: AsyncSession = Depends(get_db)):
    svc = MLService(db)
    v = await svc.get(version_id)
    ev = await svc.drift_check(admin, v, days)
    await AuditService(db).record(ctx, "ml.drift_check", resource_type="model_version", resource_id=v.id,
                                  details={"status": ev.status, "eligible_after": v.eligible})
    await db.commit()
    return ev


@router.get("/champion", response_model=VersionSummary)
async def champion(symbol: str = Query(max_length=32), _: User = Depends(current_user),
                   db: AsyncSession = Depends(get_db)):
    v = await MLService(db).champion(symbol)
    if v is None:
        raise NotFound(f"No champion model for {symbol}")
    return _summary(v)
