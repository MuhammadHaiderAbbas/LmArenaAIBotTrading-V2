"""Readiness (for load balancers) and the operational status / go-live gates (for admins)."""

import re
from datetime import UTC, date, datetime
from typing import Any

from redis.exceptions import RedisError
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app import __version__
from app.core.config import get_settings
from app.core.redis import get_redis
from app.models import Role, RoleName, User
from app.ops import anchoring, controls, worker
from app.ops.integrity import alembic_head
from app.services.audit_service import AuditService

ATTESTABLE = {
    "pentest": "External penetration test completed and findings resolved",
    "solicitor": "UK solicitor has reviewed the regulatory perimeter",
    "dpia": "GDPR DPIA approved and residual actions closed",
    "privacy_policy": "Privacy policy approved and published",
    "broker_sandbox": "Broker sandbox integration certified end to end",
}
DRILL_MAX_AGE_DAYS = 30
REVIEW_MAX_AGE_DAYS = 365  # annual re-review of external reports and policies


def attestation_problems(value: dict[str, Any] | None) -> list[str]:
    """A reference string alone is not evidence. Validate identity and review freshness."""
    if not value:
        return ["not attested"]
    problems = []
    digest = value.get("evidence_sha256")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        problems.append("missing or invalid evidence_sha256")
    try:
        reviewed = date.fromisoformat(str(value.get("reviewed_at")))
        age = (datetime.now(UTC).date() - reviewed).days
        if not 0 <= age <= REVIEW_MAX_AGE_DAYS:
            problems.append("review date missing or stale")
    except ValueError:
        problems.append("review date missing or invalid")
    return problems


def _hours(sec: float | None) -> float | None:
    return None if sec is None else round(sec / 3600, 2)


async def readiness(db: AsyncSession) -> tuple[bool, dict[str, Any]]:
    s = get_settings()
    checks: dict[str, Any] = {}
    try:
        await db.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception:  # noqa: BLE001
        return False, {"database": "unavailable"}
    current = await db.scalar(text("SELECT version_num FROM alembic_version"))
    checks["schema"] = "ok" if current == alembic_head() else f"behind ({current})"
    r = get_redis()
    if r is None:
        checks["redis"] = "not configured"
    else:
        try:
            await r.ping()
            checks["redis"] = "ok"
        except (RedisError, OSError):
            checks["redis"] = "unavailable"
    in_process = s.background_worker and s.order_matcher_interval_seconds > 0
    if in_process or s.external_scheduler:
        age = controls.age_seconds(await controls.get(db, controls.HEARTBEAT))
        # Scheduled ticks are minutes apart; in-process passes are seconds apart.
        limit = s.scheduler_heartbeat_max_age_seconds if s.external_scheduler and not in_process else max(
            60.0, s.order_matcher_interval_seconds * 6)
        checks["worker"] = "ok" if age is not None and age < limit else ("starting" if age is None else f"stale ({int(age)}s)")
        checks["scheduler"] = "external" if s.external_scheduler and not in_process else "in-process"
    else:
        checks["worker"] = "disabled in this process"
    ok = checks["schema"] == "ok" and checks["redis"] in ("ok", "not configured") and checks["worker"] in (
        "ok", "disabled in this process", "starting")
    return ok, checks


