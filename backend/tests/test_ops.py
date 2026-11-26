"""Phase 12: shared rate limits, worker leadership, readiness, metrics, anchoring, integrity, gates."""

import hashlib
import hmac
import json

import httpx
import pytest
import redis as sync_redis

from app.core import rate_limit
from app.core.rate_limit import SlidingWindowLimiter
from app.core.redis import close_redis
from app.database.session import SessionLocal
from app.ops import anchoring, controls, worker
from app.ops.anchoring import verify_anchors
from tests.conftest import API, admin_headers, auth_headers
from tests.test_mfa import enrol
from tests.test_security import settings_env

REDIS_URL = "redis://localhost:6379/15"


def redis_available() -> bool:
    try:
        sync_redis.Redis.from_url(REDIS_URL, socket_connect_timeout=0.3).ping()
        return True
    except Exception:  # noqa: BLE001
        return False


needs_redis = pytest.mark.skipif(not redis_available(), reason="Redis not running")


@pytest.fixture
async def shared_redis(monkeypatch):
    sync_redis.Redis.from_url(REDIS_URL).flushdb()
    settings_env(monkeypatch, redis_url=REDIS_URL)
    yield
    await close_redis()


# -- shared rate limits ------------------------------------------------------------------------------
@needs_redis
async def test_limits_are_shared_between_replicas(shared_redis):
    replica_a, replica_b = SlidingWindowLimiter("orders"), SlidingWindowLimiter("orders")   # same name, two processes
    assert await replica_a.hit("user-1", 3, 60) and await replica_b.hit("user-1", 3, 60) and await replica_a.hit("user-1", 3, 60)
    assert not await replica_b.hit("user-1", 3, 60)
    assert await replica_b.count("user-1", 60) == 3
    assert await replica_a.hit("user-2", 3, 60)                 # keys are independent
    await replica_b.clear("user-1")
    assert await replica_a.hit("user-1", 3, 60)
    assert not replica_a._hits                                  # nothing kept in process


@needs_redis
async def test_global_limit_uses_redis(shared_redis, monkeypatch, client):
    settings_env(monkeypatch, redis_url=REDIS_URL, api_rate_limit_per_minute=3)
    # The autouse harness must clear the shared global counter between tests.
    assert not sync_redis.Redis.from_url(REDIS_URL).keys("aurex:rl:global:*")
    for _ in range(3):
        assert (await client.get(f"{API}/system/info")).status_code == 200
    assert (await client.get(f"{API}/system/info")).status_code == 429
    keys = sync_redis.Redis.from_url(REDIS_URL).keys("aurex:rl:global:*")
    assert len(keys) == 1


async def test_redis_outage_fails_open_and_is_counted(monkeypatch):
    settings_env(monkeypatch, redis_url="redis://localhost:1/0")       # nothing listens there
    before = rate_limit.backend_errors
    lim = SlidingWindowLimiter("outage")
    assert await lim.hit("k", 1, 60) and await lim.hit("k", 1, 60)    # open, not locked out
    assert rate_limit.backend_errors >= before + 2
    await close_redis()


# -- worker leadership and readiness -----------------------------------------------------------------
async def test_only_one_worker_is_leader():
    a, b = worker.Lease(), worker.Lease()
    try:
        assert await a.acquire() is True
        assert await b.acquire() is False
        assert await a.acquire() is True                     # renewing keeps it
        await a.release()
        assert await b.acquire() is True                     # failover
    finally:
        await a.release()
        await b.release()


async def test_scheduler_tick_skips_when_lease_is_held():
    holder = worker.Lease()
    try:
        assert await holder.acquire()
        assert await worker.run_once() is None
    finally:
        await holder.release()
    out = await worker.run_once()
    assert set(out) == {"matcher", "binary", "drift", "anchored"}
    async with SessionLocal() as db:
        hb = await controls.get(db, controls.HEARTBEAT)
    assert hb and hb["instance"] == worker.INSTANCE


