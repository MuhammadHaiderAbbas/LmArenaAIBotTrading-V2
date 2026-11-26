import pytest
from pydantic import ValidationError

from app.core.config import Settings


def test_list_settings_accept_csv_and_json(monkeypatch):
    monkeypatch.setenv("AUREX_CORS_ORIGINS", "http://localhost:8080, https://aurex.example")
    assert Settings().cors_origins == ["http://localhost:8080", "https://aurex.example"]
    monkeypatch.setenv("AUREX_CORS_ORIGINS", '["http://a.example"]')
    assert Settings().cors_origins == ["http://a.example"]


def test_production_requires_strong_secret_and_secure_cookies(monkeypatch):
    monkeypatch.setenv("AUREX_ENVIRONMENT", "production")
    with pytest.raises(ValidationError, match="JWT_SECRET"):
        Settings()
    monkeypatch.setenv("AUREX_JWT_SECRET", "x" * 48)
    with pytest.raises(ValidationError, match="COOKIE_SECURE"):
        Settings()
    monkeypatch.setenv("AUREX_COOKIE_SECURE", "true")
    with pytest.raises(ValidationError, match="explicit https:// origins"):
        Settings()                                         # default localhost origin
    monkeypatch.setenv("AUREX_CORS_ORIGINS", "*")
    with pytest.raises(ValidationError, match="explicit https:// origins"):
        Settings()
    monkeypatch.setenv("AUREX_CORS_ORIGINS", "https://aurex.example")
    with pytest.raises(ValidationError, match="default development password"):
        Settings()
    monkeypatch.setenv("AUREX_DATABASE_URL", "postgresql+asyncpg://aurex:s3cr3t-long@db:5432/aurex")
    monkeypatch.setenv("AUREX_JWT_PREVIOUS_SECRETS", "short")
    with pytest.raises(ValidationError, match="PREVIOUS_SECRETS"):
        Settings()
    monkeypatch.setenv("AUREX_JWT_PREVIOUS_SECRETS", "y" * 40)
    s = Settings()
    assert s.live_trading_enabled is False and s.docs_enabled is False and s.hsts_enabled is True


def test_live_trading_cannot_be_enabled_by_configuration(monkeypatch):
    monkeypatch.setenv("AUREX_LIVE_TRADING_ENABLED", "true")
    with pytest.raises(ValidationError, match="Live trading is disabled"):
        Settings()
    monkeypatch.setenv("AUREX_LIVE_TRADING_ENABLED", "false")
    assert Settings().live_trading_enabled is False


def test_production_rejects_disabling_admin_mfa(monkeypatch):
    env = {
        "AUREX_ENVIRONMENT": "production", "AUREX_JWT_SECRET": "x" * 48,
        "AUREX_COOKIE_SECURE": "true", "AUREX_CORS_ORIGINS": "https://aurex.example",
        "AUREX_DATABASE_URL": "postgresql+asyncpg://aurex:s3cr3t-long@db:5432/aurex",
        "AUREX_REQUIRE_ADMIN_MFA": "false",
    }
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    with pytest.raises(ValidationError, match="REQUIRE_ADMIN_MFA"):
        Settings()


def test_secrets_can_come_from_files(monkeypatch, tmp_path):
    f = tmp_path / "jwt"
    f.write_text("z" * 40 + "\n")
    monkeypatch.setenv("AUREX_JWT_SECRET_FILE", str(f))
    assert Settings().jwt_secret == "z" * 40
    assert Settings().docs_enabled is True     # development default


def test_previous_jwt_secrets_and_urls_from_files(monkeypatch, tmp_path):
    prev = tmp_path / "prev"
    prev.write_text("a" * 40 + "\n\n" + "b" * 40 + "\n")
    url = tmp_path / "db"
    url.write_text("postgresql+asyncpg://u:p@db:5432/aurex\n")
    monkeypatch.setenv("AUREX_JWT_PREVIOUS_SECRETS_FILE", str(prev))
    monkeypatch.setenv("AUREX_DATABASE_URL_FILE", str(url))
    s = Settings()
    assert s.jwt_previous_secrets == ["a" * 40, "b" * 40] and s.database_url.endswith("@db:5432/aurex")