async def ops_status(db: AsyncSession) -> dict[str, Any]:
    s = get_settings()
    ready, checks = await readiness(db)
    hb = await controls.get(db, controls.HEARTBEAT)
    backup = await controls.get(db, controls.LAST_BACKUP)
    drill = await controls.get(db, controls.LAST_RESTORE_DRILL)
    offsite_backup = await controls.get(db, controls.LAST_OFFSITE_BACKUP)
    offsite_anchor = await controls.get(db, controls.LAST_OFFSITE_ANCHOR)
    last = await anchoring.last_anchor(db)
    backup_age = _hours(controls.age_seconds(backup))
    drill_age = _hours(controls.age_seconds(drill))
    offsite_backup_age = _hours(controls.age_seconds(offsite_backup))
    offsite_anchor_age = _hours(controls.age_seconds(offsite_anchor))
    anchor_age = _hours((datetime.now(UTC) - last.created_at).total_seconds()) if last else None
    chain = await AuditService(db).verify_chain()
    admins = list(await db.scalars(select(User).join(Role).where(Role.name == RoleName.ADMIN, User.is_active.is_(True))))
    admins_without_mfa = [a.email for a in admins if not a.mfa_enabled]
    attest = {k: await controls.get(db, controls.ATTEST_PREFIX + k) for k in ATTESTABLE}

    def gate(key: str, label: str, ok: bool, detail: str) -> dict[str, Any]:
        return {"key": key, "label": label, "ok": bool(ok), "detail": detail}

    gates = [
        gate("environment", "Running with production settings", s.environment == "production", f"environment = {s.environment}"),
        gate("admin_mfa", "Two-factor authentication enforced for every administrator",
             s.admin_mfa_required and not admins_without_mfa,
             ("enforced" if s.admin_mfa_required else "not enforced") + (f"; without 2FA: {', '.join(admins_without_mfa)}" if admins_without_mfa else "")),
        gate("backups", f"Database backup within {s.max_backup_age_hours:g} h", backup_age is not None and backup_age <= s.max_backup_age_hours,
             f"last backup {backup_age} h ago" if backup_age is not None else "no backup recorded"),
        gate("offsite_backups", f"Verified off-site backup within {s.max_offsite_age_hours:g} h",
             offsite_backup_age is not None and offsite_backup_age <= s.max_offsite_age_hours and bool(offsite_backup and offsite_backup.get("ok")),
             (f"last off-site copy {offsite_backup_age} h ago" if offsite_backup_age is not None else "never copied off-site")),
        gate("offsite_anchors", f"Verified off-site audit anchor within {s.max_offsite_age_hours:g} h",
             offsite_anchor_age is not None and offsite_anchor_age <= s.max_offsite_age_hours and bool(offsite_anchor and offsite_anchor.get("ok")),
             (f"last off-site anchor {offsite_anchor_age} h ago" if offsite_anchor_age is not None else "never copied off-site")),
        gate("restore_drill", f"Restore drill passed within {DRILL_MAX_AGE_DAYS} days",
             drill_age is not None and drill_age <= DRILL_MAX_AGE_DAYS * 24 and bool(drill and drill.get("ok")),
             f"last drill {drill_age} h ago ({'passed' if drill and drill.get('ok') else 'failed'})" if drill else "no drill recorded"),
        gate("anchoring", f"Audit head anchored externally within {s.max_anchor_age_hours:g} h",
             bool(anchoring.sinks_configured()) and anchor_age is not None and anchor_age <= s.max_anchor_age_hours,
             (f"sinks: {', '.join(anchoring.sinks_configured()) or 'none'}; last anchor {anchor_age} h ago" if last else
              f"sinks: {', '.join(anchoring.sinks_configured()) or 'none'}; never anchored")),
        gate("monitoring", "Metrics and alert delivery configured",
             bool(s.metrics_token) and bool(s.alertmanager_webhook_url),
             ("metrics token + Alertmanager webhook" if s.metrics_token and s.alertmanager_webhook_url else
              "AUREX_METRICS_TOKEN and AUREX_ALERTMANAGER_WEBHOOK_URL are both required")),
        gate("shared_limits", "Rate limits shared across replicas (Redis)", checks["redis"] == "ok", f"redis: {checks['redis']}"),
        gate("audit_chain", "Audit chain intact", chain["valid"], f"{chain['records_checked']} records verified"),
        *[gate(k, label, not attestation_problems(attest[k]),
               (f"reviewed {attest[k]['reviewed_at']} · evidence {attest[k]['evidence_sha256'][:12]}… · {attest[k]['reference']}"
                if not attestation_problems(attest[k]) else "; ".join(attestation_problems(attest[k]))))
          for k, label in ATTESTABLE.items()],
    ]
    return {
        "version": __version__, "environment": s.environment, "ready": ready, "checks": checks,
        "worker": {"leader_instance": (hb or {}).get("instance"), "heartbeat_age_seconds": controls.age_seconds(hb),
                   "passes": (hb or {}).get("passes"), "last_error": (hb or {}).get("last_error"),
                   "this_process": worker.INSTANCE, "this_process_is_leader": worker.lease.held},
        "backup": {**(backup or {}), "age_hours": backup_age}, "restore_drill": {**(drill or {}), "age_hours": drill_age},
        "offsite": {"backups": {**(offsite_backup or {}), "age_hours": offsite_backup_age},
                    "anchors": {**(offsite_anchor or {}), "age_hours": offsite_anchor_age}},
        "anchoring": {"sinks": anchoring.sinks_configured(), "last": None if last is None else {
            "at": last.created_at.isoformat(), "last_record_id": last.last_record_id, "head_hash": last.head_hash,
            "records": last.records, "sinks": last.sinks, "age_hours": anchor_age}},
        "gates": gates, "gates_met": sum(g["ok"] for g in gates), "gates_total": len(gates),
        # Stage 1 invariant: never true. Enabling live trading is a reviewed code change, not a setting.
        "live_trading_enabled": s.live_trading_enabled,
        "users": {"total": await db.scalar(select(func.count()).select_from(User)), "admins": len(admins)},
    }
