import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

_DEV_SECRET = "dev-insecure-change-me-dev-insecure-change-me"  # noqa: S105  # nosec B105 - rejected outside development


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="AUREX_", env_file=".env", extra="ignore")

    app_name: str = "AUREX AI"
    environment: Literal["development", "test", "staging", "production"] = "development"
    api_prefix: str = "/api/v1"

    database_url: str = "postgresql+asyncpg://aurex:aurex@localhost:5432/aurex"
    database_url_file: str | None = None
    database_echo: bool = False
    # NullPool is used in tests so connections never outlive an event loop.
    database_use_null_pool: bool = False

    jwt_secret: str = _DEV_SECRET
    # Read the secret from a file (Docker/Kubernetes secrets) instead of the environment.
    jwt_secret_file: str | None = None
    # Rotation: tokens signed with these older secrets still verify until they expire.
    jwt_previous_secrets: Annotated[list[str], NoDecode] = Field(default_factory=list)
    jwt_previous_secrets_file: str | None = None        # one secret per line
    jwt_algorithm: str = "HS256"
    # HMAC key for ML model artifacts. Defaults to a key derived from jwt_secret.
    artifact_key: str | None = None
    artifact_key_file: str | None = None
    # Key for encrypting secrets at rest (TOTP seeds). Defaults to a key derived from jwt_secret.
    data_key: str | None = None
    data_key_file: str | None = None
    access_token_ttl_minutes: int = 15
    refresh_token_ttl_days: int = 7
    refresh_cookie_name: str = "aurex_refresh"
    cookie_secure: bool = False

    allow_registration: bool = True
    # NoDecode: accept plain comma-separated env values instead of requiring JSON.
    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=lambda: ["http://localhost:5173"])

    login_rate_limit_attempts: int = 5
    login_rate_limit_window_seconds: int = 60
    # Account lockout: failed logins for one email from any IP within the window.
    login_lockout_failures: int = 20
    login_lockout_window_seconds: int = 900
    registrations_per_ip_per_hour: int = 10

    # Transport-level limits (0 disables the rate limit).
    api_rate_limit_per_minute: int = 600
    max_request_bytes: int = 1_048_576          # JSON bodies
    max_upload_bytes: int = 11 * 1_048_576      # research document upload
    # OpenAPI/Swagger UI. None = on in development/test, off in staging/production.
    expose_api_docs: bool | None = None

    # -- Production operations (Phase 12) --------------------------------------------------
    # Shared state for rate limits across API replicas. Empty = in-process (single node).
    redis_url: str | None = None
    redis_url_file: str | None = None
    # Bearer token required to scrape /metrics (empty = metrics endpoint disabled).
    metrics_token: str | None = None
    metrics_token_file: str | None = None
    # Alert delivery: Prometheus rules are always provisioned; a webhook receiver must be
    # configured for the monitoring go-live gate to pass.
    alertmanager_webhook_url: str | None = None
    # Admins must have two-factor authentication to use admin endpoints. None = on outside
    # development/test.
    require_admin_mfa: bool | None = None
    # Run the background worker (matcher, monitor, autopilot, anchoring) in this process.
    # Default keeps local development simple; deployed API replicas should turn this off and
    # let the external scheduler call `python -m app.cli worker-once`.
    background_worker: bool = True
    # An external scheduler writes the same worker heartbeat to system_controls. Readiness then
    # treats a fresh heartbeat as evidence that the scheduled jobs are running.
    external_scheduler: bool = False
    scheduler_heartbeat_max_age_seconds: float = 900.0
    # Audit anchoring: write the head of the hash chain outside the database.
    audit_anchor_file: str | None = None                # append-only JSONL, e.g. on a separate volume
    audit_anchor_webhook_url: str | None = None         # POSTed JSON, HMAC-signed
    audit_anchor_webhook_secret: str | None = None
    audit_anchor_interval_seconds: float = 3600.0
    # Scheduled model monitoring: every champion and still-eligible candidate is checked
    # for feature/calibration drift at most once per interval. Checks never retrain or promote.
    ml_drift_monitoring_enabled: bool = True
    ml_drift_check_interval_seconds: float = 21600.0
    ml_drift_check_window_days: int = 30
    # Readiness thresholds used by /system/ready and the go-live gates.
    max_backup_age_hours: float = 26.0
    max_anchor_age_hours: float = 2.0
    # Off-site copies lag the local backup/anchor by one scheduler cycle at most.
    max_offsite_age_hours: float = 30.0

    # Paper-trading guard rails (Stage 1: virtual capital only).
    default_starting_balance: str = "100000"
    # Smallest entry order, in the account's currency (fractional-share brokers use about 1).
    min_order_value: str = "1"
    max_starting_balance: str = "10000000"
    max_paper_accounts_per_user: int = 10
    supported_currencies: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["USD", "GBP", "EUR"]
    )

    # Market data. "synthetic" works offline and is the default; "live" routes crypto
    # to Coinbase, stocks/ETFs to licensed Finnhub, and FX to OANDA (ECB reference only
    # as a labelled fallback). See docs/architecture/market-data.md.
    market_data_mode: Literal["synthetic", "live"] = "synthetic"
    coinbase_base_url: str = "https://api.exchange.coinbase.com"
    frankfurter_base_url: str = "https://api.frankfurter.dev/v1"
    # Phase 5: licensed feeds. Keys are required for live STOCK/ETF (Finnhub) and
    # tradable FX (OANDA v20). The public ECB feed stays available as a labelled,
    # non-tradable reference source when no FX key is configured.
    finnhub_api_key: str | None = None
    finnhub_api_key_file: str | None = None
    finnhub_base_url: str = "https://finnhub.io/api/v1"
    finnhub_spread_bps: float = 2.0
    oanda_api_key: str | None = None
    oanda_api_key_file: str | None = None
    oanda_account_id: str | None = None
    oanda_base_url: str = "https://api-fxpractice.oanda.com/v3"
    quote_cache_seconds: float = 1.0
    stream_interval_seconds: float = 1.0
    # Redis Streams fan-out for WebSockets. Off by default for local/dev; enable on
    # multi-replica hosts so quotes and account changes reach every node's clients.
    stream_fanout_enabled: bool = False
    stream_node_id: str | None = None     # stable per replica; random UUID when unset
    # Live account stream: change detection every N seconds, mark-to-market valuation every M seconds.
    account_stream_interval_seconds: float = 1.0
    account_valuation_interval_seconds: float = 2.0
    max_stream_symbols: int = 50

    # Research engine (Phase 4). "extractive" is offline and deterministic; "claude" uses the
    # Anthropic API (credentials from ANTHROPIC_API_KEY / an `ant auth login` profile).
    research_engine: Literal["extractive", "claude"] = "extractive"
    # Server-side Claude credential. The SDK can still use ANTHROPIC_API_KEY when
    # this is unset; file form suits Docker/Kubernetes secrets. Never logged/returned.
    claude_api_key: str | None = None
    claude_api_key_file: str | None = None
    llm_model: str = "claude-opus-5-5"
    llm_effort: Literal["low", "medium", "high", "xhigh", "max"] = "high"
    llm_timeout_seconds: float = 120.0
    research_top_k: int = 8
    research_asks_per_hour: int = 30
    # Hosts that admins may ingest from by URL/RSS. Empty = URL ingestion disabled.
    research_allowed_hosts: Annotated[list[str], NoDecode] = Field(default_factory=list)
    # OCR fallback for scanned PDFs. Requires the tesseract binary and PyMuPDF.
    ocr_enabled: bool = True
    ocr_language: str = "eng"
    ocr_dpi: int = 200
    ocr_max_pages: int = 40
    # Crypto derivatives positioning (funding + open interest). Off by default:
    # the feed is public but requires outbound access to the venue.
    positioning_enabled: bool = False
    positioning_base_url: str = "https://fapi.binance.com"
    positioning_ttl_seconds: float = 60.0
    # Fundamental analysis cache (vendor metrics or document-extracted figures).
    fundamentals_ttl_seconds: float = 3600.0

    # Binary options simulator (paper only). A win returns the stake plus payout_rate x stake;
    # a loss forfeits the stake; an exact tie refunds it. Break-even win rate = 1 / (1 + rate).
    binary_payout_rate: float = 0.80
    binary_expiries: Annotated[list[int], NoDecode] = Field(default_factory=lambda: [60, 300, 900, 3600, 86400])
    # Contracts whose settlement price cannot be observed this long after expiry are voided (refunded).
    binary_void_after_seconds: int = 600

    # Paper order matcher: seconds between passes over open LIMIT/STOP orders (0 = disabled).
    order_matcher_interval_seconds: float = 1.0
    # Autopilot: minimum seconds between cycles for an account whose autopilot is RUNNING.
    autopilot_interval_seconds: float = 900.0

    @field_validator("cors_origins", "supported_currencies", "research_allowed_hosts", "jwt_previous_secrets",
                     "binary_expiries", mode="before")
    @classmethod
    def _split_csv(cls, v: object) -> object:
        if isinstance(v, str):
            if v.lstrip().startswith("["):
                return json.loads(v)
            return [s.strip() for s in v.split(",") if s.strip()]
        return v

    @field_validator("ml_drift_check_interval_seconds")
    @classmethod
    def _drift_interval_positive(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("AUREX_ML_DRIFT_CHECK_INTERVAL_SECONDS must be positive")
        return v

    @field_validator("ml_drift_check_window_days")
    @classmethod
    def _drift_window_bounded(cls, v: int) -> int:
        if not 14 <= v <= 120:
            raise ValueError("AUREX_ML_DRIFT_CHECK_WINDOW_DAYS must be between 14 and 120")
        return v

    @model_validator(mode="after")
    def _load_secret_files(self) -> "Settings":
        if self.jwt_secret_file:
            self.jwt_secret = Path(self.jwt_secret_file).read_text().strip()
        if self.artifact_key_file:
            self.artifact_key = Path(self.artifact_key_file).read_text().strip()
        if self.data_key_file:
            self.data_key = Path(self.data_key_file).read_text().strip()
        if self.jwt_previous_secrets_file:
            lines = Path(self.jwt_previous_secrets_file).read_text().splitlines()
            self.jwt_previous_secrets = [x.strip() for x in lines if x.strip()]
        if self.database_url_file:
            self.database_url = Path(self.database_url_file).read_text().strip()
        if self.redis_url_file:
            self.redis_url = Path(self.redis_url_file).read_text().strip()
        if self.metrics_token_file:
            self.metrics_token = Path(self.metrics_token_file).read_text().strip()
        if self.finnhub_api_key_file:
            self.finnhub_api_key = Path(self.finnhub_api_key_file).read_text().strip()
        if self.oanda_api_key_file:
            self.oanda_api_key = Path(self.oanda_api_key_file).read_text().strip()
        if self.claude_api_key_file:
            self.claude_api_key = Path(self.claude_api_key_file).read_text().strip()
        return self

    @model_validator(mode="after")
    def _reject_live_trading_override(self) -> "Settings":
        # There is deliberately no live-trading setting. Fail loudly on a plausible
        # misconfiguration instead of silently ignoring an operator's intent.
        if os.environ.get("AUREX_LIVE_TRADING_ENABLED", "").strip().lower() in {"1", "true", "yes", "on"}:
            raise ValueError("Live trading is disabled in code; no environment override is supported")
        return self

    @model_validator(mode="after")
    def _guard_production(self) -> "Settings":
        if self.environment in ("staging", "production"):
            if self.jwt_secret == _DEV_SECRET or len(self.jwt_secret) < 32:
                raise ValueError("AUREX_JWT_SECRET must be set to a strong value (>=32 chars)")
            if any(s == _DEV_SECRET or len(s) < 32 for s in self.jwt_previous_secrets):
                raise ValueError("AUREX_JWT_PREVIOUS_SECRETS must also be strong (>=32 chars)")
            if self.artifact_key is not None and len(self.artifact_key) < 32:
                raise ValueError("AUREX_ARTIFACT_KEY must be at least 32 characters")
            if self.data_key is not None and len(self.data_key) < 32:
                raise ValueError("AUREX_DATA_KEY must be at least 32 characters")
            if not self.cookie_secure:
                raise ValueError("AUREX_COOKIE_SECURE must be true outside development")
            if self.require_admin_mfa is False or not self.admin_mfa_required:
                raise ValueError("AUREX_REQUIRE_ADMIN_MFA cannot be disabled outside development")
            if "*" in self.cors_origins or any(not o.startswith("https://") for o in self.cors_origins):
                raise ValueError("AUREX_CORS_ORIGINS must list explicit https:// origins outside development")
            if ":aurex@" in self.database_url:
                raise ValueError("AUREX_DATABASE_URL uses the default development password")
            if self.metrics_token is not None and len(self.metrics_token) < 32:
                raise ValueError("AUREX_METRICS_TOKEN must be at least 32 characters")
            if (self.research_engine == "claude" and not self.claude_api_key
                    and not os.environ.get("ANTHROPIC_API_KEY")):
                raise ValueError("AUREX_CLAUDE_API_KEY (or ANTHROPIC_API_KEY) is required "
                                 "when AUREX_RESEARCH_ENGINE=claude")
            secret = self.audit_anchor_webhook_secret or ""
            if self.audit_anchor_webhook_url and len(secret) < 32:
                raise ValueError("AUREX_AUDIT_ANCHOR_WEBHOOK_SECRET (>=32 chars) is required with a webhook")
        return self

    @property
    def docs_enabled(self) -> bool:
        if self.expose_api_docs is not None:
            return self.expose_api_docs
        return self.environment in ("development", "test")

    @property
    def admin_mfa_required(self) -> bool:
        if self.require_admin_mfa is not None:
            return self.require_admin_mfa
        return self.environment in ("staging", "production")

    @property
    def hsts_enabled(self) -> bool:
        return self.environment in ("staging", "production")

    @property
    def live_trading_enabled(self) -> bool:
        # Hard-wired off for Stage 1. Changing this requires a code change + review,
        # and the database also rejects non-PAPER trading accounts.
        return False


@lru_cache
def get_settings() -> Settings:
    return Settings()
