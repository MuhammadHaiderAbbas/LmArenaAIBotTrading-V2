"""Prometheus metrics. HTTP metrics are recorded by the request middleware; business and
operational gauges are computed from the database at scrape time."""

import hmac
import time

from fastapi import Request
from fastapi.responses import PlainTextResponse, Response
from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, Counter, Gauge, Histogram, generate_latest
from sqlalchemy import func, select, text

from app import __version__
from app.core import rate_limit
from app.core.config import get_settings
from app.database.session import SessionLocal
from app.models import AuditLog, Order, Position, RiskDecision, RiskProfile, TradingAccount
from app.ops import anchoring, controls, worker

registry = CollectorRegistry()
REQUESTS = Counter("aurex_http_requests_total", "HTTP requests", ["method", "route", "status"], registry=registry)
LATENCY = Histogram("aurex_http_request_duration_seconds", "HTTP request latency", ["method", "route"], registry=registry,
                    buckets=(0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10))
G = {name: Gauge(f"aurex_{name}", doc, registry=registry) for name, doc in {
    "build_info": "Constant 1; labels are in aurex_version",
    "accounts": "Trading accounts",
    "open_orders": "Orders waiting to fill",
    "open_positions": "Open positions",
    "kill_switches_engaged": "Accounts with the kill switch engaged",
    "drawdown_breakers_tripped": "Accounts with a tripped drawdown breaker",
    "autopilots_running": "Accounts with a running autopilot",
    "platform_halted": "1 if platform trading is halted",
    "risk_rejections_last_hour": "Risk-gate rejections in the last hour",
    "audit_records": "Records in the audit chain",
    "worker_heartbeat_age_seconds": "Seconds since the background worker leader last completed a pass",
    "worker_is_leader": "1 if this process holds the worker lease",
    "last_backup_age_seconds": "Seconds since the last recorded backup",
    "last_offsite_backup_age_seconds": "Seconds since the last verified off-site backup copy",
    "last_offsite_anchor_age_seconds": "Seconds since the last verified off-site anchor copy",
    "last_restore_drill_age_seconds": "Seconds since the last successful restore drill",
    "last_anchor_age_seconds": "Seconds since the audit head was last anchored externally",
    "rate_limit_backend_errors": "Rate-limit backend (Redis) errors since start (limits failed open)",
}.items()}
VERSION = Gauge("aurex_version", "Build version", ["version"], registry=registry)


def observe(request: Request, status: int, elapsed: float) -> None:
    route = request.scope.get("route")
    path = getattr(route, "path", None) or "unmatched"
    REQUESTS.labels(request.method, path, str(status)).inc()
    LATENCY.labels(request.method, path).observe(elapsed)


async def collect() -> None:
    async with SessionLocal() as db:
        n = lambda stmt: db.scalar(stmt)  # noqa: E731
        G["accounts"].set(await n(select(func.count()).select_from(TradingAccount)) or 0)
        G["open_orders"].set(await n(select(func.count()).select_from(Order).where(Order.status == "OPEN")) or 0)
        G["open_positions"].set(await n(select(func.count()).select_from(Position).where(Position.status == "OPEN")) or 0)
        G["kill_switches_engaged"].set(await n(select(func.count()).select_from(RiskProfile).where(RiskProfile.kill_switch.is_(True))) or 0)
        G["drawdown_breakers_tripped"].set(await n(select(func.count()).select_from(RiskProfile).where(RiskProfile.drawdown_halted.is_(True))) or 0)
        G["autopilots_running"].set(await n(select(func.count()).select_from(RiskProfile).where(RiskProfile.autopilot_status == "RUNNING")) or 0)
        halt = await controls.get(db, "trading_halt")
        G["platform_halted"].set(1 if halt and halt.get("halted") else 0)
        G["risk_rejections_last_hour"].set(await n(select(func.count()).select_from(RiskDecision).where(
            RiskDecision.approved.is_(False), RiskDecision.created_at >= text("now() - interval '1 hour'"))) or 0)
        G["audit_records"].set(await n(select(func.count()).select_from(AuditLog)) or 0)
        for gauge, key in (("worker_heartbeat_age_seconds", controls.HEARTBEAT), ("last_backup_age_seconds", controls.LAST_BACKUP),
                           ("last_offsite_backup_age_seconds", controls.LAST_OFFSITE_BACKUP),
                           ("last_offsite_anchor_age_seconds", controls.LAST_OFFSITE_ANCHOR),
                           ("last_restore_drill_age_seconds", controls.LAST_RESTORE_DRILL)):
            age = controls.age_seconds(await controls.get(db, key))
            G[gauge].set(age if age is not None else float("nan"))
        last = await anchoring.last_anchor(db)
        G["last_anchor_age_seconds"].set(time.time() - last.created_at.timestamp() if last else float("nan"))
    G["worker_is_leader"].set(1 if worker.lease.held else 0)
    G["rate_limit_backend_errors"].set(rate_limit.backend_errors)
    G["build_info"].set(1)
    VERSION.labels(__version__).set(1)


async def endpoint(request: Request) -> Response:
    token = get_settings().metrics_token
    if not token:
        return PlainTextResponse("Not Found", status_code=404)
    given = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not hmac.compare_digest(given.encode(), token.encode()):
        return PlainTextResponse("Unauthorized", status_code=401, headers={"WWW-Authenticate": "Bearer"})
    await collect()
    return Response(generate_latest(registry), media_type=CONTENT_TYPE_LATEST)
