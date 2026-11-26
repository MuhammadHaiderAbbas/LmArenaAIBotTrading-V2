import os

os.environ.setdefault(
    "AUREX_DATABASE_URL", "postgresql+asyncpg://aurex:aurex@localhost:5432/aurex_test"
)
os.environ["AUREX_DATABASE_USE_NULL_POOL"] = "true"
os.environ["AUREX_ENVIRONMENT"] = "test"
os.environ["AUREX_ALLOW_REGISTRATION"] = "true"
os.environ["AUREX_ORDER_MATCHER_INTERVAL_SECONDS"] = "0"

# Exercise the real shared global limiter whenever a local Redis is available. CI sets
# AUREX_REDIS_URL explicitly; localhost is only a fallback so a developer's suite matches CI.
_TEST_REDIS_URL = "redis://localhost:6379/15"
if not os.environ.get("AUREX_REDIS_URL"):
    import redis as sync_redis  # noqa: E402

    try:
        sync_redis.Redis.from_url(_TEST_REDIS_URL, socket_connect_timeout=0.3).ping()
    except Exception:  # noqa: BLE001, S110 - no Redis locally: the in-process fallback is still tested
        pass
    else:
        os.environ["AUREX_REDIS_URL"] = _TEST_REDIS_URL

from pathlib import Path  # noqa: E402

import httpx  # noqa: E402
import pytest  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.api.v1 import ai as ai_api  # noqa: E402
from app.api.v1 import backtests as backtests_api  # noqa: E402
from app.api.v1 import feedback as feedback_api  # noqa: E402
from app.api.v1 import ml as ml_api  # noqa: E402
from app.api.v1 import research as research_api  # noqa: E402
from app.api.v1 import risk as risk_api  # noqa: E402
from app.api.v1 import trading as trading_api  # noqa: E402
from app.core.config import get_settings  # noqa: E402
from app.core.errors import Conflict  # noqa: E402
from app.core.middleware import reset_rate_limits  # noqa: E402
from app.core.rate_limit import login_limiter  # noqa: E402
from app.core.redis import close_redis, get_redis  # noqa: E402
from app.database.session import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.market import service as market_service  # noqa: E402
from app.ml import service as ml_service  # noqa: E402
from app.models import RoleName  # noqa: E402
from app.research import fetch as research_fetch  # noqa: E402
from app.research import llm as research_llm  # noqa: E402
from app.services import auth_service  # noqa: E402
from app.services.auth_service import AuthService  # noqa: E402

PASSWORD = "Correct-Horse-42"
BASE_URL = "http://aurex.test"
API = "/api/v1"


@pytest.fixture(scope="session", autouse=True)
def migrated_database():
    cfg = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    cfg.attributes["configure_logger"] = False
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")
    yield


@pytest.fixture(autouse=True)
async def clean_state():
    # A previous test may have monkeypatched settings to a dead Redis URL.
    get_settings.cache_clear()
    async with SessionLocal() as db:
        await db.execute(text(
            "TRUNCATE ledger_entries, ledger_transactions, ledger_accounts, trading_accounts, "
            "user_sessions, user_settings, audit_logs, market_candles, watchlist_items, "
            "watchlists, research_reports, research_chunks, research_documents, trade_proposals, ai_findings, "
            "ai_runs, model_evaluations, model_versions, ml_models, backtests, executions, order_events, orders, "
            "positions, portfolio_snapshots, risk_decisions, risk_events, risk_profiles, system_controls, audit_anchors, binary_contracts, "
            "feedback_submissions, users RESTART IDENTITY CASCADE"
        ))
        await db.commit()
    r = get_redis()
    if r is not None:                     # shared counters must not leak between tests
        # Includes aurex:rl:global:<ip>:<minute> from RateLimitMiddleware as well as the
        # sliding-window keys. Fail open if Redis went away mid-suite; the test below still
        # resets the in-process state.
        try:
            keys = [key async for key in r.scan_iter(match="aurex:rl:*", count=500)]
            if keys:
                await r.delete(*keys)
        except Exception:  # noqa: BLE001, S110 - cleanup must never mask the test failure
            pass
    login_limiter.reset()
    reset_rate_limits()
    auth_service.lockout_limiter.reset()
    auth_service.registration_limiter.reset()
    auth_service.mfa_limiter.reset()
    get_settings.cache_clear()
    market_service.clear_caches()
    market_service._providers.clear()
    research_api.ask_limiter.reset()
    ai_api.run_limiter.reset()
    ml_api.train_limiter.reset()
    backtests_api.bt_limiter.reset()
    trading_api.order_limiter.reset()
    risk_api.cycle_limiter.reset()
    feedback_api.limiter.reset()
    ml_service.clear_cache()
    research_llm.set_client(None)
    research_fetch.set_http_client(None)
    yield
    get_settings.cache_clear()
    await close_redis()


@pytest.fixture
async def client():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url=BASE_URL) as c:
        yield c


def new_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=BASE_URL)


async def register(client, email="trader@example.com", name="Test Trader", password=PASSWORD):
    return await client.post(f"{API}/auth/register",
                             json={"email": email, "full_name": name, "password": password})


async def login(client, email="trader@example.com", password=PASSWORD):
    return await client.post(f"{API}/auth/login", json={"email": email, "password": password})


async def auth_headers(client, email="trader@example.com") -> dict:
    r = await register(client, email=email)
    assert r.status_code == 201, r.text
    r = await login(client, email=email)
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def admin_headers(client, email="admin@example.com") -> dict:
    async with SessionLocal() as db:
        try:
            await AuthService(db).create_user(email, "Admin", PASSWORD, RoleName.ADMIN)
            await db.commit()
        except Conflict:   # already created earlier in this test
            await db.rollback()
    r = await login(client, email=email)
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture(autouse=True)
async def reset_agent_config():
    yield
    async with SessionLocal() as db:
        await db.execute(text("UPDATE ai_agents SET enabled = true"))
        await db.execute(text(
            "UPDATE ai_agents SET weight = CASE name WHEN 'technical' THEN 0.35 WHEN 'quant' THEN 0.25 "
            "WHEN 'fundamental' THEN 0.15 WHEN 'news' THEN 0.15 WHEN 'sentiment' THEN 0.10 ELSE 0 END"))
        await db.commit()