async def test_external_scheduler_heartbeat_satisfies_readiness(monkeypatch, client):
    settings_env(monkeypatch, background_worker=False, external_scheduler=True)
    await worker.heartbeat()
    r = await client.get(f"{API}/system/ready")
    assert r.status_code == 200
    assert r.json()["checks"]["worker"] == "ok"
    assert r.json()["checks"]["scheduler"] == "external"


async def test_readiness_tracks_schema_and_worker(monkeypatch, client):
    r = await client.get(f"{API}/system/ready")
    assert r.status_code == 200 and r.json()["checks"]["schema"] == "ok"
    assert r.json()["checks"]["worker"] == "disabled in this process"
    assert r.json()["checks"]["redis"] in ("ok", "not configured")
    settings_env(monkeypatch, order_matcher_interval_seconds=5)
    assert (await client.get(f"{API}/system/ready")).json()["checks"]["worker"] == "starting"
    out = await worker.one_pass()
    await worker.heartbeat()
    assert set(out) == {"matcher", "binary", "drift", "anchored"}
    r = await client.get(f"{API}/system/ready")
    assert r.status_code == 200 and r.json()["checks"]["worker"] == "ok"


async def test_scheduled_drift_checks_are_due_guarded_and_audited(client, monkeypatch):
    """The scheduler checks due models, skips recent ones and never retrains/promotes."""
    from sqlalchemy import func, select

    from app.models import AuditLog, ModelEvaluation
    from tests.test_ml_api import TRAIN, force_eligible

    ah = await admin_headers(client)
    v = (await client.post(f"{API}/ml/train", headers=ah, json=TRAIN)).json()
    await force_eligible(v["id"])
    assert (await client.post(f"{API}/ml/versions/{v['id']}/promote", headers=ah)).status_code == 200

    out = await worker.one_pass()
    assert out["drift"]["checked"] == 1 and out["drift"]["errors"] == 0
    again = await worker.one_pass()
    assert again["drift"]["checked"] == 0 and again["drift"]["skipped"] == 1

    async with SessionLocal() as db:
        evs = (await db.scalars(select(ModelEvaluation).where(
            ModelEvaluation.version_id == v["id"], ModelEvaluation.kind == "drift_check"))).all()
        assert len(evs) == 1 and evs[0].created_by is None
        n = await db.scalar(select(func.count()).select_from(AuditLog).where(
            AuditLog.action == "ml.drift_check_scheduled"))
    assert n == 1
    assert (await client.get(f"{API}/ml/versions/{v['id']}", headers=ah)).json()["status"] == "champion"

    settings_env(monkeypatch, ml_drift_monitoring_enabled=False)
    assert (await worker.one_pass())["drift"]["enabled"] is False


async def test_scheduled_worker_revokes_stale_synthetic_eligibility(client):
    from sqlalchemy import func, select, text

    from app.models import AuditLog
    from tests.test_ml_api import TRAIN

    ah = await admin_headers(client)
    v = (await client.post(f"{API}/ml/train", headers=ah, json=TRAIN)).json()
    async with SessionLocal() as db:
        await db.execute(text("UPDATE model_versions SET eligible = true WHERE id = :id"), {"id": v["id"]})
        await db.commit()
    assert (await worker.one_pass())["drift"]["revoked"] == 1
    assert (await client.get(f"{API}/ml/versions/{v['id']}", headers=ah)).json()["eligible"] is False
    async with SessionLocal() as db:
        n = await db.scalar(select(func.count()).select_from(AuditLog).where(
            AuditLog.action == "ml.eligibility_revoked"))
    assert n == 1


