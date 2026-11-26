from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal

Status = Literal["ok", "abstain", "error"]


@dataclass(frozen=True)
class Bar:
    t: datetime
    o: float
    h: float
    l: float  # noqa: E741
    c: float


@dataclass(frozen=True)
class DocSignal:
    """A research document as seen by the agents (no text, just what they need)."""

    title: str
    doc_type: str
    age_days: float
    sentiment: float
    is_sample: bool


@dataclass(frozen=True)
class QuoteSnap:
    last: float
    bid: float
    ask: float
    market_open: bool
    stale: bool
    tradable: bool
    source: str
    as_of: datetime


@dataclass(frozen=True)
class AccountSnap:
    id: str
    currency: str
    equity: Decimal
    cash: Decimal


@dataclass(frozen=True)
class InstrumentSnap:
    symbol: str
    asset_class: str
    market: str
    quote_currency: str
    price_decimals: int
    lot_size: Decimal


@dataclass
class AgentContext:
    instrument: InstrumentSnap
    now: datetime
    bars_1h: list[Bar]
    bars_1d: list[Bar]
    quote: QuoteSnap | None
    docs: list[DocSignal]
    macro_docs: list[DocSignal]
    account: AccountSnap | None
    # units of account currency per 1 unit of quote currency (None = unavailable)
    fx_to_account: float | None
    open_positions: int = 0
    # champion-model output computed while building the snapshot (None = no champion)
    ml: dict[str, Any] | None = None
    # crypto perp funding/open interest (None = feed unavailable or not applicable)
    positioning: dict[str, Any] | None = None
    # equity ratios/valuation with provenance (None = unavailable/not applicable)
    fundamentals: dict[str, Any] | None = None


@dataclass
class Evidence:
    label: str
    value: str
    detail: str = ""


@dataclass
class Finding:
    agent: str
    status: Status
    direction: int = 0           # -1 bearish, 0 neutral/none, +1 bullish
    score: float = 0.0           # [-1, 1] for directional agents; [0, 1] suitability for gates
    confidence: float = 0.0      # [0, 1] how much the agent trusts its own reading
    summary: str = ""
    evidence: list[Evidence] = field(default_factory=list)
    data: dict[str, Any] = field(default_factory=dict)   # machine-readable outputs for others

    @staticmethod
    def abstain(agent: str, reason: str) -> "Finding":
        return Finding(agent=agent, status="abstain", summary=reason)
