"""Public soft-launch feedback and the admin review inbox."""

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import audit_context, require_admin
from app.core.errors import RateLimited
from app.core.rate_limit import SlidingWindowLimiter
from app.database.session import get_db
from app.models import Feedback
from app.schemas.common import ORMModel, Page
from app.services.audit_service import AuditService

router = APIRouter(tags=["feedback"])
limiter = SlidingWindowLimiter("feedback")


class FeedbackIn(BaseModel):
    category: Literal["bug", "idea", "data_issue", "other"]
    message: str = Field(min_length=10, max_length=2000)
    reply_email: EmailStr | None = None


class FeedbackRead(ORMModel):
    id: int
    created_at: datetime
    category: str
    message: str
    reply_email: str | None
    status: str


@router.post("/feedback", response_model=FeedbackRead, status_code=201)
async def submit_feedback(request: Request, data: FeedbackIn, db: AsyncSession = Depends(get_db)):
    """Rate-limited by IP; no account is required during the soft launch."""
    ip = request.client.host if request.client else "unknown"
    if not await limiter.hit(ip, 5, 3600):
        raise RateLimited("Feedback limit reached for this hour")
    row = Feedback(category=data.category, message=data.message.strip(),
                   reply_email=str(data.reply_email) if data.reply_email else None, status="new")
    db.add(row)
    await db.flush()
    await AuditService(db).record(audit_context(request), "feedback.submitted",
                                  resource_type="feedback", resource_id=row.id,
                                  details={"category": row.category})
    await db.commit()
    await db.refresh(row)
    return row


admin_router = APIRouter(prefix="/admin/feedback", tags=["feedback"],
                         dependencies=[Depends(require_admin)])


@admin_router.get("", response_model=Page[FeedbackRead])
async def list_feedback(limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
                        status: str | None = Query(None, max_length=16),
                        db: AsyncSession = Depends(get_db)):
    stmt = select(Feedback)
    if status:
        stmt = stmt.where(Feedback.status == status)
    total = await db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = await db.scalars(stmt.order_by(Feedback.created_at.desc()).limit(limit).offset(offset))
    return Page(items=list(rows), total=int(total or 0), limit=limit, offset=offset)


router.include_router(admin_router)
