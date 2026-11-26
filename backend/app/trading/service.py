"""Paper order management system.

Lifecycle:  submit ─► validate ─┬─► REJECTED (persisted with reason)
                                ├─► MARKET: filled immediately on the live quote ─► FILLED
                                └─► LIMIT/STOP: OPEN ─► matcher ─► FILLED | CANCELLED | EXPIRED
Every fill: execution row (append-only) + balanced ledger transaction + position update +
portfolio snapshot, all in one database transaction under a lock on the trading account.

Spot, long-only, no leverage: sells cannot exceed the open position and buys cannot exceed
available cash (cash minus amounts reserved by open buy orders). Whole-order fills only.

Phase 9: every well-formed order that passes the business checks then goes through the
independent risk engine (app/risk), which has the final say. Entry orders may carry a
stop_loss and/or take_profit; once filled they spawn protective child orders (OCO).
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import BusinessRuleViolation, NotFound
from app.market.calendar import day_expiry
from app.market.service import MarketService, ProviderUnavailable, fx_rate
from app.models import (
    AccountStatus,
    BinaryContract,
    BinaryStatus,
    Execution,
    Instrument,
    Order,
    OrderEvent,
    OrderStatus,
    PortfolioSnapshot,
    Position,
    TradingAccount,
    User,
)
from app.models.ledger import Direction, LedgerCode, TransactionType
from app.risk.service import RiskService
from app.services.ledger_service import LedgerService, Posting
from app.trading import execution as ex

GTC_DAYS = 30
Q8 = Decimal("0.00000001")


@dataclass
class OrderRequest:
    account_id: uuid.UUID
    symbol: str
    side: str
    type: str
    quantity: Decimal
    limit_price: Decimal | None = None
    stop_price: Decimal | None = None
    time_in_force: str = "GTC"
    client_order_id: str | None = None
    source: str = "manual"
    stop_loss: Decimal | None = None
    take_profit: Decimal | None = None
    proposal_id: uuid.UUID | None = None


def _fmt(v: Decimal) -> str:
    """Plain decimal text: Decimal("10").normalize() would print as 1E+1."""
    return format(Decimal(v).normalize(), "f")


def _q8(v: Decimal) -> Decimal:
    return v.quantize(Q8)


class TradingService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.market = MarketService(db)
        self.ledger = LedgerService(db)
        self.risk = RiskService(db)

    # -- helpers ----------------------------------------------------------------------
    async def _account(self, user: User | None, account_id: uuid.UUID, lock: bool = False) -> TradingAccount:
        stmt = select(TradingAccount).where(TradingAccount.id == account_id)
        if user is not None:
            stmt = stmt.where(TradingAccount.owner_id == user.id)
        if lock:
            stmt = stmt.with_for_update()
        acct = await self.db.scalar(stmt)
        if acct is None:
            raise NotFound("Trading account not found")
        return acct

    async def _cash(self, acct: TradingAccount) -> Decimal:
        return LedgerService.summarise((await self.ledger.balances([acct.id]))[acct.id])["cash"]

    async def _position(self, account_id: uuid.UUID, symbol: str, lock: bool = False) -> Position | None:
        stmt = select(Position).where(Position.account_id == account_id, Position.symbol == symbol,
                                      Position.status == "OPEN")
        if lock:
            stmt = stmt.with_for_update()
        return await self.db.scalar(stmt)

    def _event(self, order: Order, type_: str, **detail: Any) -> None:
        self.db.add(OrderEvent(order_id=order.id, type=type_, detail={k: str(v) if isinstance(v, Decimal) else v
                                                                       for k, v in detail.items()}))

    @staticmethod
    def _estimate(o: Order | OrderRequest, ask: Decimal, slip: Decimal) -> Decimal:
        if o.type == "LIMIT" and o.limit_price is not None:
            return o.limit_price
        if o.type == "STOP" and o.stop_price is not None:
            return max(o.stop_price, ask) * (1 + slip)
        return ask * (1 + slip)

    async def _reserved(self, account_id: uuid.UUID, exclude: uuid.UUID | None = None) -> Decimal:
        """Cash earmarked by open BUY orders (at their limit/stop estimate, plus fee)."""
        rows = await self.db.scalars(select(Order).where(Order.account_id == account_id, Order.side == "BUY",
                                                         Order.status == OrderStatus.OPEN))
        total = Decimal(0)
        for o in rows:
            if o.id == exclude:
                continue
            inst = await self.db.get(Instrument, o.instrument_id)
            acct = await self.db.get(TradingAccount, o.account_id)
            fx = await fx_rate(self.market, inst.quote_currency, acct.base_currency) or Decimal(1)
            px = o.limit_price or o.stop_price or Decimal(0)
            total += o.quantity * px * fx * (1 + ex.fee_rate(inst.asset_class) + ex.slippage(inst.asset_class))
        return total

    # -- submit -----------------------------------------------------------------------
    async def place(self, user: User, req: OrderRequest) -> tuple[Order, bool]:
        acct = await self._account(user, req.account_id, lock=True)
        if req.client_order_id:
            existing = await self.db.scalar(select(Order).where(Order.account_id == acct.id,
                                                                Order.client_order_id == req.client_order_id))
            if existing:
                return existing, False
        inst = await self.market.get(req.symbol)
        self._validate_shape(req, inst)
        now = datetime.now(UTC)
        expires = (day_expiry(inst.market, now)
                   if req.time_in_force == "DAY" else now + timedelta(days=GTC_DAYS))
        order = Order(account_id=acct.id, user_id=user.id, instrument_id=inst.id, symbol=inst.symbol, side=req.side,
                      type=req.type, quantity=req.quantity, limit_price=req.limit_price, stop_price=req.stop_price,
                      time_in_force=req.time_in_force, status=OrderStatus.OPEN, client_order_id=req.client_order_id,
                      source=req.source, expires_at=None if req.type == "MARKET" else expires,
                      stop_loss=req.stop_loss, take_profit=req.take_profit, proposal_id=req.proposal_id)
        self.db.add(order)
        await self.db.flush()
        self._event(order, "CREATED", side=req.side, type=req.type, quantity=req.quantity,
                    limit_price=req.limit_price, stop_price=req.stop_price, tif=req.time_in_force,
                    stop_loss=req.stop_loss, take_profit=req.take_profit, source=req.source)

        reason = await self._business_checks(acct, inst, order)
        if reason:
            await self._reject(order, reason)
            return order, True
        try:
            q = await self.market.quote(inst)
        except ProviderUnavailable:
            q = None
        slip = ex.slippage(inst.asset_class)
        fill = None
        if order.type == "MARKET":
            if q is None:
                await self._reject(order, "no market data available")
                return order, True
            if not q.tradable:
                why = "market is closed" if not q.market_open else "quote is stale" if q.stale else "quote is not tradable"
                await self._reject(order, why)
                return order, True
            fill = ex.match(order.side, "MARKET", q.bid, q.ask, None, None, slip)
            entry = fill.price
        else:
            entry = self._estimate(order, q.ask if q else (order.limit_price or order.stop_price), slip)
        if order.stop_loss is not None and order.stop_loss >= entry:
            await self._reject(order, f"stop_loss {_fmt(order.stop_loss)} must be below the entry price (≈{entry:.{inst.price_decimals}f})")
            return order, True
        if order.take_profit is not None and order.take_profit <= entry:
            await self._reject(order, f"take_profit {_fmt(order.take_profit)} must be above the entry price (≈{entry:.{inst.price_decimals}f})")
            return order, True

        approved, checks, why = await self._risk_gate(acct, inst, order, entry, q)
        self._event(order, "RISK_APPROVED" if approved else "RISK_REJECTED",
                    failed=[c["name"] for c in checks if not c["passed"]])
        if not approved:
            await self._reject(order, f"risk: {why}")
            return order, True
        if fill is not None:
            await self._fill(acct, inst, order, fill, q.bid, q.ask)
        else:
            self._event(order, "ACCEPTED", expires_at=order.expires_at.isoformat())
        await self.db.flush()
        return order, True

    async def _risk_gate(self, acct: TradingAccount, inst: Instrument, order: Order, entry: Decimal, q) -> tuple[bool, list, str | None]:
        fx = await fx_rate(self.market, inst.quote_currency, acct.base_currency) or Decimal(1)
        summary = await self.summary(acct, take_snapshot=False)
        open_buys = set(await self.db.scalars(select(Order.symbol).where(
            Order.account_id == acct.id, Order.side == "BUY", Order.status == OrderStatus.OPEN, Order.id != order.id)))
        pos = await self._position(acct.id, inst.symbol)
        return await self.risk.pre_trade(
            acct, order, asset_class=inst.asset_class, entry=entry, fx=fx, bid=q.bid if q else None,
            ask=q.ask if q else None, summary=summary, reserved_buys=await self._reserved(acct.id, exclude=order.id),
            open_buy_symbols=open_buys, held_qty=pos.quantity if pos else Decimal(0))

    @staticmethod
    def _validate_shape(req: OrderRequest, inst: Instrument) -> None:
        if req.quantity <= 0:
            raise BusinessRuleViolation("Quantity must be positive")
        if (req.quantity / inst.lot_size) % 1 != 0:
            raise BusinessRuleViolation(f"Quantity must be a multiple of the lot size {_fmt(inst.lot_size)}")
        tick = Decimal(1).scaleb(-inst.price_decimals)
        for name, v in (("limit_price", req.limit_price), ("stop_price", req.stop_price)):
            if v is not None and (v <= 0 or v.quantize(tick) != v):
                raise BusinessRuleViolation(f"{name} must be positive with at most {inst.price_decimals} decimals")
        if req.type == "LIMIT" and req.limit_price is None:
            raise BusinessRuleViolation("LIMIT orders need a limit_price")
        if req.type == "STOP" and req.stop_price is None:
            raise BusinessRuleViolation("STOP orders need a stop_price")
        if req.type == "MARKET" and (req.limit_price or req.stop_price):
            raise BusinessRuleViolation("MARKET orders take no limit or stop price")
        for name, v in (("stop_loss", req.stop_loss), ("take_profit", req.take_profit)):
            if v is None:
                continue
            if req.side != "BUY":
                raise BusinessRuleViolation(f"{name} can only be attached to BUY (entry) orders")
            if v <= 0 or v.quantize(tick) != v:
                raise BusinessRuleViolation(f"{name} must be positive with at most {inst.price_decimals} decimals")
        if req.stop_loss and req.take_profit and req.stop_loss >= req.take_profit:
            raise BusinessRuleViolation("stop_loss must be below take_profit")

    async def _business_checks(self, acct: TradingAccount, inst: Instrument, order: Order) -> str | None:
        if acct.status != AccountStatus.ACTIVE:
            return "account is not active"
        pos = await self._position(acct.id, inst.symbol)
        if order.side == "SELL":
            pending = await self.db.scalar(select(func.coalesce(func.sum(Order.quantity), 0)).where(
                Order.account_id == acct.id, Order.symbol == inst.symbol, Order.side == "SELL",
                Order.status == OrderStatus.OPEN, Order.id != order.id, Order.source != "protective"))
            held = pos.quantity if pos else Decimal(0)
            if order.quantity > held - Decimal(pending):
                return f"insufficient position: holding {_fmt(held)}, {_fmt(Decimal(pending))} already in open sell orders (short selling is disabled)"
            return None
        fx = await fx_rate(self.market, inst.quote_currency, acct.base_currency)
        if fx is None:
            return f"no FX rate from {inst.quote_currency} to {acct.base_currency}"
        try:
            q = await self.market.quote(inst)
            ask = q.ask
        except ProviderUnavailable:
            ask = order.limit_price or order.stop_price or Decimal(0)
        est = order.quantity * self._estimate(order, ask, ex.slippage(inst.asset_class)) * fx
        minimum = Decimal(get_settings().min_order_value)
        if 0 < est < minimum:   # entries only (exits of small leftovers are always allowed); 0 = no price yet
            return (f"order value ≈{est:,.2f} {acct.base_currency} is below the minimum order of "
                    f"{minimum:,.2f} {acct.base_currency}")
        est *= 1 + ex.fee_rate(inst.asset_class)
        available = await self._cash(acct) - await self._reserved(acct.id, exclude=order.id)
        if est > available:
            return f"insufficient cash: needs ≈{est:,.2f} {acct.base_currency}, available {available:,.2f} (no leverage)"
        return None

    async def _reject(self, order: Order, reason: str) -> None:
        order.status, order.reject_reason = OrderStatus.REJECTED, reason
        self._event(order, "REJECTED", reason=reason)
        await self.db.flush()

    # -- fill -------------------------------------------------------------------------
    async def _fill(self, acct: TradingAccount, inst: Instrument, order: Order, fill: ex.Fill,
                    bid: Decimal, ask: Decimal) -> Execution | None:
        now = datetime.now(UTC)
        fx = await fx_rate(self.market, inst.quote_currency, acct.base_currency)
        if fx is None:
            await self._reject(order, "FX rate unavailable at fill time")
            return None
        qty, px = order.quantity, fill.price
        notional = _q8(qty * px * fx)
        fee = _q8(notional * ex.fee_rate(inst.asset_class))
        mid = (bid + ask) / 2
        spread_cost = _q8(abs(fill.reference - mid) * qty * fx)
        slip_cost = _q8(abs(px - fill.reference) * qty * fx)
        pos = await self._position(acct.id, inst.symbol, lock=True)
        realised = None
        if order.side == "SELL" and order.source == "protective" and pos is not None and qty > pos.quantity:
            # the position was partly sold since this protective order was placed
            order.quantity = qty = pos.quantity
            self._event(order, "RESIZED", quantity=qty)
            notional = _q8(qty * px * fx)
            fee = _q8(notional * ex.fee_rate(inst.asset_class))
            spread_cost = _q8(abs(fill.reference - mid) * qty * fx)
            slip_cost = _q8(abs(px - fill.reference) * qty * fx)

        if order.side == "BUY":
            if notional + fee > await self._cash(acct):
                await self._reject(order, "insufficient cash at fill time")
                return None
            postings = [Posting(LedgerCode.INVESTMENTS, Direction.DEBIT, notional),
                        Posting(LedgerCode.CASH, Direction.CREDIT, notional)]
            if fee > 0:
                postings += [Posting(LedgerCode.FEES, Direction.DEBIT, fee), Posting(LedgerCode.CASH, Direction.CREDIT, fee)]
            txn = await self.ledger.post(acct, TransactionType.TRADE_BUY, postings, created_by=order.user_id,
                                         description=f"Buy {_fmt(qty)} {inst.symbol} @ {_fmt(px.quantize(Q8))}")
            if pos is None:
                pos = Position(account_id=acct.id, instrument_id=inst.id, symbol=inst.symbol, quantity=qty,
                               avg_price=px, cost_basis=notional, fees=fee, opened_at=now)
                self.db.add(pos)
            else:
                total = pos.quantity + qty
                pos.avg_price = (pos.avg_price * pos.quantity + px * qty) / total
                pos.quantity, pos.cost_basis, pos.fees = total, pos.cost_basis + notional, pos.fees + fee
        else:
            if pos is None or qty > pos.quantity:
                await self._reject(order, "position changed: insufficient quantity at fill time")
                return None
            cost = pos.cost_basis if qty == pos.quantity else _q8(pos.cost_basis * qty / pos.quantity)
            realised = notional - cost
            postings = [Posting(LedgerCode.CASH, Direction.DEBIT, notional),
                        Posting(LedgerCode.INVESTMENTS, Direction.CREDIT, cost)]
            if realised > 0:
                postings.append(Posting(LedgerCode.REALISED_PNL, Direction.CREDIT, realised))
            elif realised < 0:
                postings.append(Posting(LedgerCode.REALISED_PNL, Direction.DEBIT, -realised))
            if fee > 0:
                postings += [Posting(LedgerCode.FEES, Direction.DEBIT, fee), Posting(LedgerCode.CASH, Direction.CREDIT, fee)]
            txn = await self.ledger.post(acct, TransactionType.TRADE_SELL, postings, created_by=order.user_id,
                                         description=f"Sell {_fmt(qty)} {inst.symbol} @ {_fmt(px.quantize(Q8))}")
            pos.quantity -= qty
            pos.cost_basis -= cost
            pos.realised_pnl += realised
            pos.fees += fee
            if pos.quantity == 0:
                pos.status, pos.closed_at = "CLOSED", now

        exe = Execution(order_id=order.id, account_id=acct.id, symbol=inst.symbol, side=order.side, quantity=qty,
                        price=px, reference_price=fill.reference, mid_price=mid, fx_rate=fx, fee=fee,
                        spread_cost=spread_cost, slippage_cost=slip_cost, realised_pnl=realised,
                        ledger_transaction_id=txn.id, executed_at=now)
        self.db.add(exe)
        order.status, order.filled_qty, order.avg_fill_price = OrderStatus.FILLED, qty, px
        self._event(order, "FILLED", price=px, quantity=qty, fee=fee, reference=fill.reference)
        await self.db.flush()
        if order.oco_group is not None:
            await self._cancel_where("one-cancels-other: sibling filled", Order.oco_group == order.oco_group,
                                     Order.id != order.id, event="OCO_CANCELLED")
        if order.side == "BUY" and (order.stop_loss is not None or order.take_profit is not None):
            await self._spawn_brackets(acct, inst, order)
        if order.side == "SELL":
            await self._sync_protective(acct.id, inst.symbol, pos.quantity)
        summary = await self.snapshot(acct, "fill")
        await self.risk.metrics(acct, summary)
        return exe

    async def _cancel_where(self, reason: str, *where, event: str = "CANCELLED") -> int:
        n = 0
        for o in await self.db.scalars(select(Order).where(Order.status == OrderStatus.OPEN, *where).with_for_update()):
            o.status, o.reject_reason = OrderStatus.CANCELLED, reason
            self._event(o, event, reason=reason)
            n += 1
        await self.db.flush()
        return n

    async def _spawn_brackets(self, acct: TradingAccount, inst: Instrument, parent: Order) -> None:
        group = uuid.uuid4() if parent.stop_loss is not None and parent.take_profit is not None else None
        expires = datetime.now(UTC) + timedelta(days=GTC_DAYS)
        legs = []
        if parent.stop_loss is not None:
            legs.append(("STOP", None, parent.stop_loss))
        if parent.take_profit is not None:
            legs.append(("LIMIT", parent.take_profit, None))
        for type_, limit, stop in legs:
            child = Order(account_id=acct.id, user_id=parent.user_id, instrument_id=inst.id, symbol=inst.symbol,
                          side="SELL", type=type_, quantity=parent.quantity, limit_price=limit, stop_price=stop,
                          time_in_force="GTC", status=OrderStatus.OPEN, source="protective", expires_at=expires,
                          parent_order_id=parent.id, oco_group=group, proposal_id=parent.proposal_id)
            self.db.add(child)
            await self.db.flush()
            self._event(child, "CREATED", side="SELL", type=type_, quantity=parent.quantity, limit_price=limit,
                        stop_price=stop, parent=str(parent.id), source="protective")
            self._event(child, "ACCEPTED", expires_at=expires.isoformat())
            self._event(parent, "BRACKET_PLACED", child=str(child.id), type=type_, price=limit or stop)
        await self.db.flush()

    async def _sync_protective(self, account_id: uuid.UUID, symbol: str, remaining: Decimal) -> None:
        """Keep protective orders no larger than the position they protect."""
        rows = await self.db.scalars(select(Order).where(
            Order.account_id == account_id, Order.symbol == symbol, Order.side == "SELL",
            Order.source == "protective", Order.status == OrderStatus.OPEN).with_for_update())
        for o in rows:
            if remaining <= 0:
                o.status, o.reject_reason = OrderStatus.CANCELLED, "position closed"
                self._event(o, "CANCELLED", reason="position closed")
            elif o.quantity > remaining:
                o.quantity = remaining
                self._event(o, "RESIZED", quantity=remaining)
        await self.db.flush()

    # -- cancel / match ------------------------------------------------------------------
    async def cancel(self, user: User, order_id: uuid.UUID) -> Order:
        order = await self.db.scalar(select(Order).where(Order.id == order_id, Order.user_id == user.id)
                                     .with_for_update())
        if order is None:
            raise NotFound("Order not found")
        if order.status != OrderStatus.OPEN:
            raise BusinessRuleViolation(f"Only open orders can be cancelled (status {order.status})")
        order.status = OrderStatus.CANCELLED
        self._event(order, "CANCELLED", by="user")
        await self.db.flush()
        return order

    async def process_open(self) -> dict[str, int]:
        """The matcher: expire stale orders and fill triggered limit/stop orders."""
        now = datetime.now(UTC)
        stats = {"checked": 0, "filled": 0, "expired": 0, "rejected": 0}
        orders = list(await self.db.scalars(select(Order).where(Order.status == OrderStatus.OPEN)
                                            .order_by(Order.created_at).with_for_update(skip_locked=True)))
        for order in orders:
            stats["checked"] += 1
            if order.expires_at and order.expires_at <= now:
                order.status = OrderStatus.EXPIRED
                self._event(order, "EXPIRED")
                stats["expired"] += 1
                continue
            if order.side == "BUY":
                block = await self.risk.block_reason(await self.risk.profile(order.account_id))
                if block:
                    order.status, order.reject_reason = OrderStatus.CANCELLED, f"risk: {block}"
                    self._event(order, "CANCELLED", by="risk", reason=block)
                    stats["rejected"] += 1
                    continue
            elif order.source == "protective" and await self._position(order.account_id, order.symbol) is None:
                order.status, order.reject_reason = OrderStatus.CANCELLED, "position closed"
                self._event(order, "CANCELLED", reason="position closed")
                continue
            inst = await self.db.get(Instrument, order.instrument_id)
            try:
                q = await self.market.quote(inst)
            except ProviderUnavailable:
                continue
            if not q.tradable:
                continue
            fill = ex.match(order.side, order.type, q.bid, q.ask, order.limit_price, order.stop_price,
                            ex.slippage(inst.asset_class))
            if fill is None:
                continue
            acct = await self._account(None, order.account_id, lock=True)
            exe = await self._fill(acct, inst, order, fill, q.bid, q.ask)
            stats["filled" if exe else "rejected"] += 1
        await self.db.flush()
        return stats

    # -- portfolio --------------------------------------------------------------------------
    async def snapshot(self, acct: TradingAccount, reason: str) -> dict[str, Any]:
        s = await self.summary(acct, take_snapshot=False)
        self.db.add(PortfolioSnapshot(account_id=acct.id, taken_at=datetime.now(UTC), cash=s["cash"],
                                      market_value=s["market_value"], equity=s["equity"], reason=reason))
        await self.db.flush()
        return s

    async def monitor(self) -> int:
        """Re-value accounts with open positions so breakers trip between orders too."""
        ids = list(await self.db.scalars(select(Position.account_id).where(Position.status == "OPEN").distinct()))
        for aid in ids:
            acct = await self._account(None, aid, lock=True)
            # summary() also takes an hourly snapshot, which feeds the analytics equity series
            await self.risk.metrics(acct, await self.summary(acct, take_snapshot=True))
        await self.db.flush()
        return len(ids)

    async def summary(self, acct: TradingAccount, take_snapshot: bool = True) -> dict[str, Any]:
        lines = (await self.ledger.balances([acct.id]))[acct.id]
        led = {ln["code"]: ln["balance"] for ln in lines}
        positions = list(await self.db.scalars(select(Position).where(Position.account_id == acct.id,
                                                                      Position.status == "OPEN")
                                               .order_by(Position.opened_at)))
        rows, mv_total, by_class = [], Decimal(0), {}
        for p in positions:
            inst = await self.db.get(Instrument, p.instrument_id)
            fx = await fx_rate(self.market, inst.quote_currency, acct.base_currency) or Decimal(0)
            try:
                q = await self.market.quote(inst)
                bid, last, as_of, stale = q.bid, q.last, q.as_of, q.stale
            except ProviderUnavailable:
                bid = last = p.avg_price
                as_of, stale = None, True
            mv = _q8(p.quantity * bid * fx)
            mv_total += mv
            by_class[inst.asset_class] = by_class.get(inst.asset_class, Decimal(0)) + mv
            rows.append({
                "id": p.id, "symbol": p.symbol, "asset_class": inst.asset_class, "quantity": p.quantity,
                "avg_price": p.avg_price, "last": last, "bid": bid, "quote_currency": inst.quote_currency,
                "fx_rate": fx, "cost_basis": p.cost_basis, "market_value": mv,
                "unrealised_pnl": mv - p.cost_basis,
                "unrealised_pct": float((mv - p.cost_basis) / p.cost_basis) if p.cost_basis else 0.0,
                "realised_pnl": p.realised_pnl, "fees": p.fees, "opened_at": p.opened_at,
                "price_as_of": as_of, "stale": stale, "price_decimals": inst.price_decimals,
            })
        # open binary contracts are carried at their stake (cost) until they settle
        binary_at_risk = Decimal(await self.db.scalar(select(func.coalesce(func.sum(BinaryContract.stake), 0)).where(
            BinaryContract.account_id == acct.id, BinaryContract.status == BinaryStatus.OPEN)))
        if binary_at_risk:
            mv_total += binary_at_risk
            by_class["BINARY"] = binary_at_risk
        cash = led.get(LedgerCode.CASH, Decimal(0))
        equity = cash + mv_total
        out = {
            "account_id": acct.id, "account_name": acct.name, "currency": acct.base_currency, "cash": cash,
            "investments_at_cost": led.get(LedgerCode.INVESTMENTS, Decimal(0)), "market_value": mv_total,
            "equity": equity, "unrealised_pnl": mv_total - led.get(LedgerCode.INVESTMENTS, Decimal(0)),
            "realised_pnl": led.get(LedgerCode.REALISED_PNL, Decimal(0)), "fees": led.get(LedgerCode.FEES, Decimal(0)),
            "exposure": float(mv_total / equity) if equity else 0.0, "open_positions": len(rows),
            "allocation": {k: float(v / equity) if equity else 0.0 for k, v in by_class.items()},
            "positions": rows, "binary_at_risk": binary_at_risk,
            "available_cash": cash - await self._reserved(acct.id),
        }
        if take_snapshot:
            last = await self.db.scalar(select(func.max(PortfolioSnapshot.taken_at)).where(
                PortfolioSnapshot.account_id == acct.id))
            if last is None or datetime.now(UTC) - last > timedelta(hours=1):
                self.db.add(PortfolioSnapshot(account_id=acct.id, taken_at=datetime.now(UTC), cash=cash,
                                              market_value=mv_total, equity=equity, reason="periodic"))
                await self.db.flush()
        return out


