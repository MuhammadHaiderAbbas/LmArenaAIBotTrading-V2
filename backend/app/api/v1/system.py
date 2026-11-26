from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app import __version__
from app.core.config import get_settings
from app.database.session import get_db

router = APIRouter(prefix="/system", tags=["system"])


@router.get("/health")
async def health(db: AsyncSession = Depends(get_db)):
    try:
        await db.execute(text("SELECT 1"))
        db_ok = True
    except Exception:  # noqa: BLE001
        db_ok = False
    body = {"status": "ok" if db_ok else "degraded", "database": "ok" if db_ok else "unavailable"}
    return JSONResponse(body, status_code=200 if db_ok else 503)


@router.get("/info")
async def info():
    s = get_settings()
    return {
        "name": s.app_name,
        "version": __version__,
        "environment": s.environment,
        "trading_mode": "PAPER",
        "live_trading_enabled": s.live_trading_enabled,
        "registration_open": s.allow_registration,
        "supported_currencies": s.supported_currencies,
    }


@router.get("/ready")
async def ready(db: AsyncSession = Depends(get_db)):
    """Readiness for load balancers and orchestrators: database, schema at head, Redis (if
    configured) and a fresh background-worker heartbeat. 503 until ready."""
    from app.ops.status import readiness

    ok, checks = await readiness(db)
    return JSONResponse({"status": "ready" if ok else "not_ready", "checks": checks}, status_code=200 if ok else 503)


@router.get("/status")
async def public_status(db: AsyncSession = Depends(get_db)):
    """Unauthenticated soft-launch status. Deliberately omits admin/ops detail and never
    reports live trading as available."""
    from app.ops.status import readiness

    ok, checks = await readiness(db)
    s = get_settings()
    return {
        "name": s.app_name,
        "version": __version__,
        "environment": s.environment,
        "phase": "soft_launch",
        "status": "operational" if ok else "degraded",
        "trading_mode": "PAPER",
        "live_trading_enabled": False,
        "checks": {key: checks.get(key) for key in ("database", "schema", "redis", "worker")},
        "announcements": [
            "Paper trading only — all balances are virtual and no real orders are placed.",
            "Market data may be delayed or simulated; never use AUREX for investment decisions.",
            "Send feedback from the Feedback page; it is reviewed during the soft launch.",
        ],
        "feedback_enabled": True,
        "legal_review_required_for": ["marketing", "data-provider", "privacy-disclosure"],
    }
