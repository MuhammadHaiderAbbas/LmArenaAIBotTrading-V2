"""The background jobs: order matcher, breaker monitor, autopilot, model drift and anchoring.

Locally this runs as a loop inside the API. Deployed API replicas leave the loop off and an
external scheduler calls `one_pass()` through `python -m app.cli worker-once`. Both paths take
the same Postgres *session* advisory lock, so a scheduled tick can never double-run a pass that
an API replica is already doing. The lock is released when the session ends, including when a
scheduled process exits.
"""

import asyncio
import logging
import os
import socket
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.config import get_settings
from app.database.session import SessionLocal, engine
from app.ops import anchoring, controls

log = logging.getLogger("aurex.worker")
LEADER_LOCK = 0x41555258  # "AURX"
INSTANCE = f"{socket.gethostname()}:{os.getpid()}"


class Lease:
    def __init__(self) -> None:
        self.conn: AsyncConnection | None = None

    @property
    def held(self) -> bool:
        return self.conn is not None and not self.conn.closed

    async def acquire(self) -> bool:
        if self.held:
            try:
                await self.conn.execute(text("SELECT 1"))     # still alive? (lock lives with the session)
                return True
            except Exception:  # noqa: BLE001
                await self.release()
        conn = await engine.connect()
        got = await conn.scalar(text("SELECT pg_try_advisory_lock(:k)"), {"k": LEADER_LOCK})
        await conn.commit()
        if got:
            self.conn = conn
            log.info("background worker: %s is now the leader", INSTANCE)
            return True
        await conn.close()
        return False

    async def release(self) -> None:
        if self.conn is not None:
            try:
                await self.conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": LEADER_LOCK})
                await self.conn.close()
            except Exception:  # noqa: BLE001 - the connection may already be gone (lock released with it)
                log.debug("leader lease connection already closed")
            self.conn = None


lease = Lease()
state = {"passes": 0, "last_error": None, "leader": False}


async def ml_drift_pass(s) -> dict:
    """Check due champion/eligible models for drift. Never retrains or promotes.

    Each version is checked in its own transaction so one unavailable provider cannot
    abort the rest of the scheduler pass. A failed check is counted, not hidden.
    """
    from app.ml.service import MLService
    from app.ml.validation import REAL_TRAINING_SOURCES
    from app.models import ModelEvaluation, ModelVersion
    from app.services.audit_service import AuditContext, AuditService

    out = {"enabled": bool(s.ml_drift_monitoring_enabled), "checked": 0, "drift": 0,
           "warning": 0, "skipped": 0, "revoked": 0, "errors": 0}
    if not out["enabled"]:
        return out
    cutoff = datetime.now(UTC) - timedelta(seconds=s.ml_drift_check_interval_seconds)
    async with SessionLocal() as db:
        ids = list(await db.scalars(select(ModelVersion.id).where(
            or_(ModelVersion.status == "champion", ModelVersion.eligible.is_(True)))))
        last = {row[0]: row[1] for row in await db.execute(
            select(ModelEvaluation.version_id, func.max(ModelEvaluation.created_at))
            .where(ModelEvaluation.kind == "drift_check")
            .group_by(ModelEvaluation.version_id))}
    for version_id in ids:
        if version_id in last and last[version_id] > cutoff:
            out["skipped"] += 1
            continue
        async with SessionLocal() as db:
            try:
                v = await db.get(ModelVersion, version_id)
                if v is None:
                    continue
                if v.eligible and v.data_source not in REAL_TRAINING_SOURCES:
                    # Heal legacy rows whose cached flag outlived the real-data gate.
                    v.eligible = False
                    v.eligibility_note = "Synthetic or non-tradable training data cannot be promoted"
                    await AuditService(db).record(
                        AuditContext(), "ml.eligibility_revoked", resource_type="model_version", resource_id=v.id,
                        details={"reason": v.data_source, "via": "worker"})
                    await db.commit()
                    out["revoked"] += 1
                    continue
                ev = await MLService(db).drift_check(None, v, s.ml_drift_check_window_days)
                await AuditService(db).record(
                    AuditContext(), "ml.drift_check_scheduled", resource_type="model_version", resource_id=v.id,
                    details={"status": ev.status, "version": v.version,
                             "window_days": s.ml_drift_check_window_days, "via": "worker"})
                await db.commit()
                out["checked"] += 1
                if ev.status in ("drift", "warning"):
                    out[ev.status] += 1
            except Exception as e:  # noqa: BLE001 - one bad version must not stop matcher/anchoring
                await db.rollback()
                out["errors"] += 1
                log.warning("scheduled drift check failed for model version %s: %s", version_id, e)
    return out


