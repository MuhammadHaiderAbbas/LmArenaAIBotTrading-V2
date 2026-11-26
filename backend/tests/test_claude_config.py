"""Phase 6: server-side Claude credential configuration (never exposed)."""

from app.research import llm as research_llm
from tests.conftest import API, auth_headers
from tests.test_security import settings_env


def test_server_key_is_passed_to_sdk_and_status_hides_value(monkeypatch):
    captured = {}

    def fake_client(**kwargs):
        captured.update(kwargs)
        return object()

    monkeypatch.setattr(research_llm.anthropic, "AsyncAnthropic", fake_client)
    research_llm.set_client(None)
    settings_env(monkeypatch, claude_api_key="server-secret-value", llm_timeout_seconds="9")
    client = research_llm._get_client()
    assert client is not None
    assert captured == {"timeout": 9.0, "api_key": "server-secret-value"}

    status = research_llm.credential_status()
    assert status["configured"] is True and status["source"] == "server_setting"
    assert "server-secret-value" not in str(status)
    research_llm.set_client(None)


def test_environment_and_missing_credentials_are_reported(monkeypatch):
    research_llm.set_client(None)
    monkeypatch.delenv("AUREX_CLAUDE_API_KEY", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "env-secret")
    assert research_llm.credential_status()["source"] == "environment"
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    status = research_llm.credential_status()
    assert status == {"configured": False, "source": "none", "model": None}


async def test_research_status_reports_key_source(monkeypatch, client):
    h = await auth_headers(client)
    before = (await client.get(f"{API}/research/status", headers=h)).json()
    assert "llm_key_configured" in before and "llm_key_source" in before
    settings_env(monkeypatch, claude_api_key="another-secret", research_engine="claude")
    after = (await client.get(f"{API}/research/status", headers=h)).json()
    assert after["llm_key_configured"] is True and after["llm_key_source"] == "server_setting"
    assert "another-secret" not in str(after)
