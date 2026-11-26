from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal


class AssetClass:
    CRYPTO = "CRYPTO"
    FX = "FX"
    STOCK = "STOCK"
    ETF = "ETF"
    ALL = (CRYPTO, FX, STOCK, ETF)


class Market:
    CRYPTO_24_7 = "CRYPTO_24_7"
    FX_24_5 = "FX_24_5"
    US_EQUITY = "US_EQUITY"
    UK_EQUITY = "UK_EQUITY"
    ALL = (CRYPTO_24_7, FX_24_5, US_EQUITY, UK_EQUITY)


TIMEFRAMES: dict[str, int] = {
    "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400,
}


@dataclass(frozen=True)
class InstrumentRef:
    """The subset of an instrument a provider needs (decoupled from the ORM)."""

    symbol: str
    asset_class: str
    market: str
    provider_symbol: str
    price_decimals: int
    base_price: Decimal  # reference level for the synthetic generator


@dataclass(frozen=True)
class Candle:
    open_time: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal


@dataclass(frozen=True)
class RawQuote:
    last: Decimal
    bid: Decimal
    ask: Decimal
    prev_close: Decimal | None
    as_of: datetime
    source: str
    # "actual" (real bid/ask), "estimated_spread" (real last, modelled spread),
    # "reference" (non-tradable fixing) or "simulated" (public demo only).
    pricing: str = "actual"


class ProviderError(Exception):
    """Upstream provider failed or returned unusable data."""


class UnsupportedTimeframe(ProviderError):
    pass