async def one_pass() -> dict:
    """A single leader pass. Separated from the loop so it can be tested directly."""
    from app.binary.service import BinaryService
    from app.risk.autopilot import due_accounts, run_cycle
    from app.risk.service import RiskService
    from app.trading.service import TradingService

    s = get_settings()
    async with SessionLocal() as db:
        stats = await TradingService(db).process_open()
        await TradingService(db).monitor()
        await db.commit()
    async with SessionLocal() as db:
        binaries = await BinaryService(db).settle_due()
        await db.commit()
    async with SessionLocal() as db:
        for acct in await due_accounts(db, s.autopilot_interval_seconds):
            prof = await RiskService(db).profile(acct.id, lock=True)
            await run_cycle(db, acct, prof)
            await db.commit()
    drift = await ml_drift_pass(s)
    anchored = False
    if anchoring.sinks_configured():
        async with SessionLocal() as db:
            last = await anchoring.last_anchor(db)
            if last is None or (datetime.now(UTC) - last.created_at).total_seconds() >= s.audit_anchor_interval_seconds:
                await anchoring.anchor_now(db)
                await db.commit()
                anchored = True
    return {"matcher": stats, "binary": binaries, "drift": drift, "anchored": anchored}


async def heartbeat(error: str | None = None) -> None:
    async with SessionLocal() as db:
        await controls.put(db, controls.HEARTBEAT, {"at": datetime.now(UTC).isoformat(), "instance": INSTANCE,
                                                   "passes": state["passes"], "last_error": error})
        await db.commit()


async def run_once() -> dict | None:
    """One scheduler tick. Returns None if another instance already holds the lease."""
    if not await lease.acquire():
        log.info("scheduler tick skipped: another worker holds the lease")
        return None
    try:
        out = await one_pass()
        state["passes"] += 1
        state["last_error"] = None
        await heartbeat()
        log.info("scheduler pass: %s", out)
        return out
    except Exception as e:  # noqa: BLE001 - record the failure before the scheduler sees it
        state["last_error"] = e.__class__.__name__
        try:
            await heartbeat(state["last_error"])
        except Exception:  # noqa: BLE001 - database may be unavailable during a pause/restart
            log.warning("could not record failed scheduler heartbeat")
        raise
    finally:
        await lease.release()
        await engine.dispose()


async def run(interval: float) -> None:
    while True:
        await asyncio.sleep(interval)
        try:
            state["leader"] = await lease.acquire()
            if not state["leader"]:
                continue
            out = await one_pass()
            state["passes"] += 1
            state["last_error"] = None
            await heartbeat()
            if (out["matcher"]["filled"] or out["matcher"]["expired"] or out["anchored"]
                    or out["drift"]["drift"] or out["drift"]["errors"]):
                log.info("worker pass: %s", out)
        except asyncio.CancelledError:
            await lease.release()
            raise
        except Exception as e:  # noqa: BLE001 - the loop must survive transient failures
            state["last_error"] = e.__class__.__name__
            log.exception("background worker pass failed")
            try:
                await heartbeat(state["last_error"])
            except Exception:  # noqa: BLE001 - database unavailable; readiness will show the stale heartbeat
                log.warning("could not record worker heartbeat")
