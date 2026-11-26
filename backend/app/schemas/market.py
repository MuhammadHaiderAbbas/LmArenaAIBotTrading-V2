from datetime import datetime
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, Field, computed_field

from app.schemas.common import ORMModel


class InstrumentRead(ORMModel):
    symbol: str
    display_name: str
    asset_class: str
    instrument_type: str
    venue: str
    market: str
    base_currency: str
    quote_currency: str
    price_decimals: int
    tick_size: Decimal
    lot_size: Decimal

    @computed_field  # URL-safe identifier ("EUR/USD" -> "EURUSD")
    @property
    def slug(self) -> str:
        return self.symbol.replace("/", "")


class QuoteRead(ORMModel):
    symbol: str
    last: Decimal
    bid: Decimal
    ask: Decimal
    prev_close: Decimal | None
    change: Decimal | None
    change_pct: Decimal | None
    as_of: datetime
    source: str
    market_open: bool
    stale: bool
    tradable: bool
    age_seconds: int
    # actual bid/ask | estimated_spread (real last, modelled spread)
    # | reference (fixing) | simulated (demo only)
    pricing: str = "actual"


class InstrumentWithQuote(BaseModel):
    instrument: InstrumentRead
    quote: QuoteRead | None


class PositioningRead(BaseModel):
    symbol: str
    venue_symbol: str
    funding_rate: float
    funding_bps: float
    mark_price: float
    index_price: float
    open_interest: float
    oi_change_pct: float
    as_of: datetime
    source: str


class PositioningResponse(BaseModel):
    available: bool
    data: PositioningRead | None = None
    reason: str | None = None


class CandleRead(ORMModel):
    open_time: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal


class CandlesResponse(BaseModel):
    symbol: str
    timeframe: str
    source: str | None
    candles: list[CandleRead]
    indicators: dict[str, Any] = Field(default_factory=dict)


class MarketStatus(BaseModel):
    market: str
    label: str
    is_open: bool
    next_change: datetime | None


class MarketOverview(BaseModel):
    markets: list[MarketStatus]
    groups: dict[str, list[InstrumentWithQuote]]
    data_mode: str


class WatchlistRead(BaseModel):
    id: str
    name: str
    items: list[InstrumentWithQuote]


class WatchlistAdd(BaseModel):
    symbol: str = Field(min_length=1, max_length=32)


class BackfillRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=32)
    timeframe: str = "1h"
    days: int = Field(default=30, ge=1, le=730)