# -- metrics ----------------------------------------------------------------------------------------------
async def test_metrics_endpoint_requires_its_token(monkeypatch, client):
    assert (await client.get("/metrics")).status_code == 404              # disabled without a token
    token = "m" * 40
    settings_env(monkeypatch, metrics_token=token)
    assert (await client.get("/metrics", headers={"Authorization": "Bearer wrong"})).status_code == 401
    h = await auth_headers(client)
    await client.get(f"{API}/trading/orders/00000000-0000-0000-0000-000000000000", headers=h)
    r = await client.get("/metrics", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/plain")
    body = r.text
    assert 'aurex_http_requests_total{method="GET",route="/trading/orders/{order_id}",status="404"}' in body
    for name in ("aurex_open_orders", "aurex_kill_switches_engaged", "aurex_platform_halted", "aurex_audit_records",
                 "aurex_worker_heartbeat_age_seconds", "aurex_last_backup_age_seconds", "aurex_http_request_duration_seconds_bucket"):
        assert name in body, name


# -- audit anchoring -------------------------------------------------------------------------------------
async def test_anchoring_to_file_and_verification(monkeypatch, tmp_path, client):
    ah = await admin_headers(client)
    assert (await client.post(f"{API}/admin/ops/anchor", headers=ah)).status_code == 422    # no sink yet
    sink = tmp_path / "anchors" / "aurex.jsonl"
    settings_env(monkeypatch, audit_anchor_file=str(sink))
    r = await client.post(f"{API}/admin/ops/anchor", headers=ah)
    assert r.status_code == 200 and r.json()["sinks"] == [{"sink": "file", "ok": True}]
    await auth_headers(client, email="later@example.com")                 # chain keeps growing
    await client.post(f"{API}/admin/ops/anchor", headers=ah)
    lines = sink.read_text().splitlines()
    assert len(lines) == 2 and json.loads(lines[0])["type"] == "aurex-audit-anchor/1"
    async with SessionLocal() as db:
        assert (await verify_anchors(db, lines))["valid"] is True
        forged = {**json.loads(lines[0]), "head_hash": "f" * 64}
        bad = await verify_anchors(db, [json.dumps(forged)])
        assert bad["valid"] is False and "rewritten" in bad["reason"]
        gone = {**json.loads(lines[0]), "last_record_id": 10**9}
        assert "truncated" in (await verify_anchors(db, [json.dumps(gone)]))["reason"]
    ok = (await client.post(f"{API}/admin/ops/integrity-check", headers=ah)).json()
    assert ok["ok"] is True and {c["name"] for c in ok["checks"]} >= {"audit_chain", "anchors_match_chain", "append_only_triggers"}


async def test_webhook_anchor_is_signed(monkeypatch):
    secret = "w" * 40
    settings_env(monkeypatch, audit_anchor_webhook_url="https://anchors.example/hook", audit_anchor_webhook_secret=secret)
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["sig"], seen["body"] = request.headers["x-aurex-signature"], request.content
        return httpx.Response(201)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http, SessionLocal() as db:
        a = await anchoring.anchor_now(db, http=http)
        await db.commit()
    assert a.sinks == [{"sink": "webhook", "ok": True, "status": 201}]
    assert seen["sig"] == "sha256=" + hmac.new(secret.encode(), seen["body"], hashlib.sha256).hexdigest()
    assert json.loads(seen["body"])["head_hash"] == a.head_hash


async def test_worker_anchors_on_its_interval(monkeypatch, tmp_path):
    settings_env(monkeypatch, audit_anchor_file=str(tmp_path / "a.jsonl"), audit_anchor_interval_seconds=3600)
    assert (await worker.one_pass())["anchored"] is True
    assert (await worker.one_pass())["anchored"] is False            # not due yet


# -- admin 2FA enforcement, status, gates -----------------------------------------------------------------
async def test_admins_must_have_2fa_when_required(monkeypatch, client):
    ah = await admin_headers(client)
    settings_env(monkeypatch, require_admin_mfa="true")
    r = await client.get(f"{API}/admin/users", headers=ah)
    assert r.status_code == 403 and r.json()["error"]["code"] == "mfa_required"
    await enrol(client, ah)
    assert (await client.get(f"{API}/admin/users", headers=ah)).status_code == 200


async def test_status_and_go_live_gates(monkeypatch, tmp_path, client):
    from app.cli import ops_record
    ah = await admin_headers(client)
    st = (await client.get(f"{API}/admin/ops/status", headers=ah)).json()
    assert st["live_trading_enabled"] is False and st["gates_total"] == 15
    gates = {g["key"]: g for g in st["gates"]}
    assert not gates["backups"]["ok"] and gates["backups"]["detail"] == "no backup recorded"
    assert not gates["offsite_backups"]["ok"] and not gates["offsite_anchors"]["ok"]
    assert gates["audit_chain"]["ok"] and not gates["pentest"]["ok"]

    assert await ops_record("backup", "/backups/aurex-2026.dump", "ab" * 32, 1234, True, "") == 0
    assert await ops_record("offsite-backup", "s3://aurex/aurex-2026.dump", "ab" * 32, 1234, True, "") == 0
    assert await ops_record("offsite-anchor", "s3://aurex/anchors.jsonl", "cd" * 32, 234, True, "") == 0
    assert await ops_record("restore-drill", "/backups/aurex-2026.dump", "ab" * 32, 1234, True, "7/7 checks") == 0
    evidence = {"evidence_sha256": "ab" * 32, "reviewed_at": "2026-11-25"}
    r = await client.post(f"{API}/admin/ops/attestations", headers=ah,
                          json={"gate": "pentest", "reference": "PT-2026-11 report", **evidence})
    assert r.status_code == 200, r.text
    assert (await client.post(f"{API}/admin/ops/attestations", headers=ah,
                              json={"gate": "live", "reference": "x" * 5, **evidence})).status_code == 422
    assert (await client.post(f"{API}/admin/ops/attestations", headers=ah,
                              json={"gate": "pentest", "reference": "PT-2026-11 report",
                                    "evidence_sha256": "short", "reviewed_at": "2026-11-25"})).status_code == 422
    gates = {g["key"]: g for g in (await client.get(f"{API}/admin/ops/status", headers=ah)).json()["gates"]}
    assert (gates["backups"]["ok"] and gates["offsite_backups"]["ok"] and gates["offsite_anchors"]["ok"]
            and gates["restore_drill"]["ok"] and gates["pentest"]["ok"])
    assert "PT-2026-11" in gates["pentest"]["detail"]
    uh = await auth_headers(client, email="plain@example.com")
    assert (await client.get(f"{API}/admin/ops/status", headers=uh)).status_code == 403
    async with SessionLocal() as db:
        assert (await controls.get(db, controls.LAST_BACKUP))["file"] == "aurex-2026.dump"   # path stripped
    audit = (await client.get(f"{API}/admin/audit?action=ops.backup", headers=ah)).json()
    assert audit["total"] == 1


def test_attestation_requires_evidence_identity_and_fresh_date():
    from datetime import UTC, datetime, timedelta

    from app.ops.status import attestation_problems

    today = datetime.now(UTC).date()
    assert attestation_problems(None) == ["not attested"]
    assert attestation_problems({"reference": "web link only"}) == ["missing or invalid evidence_sha256", "review date missing or invalid"]
    assert attestation_problems({"evidence_sha256": "ab" * 32, "reviewed_at": (today - timedelta(days=366)).isoformat()}) == ["review date missing or stale"]
    assert attestation_problems({"evidence_sha256": "ab" * 32, "reviewed_at": today.isoformat()}) == []


def test_unsigned_evidence_manifest_blocks_go_live():
    from app.cli import verify_evidence_manifest

    ok, problems = verify_evidence_manifest()
    assert not ok
    assert any("pentest: not signed off" in p for p in problems)
    assert any("solicitor: not signed off" in p for p in problems)
    assert any("dpia: not signed off" in p for p in problems)
    assert any("privacy_policy: not signed off" in p for p in problems)


def test_production_guards_for_ops_settings(monkeypatch):
    from pydantic import ValidationError

    from app.core.config import Settings
    base = dict(environment="production", jwt_secret="j" * 40, cookie_secure="true", cors_origins="https://aurex.example",
                database_url="postgresql+asyncpg://aurex:long-secret@db/aurex")  # pragma: allowlist secret
    settings_env(monkeypatch, **base)
    assert Settings().admin_mfa_required is True
    settings_env(monkeypatch, **base, metrics_token="short")
    with pytest.raises(ValidationError, match="METRICS_TOKEN"):
        Settings()
    settings_env(monkeypatch, **base, metrics_token="m" * 40, audit_anchor_webhook_url="https://a.example/h")
    with pytest.raises(ValidationError, match="WEBHOOK_SECRET"):
        Settings()
