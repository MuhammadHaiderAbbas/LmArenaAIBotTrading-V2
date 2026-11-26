"""Operations API for administrators: status and go-live gates, anchoring, integrity, attestations."""

from datetime import UTC, date, datetime
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user, get_audit_context, require_admin
from app.core.errors import BusinessRuleViolation
from app.database.session import get_db
from app.models import User
from app.ops import anchoring, controls
from app.ops.integrity import run_checks
from app.ops.status import ATTESTABLE, ops_status
from app.services.audit_service import AuditContext, AuditService

router = APIRouter(prefix="/admin/ops", tags=["operations"], dependencies=[Depends(require_admin)])


class Attestation(BaseModel):
    gate: Literal["pentest", "solicitor", "dpia", "privacy_policy", "broker_sandbox"]
    reference: str = Field(min_length=3, max_length=300)   # report id / ticket / document link
    evidence_sha256: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")
    reviewed_at: date                                      # date the reviewer signed off


@router.get("/status")
async def status(db: AsyncSession = Depends(get_db)):
    return await ops_status(db)


@router.post("/anchor")
async def anchor(user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    """Anchor the audit head now (the background worker also does this on its interval)."""
    if not anchoring.sinks_configured():
        raise BusinessRuleViolation("No anchor sink configured (AUREX_AUDIT_ANCHOR_FILE or AUREX_AUDIT_ANCHOR_WEBHOOK_URL)")
    a = await anchoring.anchor_now(db, actor=user.id)
    await db.commit()
    return {"at": a.created_at.isoformat(), "last_record_id": a.last_record_id, "head_hash": a.head_hash, "sinks": a.sinks}


@router.post("/integrity-check")
async def integrity(ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    checks = await run_checks(db)
    ok = all(c["ok"] for c in checks)
    await AuditService(db).record(ctx, "ops.integrity_check", outcome="success" if ok else "failure",
                                  details={"failed": [c["name"] for c in checks if not c["ok"]]})
    await db.commit()
    return {"ok": ok, "checks": checks}


@router.post("/attestations")
async def attest(data: Attestation, user: User = Depends(current_user), ctx: AuditContext = Depends(get_audit_context),
                 db: AsyncSession = Depends(get_db)):
    """Record a manual go-live attestation (who, when, which report). Audited; cannot be edited, only superseded."""
    value = {"at": datetime.now(UTC).isoformat(), "by": user.email, "reference": data.reference,
             "evidence_sha256": data.evidence_sha256, "reviewed_at": data.reviewed_at.isoformat(),
             "label": ATTESTABLE[data.gate]}
    await controls.put(db, controls.ATTEST_PREFIX + data.gate, value, actor=user.id)
    await AuditService(db).record(ctx, "ops.attestation", resource_type="gate", resource_id=data.gate, details=value)
    await db.commit()
    return value
