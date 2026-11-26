"""Paper binary options: fixed-payout HIGHER/LOWER contracts on an instrument's price.

A contract stakes S (account currency) that the price at expiry will be higher (or lower)
than the strike, the price when it opened. At expiry:

    WON   price moved the predicted way   -> S x (1 + payout) returned, profit S x payout
    LOST  price moved the other way       -> nothing returned, loss S
    TIE   price exactly at the strike     -> S refunded
    VOID  no usable price after expiry    -> S refunded

Strike and settlement both use the mid price, so the house edge is only in the payout: with
an 80% payout you must win 1 / 1.8 = 55.6% of contracts just to break even, and a coin-flip
forecaster loses 10% of every stake on average. The UI shows this before every contract.

Ledger (double-entry, like every other money movement):
    open    Dr INVESTMENTS S              Cr CASH S
    WON     Dr CASH S(1+p)                Cr INVESTMENTS S, Cr REALISED_PNL Sp
    LOST    Dr REALISED_PNL S             Cr INVESTMENTS S
    TIE/VOID Dr CASH S                    Cr INVESTMENTS S

Paper only. Binary options are banned for retail customers in the UK (FCA, 2019) and the
EU/EEA (ESMA 2018, then national rules); nothing here connects to a real broker.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import ROUND_DOWN, Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import BusinessRuleViolation, NotFound
from app.market import calendar
from app.market.service import ProviderUnavailable
from app.models import BinaryContract, BinaryStatus, Order, RiskDecision, TradingAccount, User
from app.models.ledger import Direction, LedgerCode, TransactionType
from app.risk import engine
from app.risk.service import limits_of
from app.services.ledger_service import Posting
from app.trading.service import TradingService

CENT = Decimal("0.01")
Q8 = Decimal("0.00000001")
SIDE = {"HIGHER": "CALL", "LOWER": "PUT"}   # risk_decisions.side is 4 characters


class BinaryRejected(BusinessRuleViolation):
    """A risk rejection. The decision row is recorded, so the caller commits before re-raising."""

    def __init__(self, message: str, checks: list[dict]):
        super().__init__(message, details={"checks": checks}, code="risk_rejected")
        self.checks = checks


@dataclass
class BinaryRequest:
    account_id: uuid.UUID
    symbol: str
    direction: str
    stake: Decimal
    expiry_seconds: int
    client_id: str | None = None


def config() -> dict[str, Any]:
    s = get_settings()
    p = s.binary_payout_rate
    return {
        "paper_only": True, "payout_rate": p, "expiries": sorted(s.binary_expiries),
        "break_even_win_rate": 1 / (1 + p),
        "coin_flip_expected_return": 0.5 * p - 0.5, "minimum_stake": Decimal(s.min_order_value),
        "void_after_seconds": s.binary_void_after_seconds,
    }


def expected_return(win_rate: float, payout: float) -> float:
    """Expected profit per unit staked at a given win rate (ties ignored)."""
    return win_rate * payout - (1 - win_rate)


def _mid(q) -> Decimal:
    return (q.bid + q.ask) / 2


class BinaryService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.trading = TradingService(db)
        self.market = self.trading.market
        self.ledger = self.trading.ledger
        self.risk = self.trading.risk

    # -- open -------------------------------------------------------------------------------
    async def open(self, user: User, req: BinaryRequest) -> tuple[BinaryContract, bool]:
        acct = await self.trading._account(user, req.account_id, lock=True)
        if req.client_id:
            existing = await self.db.scalar(select(BinaryContract).where(
                BinaryContract.account_id == acct.id, BinaryContract.client_id == req.client_id))
            if existing:
                return existing, False
        cfg = config()
        if req.direction not in SIDE:
            raise BusinessRuleViolation("direction must be HIGHER or LOWER")
        if req.expiry_seconds not in cfg["expiries"]:
            raise BusinessRuleViolation(f"expiry_seconds must be one of {cfg['expiries']}")
        if req.stake <= 0 or req.stake.quantize(CENT) != req.stake:
            raise BusinessRuleViolation("stake must be positive with at most 2 decimals")
        inst = await self.market.get(req.symbol)
        try:
            q = await self.market.quote(inst)
        except ProviderUnavailable as e:
            raise BusinessRuleViolation("no market data available") from e
        if not q.tradable:
            raise BusinessRuleViolation("market is closed" if not q.market_open else "quote is stale")
        now = datetime.now(UTC)
        expires = now + timedelta(seconds=req.expiry_seconds)
        sess = calendar.sessions(inst.market, now, expires + timedelta(seconds=1))
        if len(sess) != 1 or sess[0][0] > now or sess[0][1] < expires:
            raise BusinessRuleViolation("the market closes before this contract would expire; choose a shorter expiry")

        prof = await self.risk.profile(acct.id, lock=True)
        summary = await self.trading.summary(acct, take_snapshot=False)
        await self.risk.metrics(acct, summary, prof)
        halt = await self.risk.system_halt()
        open_n = await self.db.scalar(select(func.count()).select_from(BinaryContract).where(
            BinaryContract.account_id == acct.id, BinaryContract.status == BinaryStatus.OPEN))
        since = now - timedelta(seconds=60)
        recent = (await self.db.scalar(select(func.count()).select_from(Order).where(
            Order.account_id == acct.id, Order.source != "protective", Order.created_at >= since)) or 0) + \
            (await self.db.scalar(select(func.count()).select_from(BinaryContract).where(
                BinaryContract.account_id == acct.id, BinaryContract.opened_at >= since)) or 0)
        checks = engine.evaluate_binary(engine.BinaryPreTrade(
            system_halt=(halt["reason"] or "halted") if halt["halted"] else None,
            kill_switch=(prof.kill_reason or "engaged") if prof.kill_switch else None,
            daily_halted=self.risk.is_daily_halted(prof), drawdown_halted=prof.drawdown_halted,
            enabled=prof.binary_enabled, equity=summary["equity"], stake=req.stake,
            minimum_stake=cfg["minimum_stake"], open_after=int(open_n or 0) + 1, orders_last_minute=int(recent)),
            limits_of(prof))
        reason = engine.first_failure(checks)
        if reason is None and req.stake > summary["available_cash"]:
            reason = f"insufficient cash: stake {req.stake:,.2f}, available {summary['available_cash']:,.2f}"
            checks.append(engine.Check("cash", "Available cash", False, f"{summary['available_cash']:,.2f}",
                                       f"{req.stake:,.2f}", reason))
        rate = next(c for c in checks if c.name == "order_rate")
        if not rate.passed and not prof.kill_switch:
            await self.risk.engage_kill_switch(acct, prof, rate.message, actor=None, automatic=True)
        cdicts = [c.dict() for c in checks]
        if reason:
            self.db.add(RiskDecision(account_id=acct.id, source="binary", symbol=inst.symbol, side=SIDE[req.direction],
                                     approved=False, reason=reason, checks=cdicts))
            await self.db.flush()
            raise BinaryRejected(f"risk: {reason}", cdicts)

        strike = _mid(q).quantize(Decimal(1).scaleb(-inst.price_decimals - 2))
        txn = await self.ledger.post(acct, TransactionType.BINARY_OPEN, [
            Posting(LedgerCode.INVESTMENTS, Direction.DEBIT, req.stake),
            Posting(LedgerCode.CASH, Direction.CREDIT, req.stake)], created_by=user.id,
            description=f"Binary {req.direction} {inst.symbol} {req.expiry_seconds}s, stake {req.stake:,.2f}")
        c = BinaryContract(account_id=acct.id, user_id=user.id, instrument_id=inst.id, symbol=inst.symbol,
                           direction=req.direction, stake=req.stake, currency=acct.base_currency,
                           payout_rate=cfg["payout_rate"], strike=strike, expiry_seconds=req.expiry_seconds,
                           opened_at=now, expires_at=expires, status=BinaryStatus.OPEN, open_txn_id=txn.id,
                           client_id=req.client_id)
        self.db.add(c)
        await self.db.flush()
        self.db.add(RiskDecision(account_id=acct.id, binary_id=c.id, source="binary", symbol=inst.symbol,
                                 side=SIDE[req.direction], approved=True, reason=None, checks=cdicts))
        await self.trading.snapshot(acct, "binary")
        return c, True

    # -- settle -----------------------------------------------------------------------------
    async def settle_due(self, account_id: uuid.UUID | None = None) -> dict[str, int]:
        """Settle every expired open contract that has a price at or after its expiry."""
        now = datetime.now(UTC)
        stmt = select(BinaryContract).where(BinaryContract.status == BinaryStatus.OPEN, BinaryContract.expires_at <= now)
        if account_id is not None:
            stmt = stmt.where(BinaryContract.account_id == account_id)
        stats = {"checked": 0, "settled": 0, "voided": 0}
        touched: set[uuid.UUID] = set()
        for c in list(await self.db.scalars(stmt.order_by(BinaryContract.expires_at).with_for_update(skip_locked=True))):
            stats["checked"] += 1
            inst = await self.market.get(c.symbol)
            try:
                q = await self.market.quote(inst)
            except ProviderUnavailable:
                q = None
            if q is not None and q.as_of >= c.expires_at and not q.stale:
                await self._settle(c, _mid(q), q.as_of)
                stats["settled"] += 1
                touched.add(c.account_id)
            elif (now - c.expires_at).total_seconds() >= get_settings().binary_void_after_seconds:
                await self._settle(c, None, None, void_reason="no price was available after expiry")
                stats["voided"] += 1
                touched.add(c.account_id)
        for aid in touched:
            acct = await self.trading._account(None, aid, lock=True)
            await self.risk.metrics(acct, await self.trading.snapshot(acct, "binary"))
        await self.db.flush()
        return stats

    async def _settle(self, c: BinaryContract, price: Decimal | None, price_at: datetime | None,
                      void_reason: str | None = None) -> None:
        acct = await self.trading._account(None, c.account_id, lock=True)
        S = c.stake
        if price is None:
            status = BinaryStatus.VOID
        elif price == c.strike:
            status = BinaryStatus.TIE
        else:
            won = price > c.strike if c.direction == "HIGHER" else price < c.strike
            status = BinaryStatus.WON if won else BinaryStatus.LOST
        if status == BinaryStatus.WON:
            profit = (S * Decimal(str(c.payout_rate))).quantize(Q8, rounding=ROUND_DOWN)
            returned, pnl = S + profit, profit
            postings = [Posting(LedgerCode.CASH, Direction.DEBIT, returned),
                        Posting(LedgerCode.INVESTMENTS, Direction.CREDIT, S),
                        Posting(LedgerCode.REALISED_PNL, Direction.CREDIT, profit)]
        elif status == BinaryStatus.LOST:
            returned, pnl = Decimal(0), -S
            postings = [Posting(LedgerCode.REALISED_PNL, Direction.DEBIT, S),
                        Posting(LedgerCode.INVESTMENTS, Direction.CREDIT, S)]
        else:
            returned, pnl = S, Decimal(0)
            postings = [Posting(LedgerCode.CASH, Direction.DEBIT, S), Posting(LedgerCode.INVESTMENTS, Direction.CREDIT, S)]
        txn = await self.ledger.post(acct, TransactionType.BINARY_SETTLE, postings, created_by=None,
                                     description=f"Binary {c.direction} {c.symbol} {status.lower()}"
                                                 + (f" at {price.normalize():f} vs strike {c.strike.normalize():f}" if price is not None else ""))
        c.status, c.settle_price, c.settle_price_at, c.settled_at = status, price, price_at, datetime.now(UTC)
        c.returned, c.pnl, c.settle_txn_id, c.void_reason = returned, pnl, txn.id, void_reason
        await self.db.flush()

    # -- read -------------------------------------------------------------------------------
    async def owned(self, user: User, contract_id: uuid.UUID) -> BinaryContract:
        c = await self.db.scalar(select(BinaryContract).where(BinaryContract.id == contract_id,
                                                              BinaryContract.user_id == user.id))
        if c is None:
            raise NotFound("Binary contract not found")
        return c

    async def stats(self, acct: TradingAccount) -> dict[str, Any]:
        rows = list(await self.db.scalars(select(BinaryContract).where(BinaryContract.account_id == acct.id)))
        cfg = config()

        def agg(items: list[BinaryContract]) -> dict[str, Any]:
            won = sum(1 for c in items if c.status == BinaryStatus.WON)
            lost = sum(1 for c in items if c.status == BinaryStatus.LOST)
            decided = won + lost
            settled = [c for c in items if c.status != BinaryStatus.OPEN]
            wr = won / decided if decided else None
            return {
                "contracts": len(items), "open": sum(1 for c in items if c.status == BinaryStatus.OPEN),
                "won": won, "lost": lost, "ties": sum(1 for c in items if c.status == BinaryStatus.TIE),
                "void": sum(1 for c in items if c.status == BinaryStatus.VOID),
                "staked": sum((c.stake for c in settled), Decimal(0)),
                "net_pnl": sum((c.pnl or Decimal(0) for c in settled), Decimal(0)),
                "win_rate": wr,
                "return_on_stake": (float(sum((c.pnl or Decimal(0) for c in settled), Decimal(0))
                                          / sum((c.stake for c in settled), Decimal(0)))
                                    if settled else None),
            }

        by: dict[str, dict[str, list[BinaryContract]]] = {"expiry": {}, "symbol": {}, "direction": {}}
        for c in rows:
            by["expiry"].setdefault(str(c.expiry_seconds), []).append(c)
            by["symbol"].setdefault(c.symbol, []).append(c)
            by["direction"].setdefault(c.direction, []).append(c)
        overall = agg(rows)
        wr = overall["win_rate"]
        return {
            "account_id": acct.id, "currency": acct.base_currency, **cfg, **overall,
            "expected_return_at_win_rate": expected_return(wr, cfg["payout_rate"]) if wr is not None else None,
            "edge_vs_break_even": (wr - cfg["break_even_win_rate"]) if wr is not None else None,
            "by_expiry": {k: agg(v) for k, v in sorted(by["expiry"].items(), key=lambda kv: int(kv[0]))},
            "by_symbol": {k: agg(v) for k, v in sorted(by["symbol"].items())},
            "by_direction": {k: agg(v) for k, v in sorted(by["direction"].items())},
        }
