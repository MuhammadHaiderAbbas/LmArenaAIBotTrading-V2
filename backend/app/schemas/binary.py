import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class BinaryConfig(BaseModel):
    paper_only: bool = True
    payout_rate: float
    expiries: list[int]
    break_even_win_rate: float
    coin_flip_expected_return: float
    minimum_stake: Decimal
    void_after_seconds: int
    notice: str


class BinaryCreate(BaseModel):
    account_id: uuid.UUID
    symbol: str = Field(min_length=1, max_length=32)
    direction: Literal["HIGHER", "LOWER"]
    stake: Decimal = Field(gt=0, max_digits=16, decimal_places=2)
    expiry_seconds: int = Field(gt=0)
    client_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{8,64}$")


class BinaryRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    account_id: uuid.UUID
    symbol: str
    direction: str
    stake: Decimal
    currency: str
    payout_rate: float
    potential_return: Decimal
    strike: Decimal
    expiry_seconds: int
    opened_at: datetime
    expires_at: datetime
    status: str
    settle_price: Decimal | None
    settle_price_at: datetime | None
    settled_at: datetime | None
    returned: Decimal | None
    pnl: Decimal | None
    void_reason: str | None
    client_id: str | None


class BinaryGroupStats(BaseModel):
    contracts: int
    open: int
    won: int
    lost: int
    ties: int
    void: int
    staked: Decimal
    net_pnl: Decimal
    win_rate: float | None
    return_on_stake: float | None


class BinaryStats(BinaryGroupStats):
    account_id: uuid.UUID
    currency: str
    paper_only: bool = True
    payout_rate: float
    expiries: list[int]
    break_even_win_rate: float
    coin_flip_expected_return: float
    minimum_stake: Decimal
    void_after_seconds: int
    expected_return_at_win_rate: float | None
    edge_vs_break_even: float | None
    by_expiry: dict[str, BinaryGroupStats]
    by_symbol: dict[str, BinaryGroupStats]
    by_direction: dict[str, BinaryGroupStats]


def read(c: Any) -> BinaryRead:
    potential = (c.stake * (1 + Decimal(str(c.payout_rate)))).quantize(Decimal("0.01"))
    return BinaryRead(**{k: getattr(c, k) for k in BinaryRead.model_fields if k != "potential_return"},
                      potential_return=potential)
