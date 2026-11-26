"""Chief orchestrator: builds one immutable context snapshot, runs every enabled agent
against it (isolating failures), asks the consensus engine for a decision and persists
the whole run (findings, reasons, proposal) for audit and explanation."""

import time
import uuid
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents import specialists as sp
from app.agents.base import (
    AccountSnap,
    AgentContext,
    Bar,
    DocSignal,
    Finding,
    InstrumentSnap,
    QuoteSnap,
)
from app.agents.consensus import decide
from app.core.errors import BusinessRuleViolation, NotFound
from app.market.positioning import PositioningService
from app.market.service import MarketService, ProviderUnavailable, fx_rate
from app.models import (
    AccountStatus,
    AIAgent,
    AIFinding,
    AIRun,
    Instrument,
    MLModel,
    ResearchDocument,
    TradeProposal,
    TradingAccount,
    User,
)
from app.research.fundamentals import FundamentalService
from app.services.ledger_service import LedgerService

ORDER = ["technical", "quant", "regime", "fundamental", "news", "sentiment", "ml", "portfolio", "risk"]


class Orchestrator:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.market = MarketService(db)

    # -- context ------------------------------------------------------------------------
    async def _account(self, user: User, account_id: uuid.UUID | None) -> AccountSnap | None:
        stmt = select(TradingAccount).where(TradingAccount.owner_id == user.id,
                                            TradingAccount.status == AccountStatus.ACTIVE)
        if account_id:
            stmt = stmt.where(TradingAccount.id == account_id)
        acct = await self.db.scalar(stmt.order_by(TradingAccount.created_at).limit(1))
        if acct is None:
            if account_id:
                raise NotFound("Trading account not found")
            return None
        summary = LedgerService.summarise((await LedgerService(self.db).balances([acct.id]))[acct.id])
        return AccountSnap(str(acct.id), acct.base_currency, summary["equity"], summary["cash"])

    async def _fx(self, src: str, dst: str) -> float | None:
        r = await fx_rate(self.market, src, dst)
        return None if r is None else float(r)

    async def _docs(self, inst: Instrument, now: datetime) -> tuple[list[DocSignal], list[DocSignal]]:
        def sig(d: ResearchDocument) -> DocSignal:
            age = (now - d.published_at).total_seconds() / 86400 if d.published_at else 9999
            return DocSignal(d.title, d.doc_type, age, d.sentiment, d.is_sample)

        since = now - timedelta(days=400)
        tagged = await self.db.scalars(select(ResearchDocument).where(
            ResearchDocument.symbols.any(inst.symbol), ResearchDocument.published_at >= since))
        macro: list[DocSignal] = []
        if inst.asset_class in ("FX", "ETF"):
            rows = await self.db.scalars(select(ResearchDocument).where(
                or_(ResearchDocument.doc_type == "central_bank",
                    ResearchDocument.doc_type == "economic_data"),
                ResearchDocument.published_at >= now - timedelta(days=30)))
            macro = [sig(d) for d in rows]
        return [sig(d) for d in tagged], macro

    async def build_context(self, user: User, symbol: str,
                            account_id: uuid.UUID | None) -> AgentContext:
        inst = await self.market.get(symbol)
        now = datetime.now(UTC)

        def bars(rows) -> list[Bar]:
            return [Bar(r.open_time, float(r.open), float(r.high), float(r.low), float(r.close))
                    for r in rows]

        try:
            b1h = bars(await self.market.candles(inst, "1h", 300))
            b1d = bars(await self.market.candles(inst, "1d", 250))
        except ProviderUnavailable:
            b1h, b1d = [], []
        try:
            q = await self.market.quote(inst)
            quote = QuoteSnap(float(q.last), float(q.bid), float(q.ask), q.market_open, q.stale,
                              q.tradable, q.source, q.as_of)
        except ProviderUnavailable:
            quote = None
        fundamentals = None
        if inst.asset_class in ("STOCK", "ETF"):
            try:
                analysis = await FundamentalService().analyse(
                    inst, float(q.last) if quote else None, self.db)
                fundamentals = analysis.as_dict()
            except Exception:  # noqa: BLE001 - optional analysis must not sink an AI run
                fundamentals = None
        account = await self._account(user, account_id)
        fx = await self._fx(inst.quote_currency, account.currency) if account else None
        docs, macro = await self._docs(inst, now)
        try:
            pos = await PositioningService().snapshot(inst.symbol)
        except Exception:  # noqa: BLE001 - an optional feed must never sink an AI run
            pos = None
        return AgentContext(
            InstrumentSnap(inst.symbol, inst.asset_class, inst.market, inst.quote_currency,
                           inst.price_decimals, inst.lot_size),
            now, b1h, b1d, quote, docs, macro, account, fx, open_positions=0,
            ml=await self._ml(inst.symbol, b1h),
            positioning=pos.as_dict() if pos else None,
            fundamentals=fundamentals)

    async def _ml(self, symbol: str, bars: list[Bar]) -> dict[str, Any] | None:
        from app.ml.service import ArtifactIntegrityError, MLService

        svc = MLService(self.db)
        champ = await svc.champion(symbol)
        if champ is None:
            return None
        oos = champ.metrics.get("oos", {})
        out: dict[str, Any] = {
            "version": champ.version, "name": (await self.db.get(MLModel, champ.model_id)).name,
            "eligible": champ.eligible,
            "note": champ.eligibility_note, "horizon": champ.metrics.get("horizon"),
            "auc": oos.get("auc", 0.0), "brier": oos.get("brier", 0.0), "data_source": champ.data_source,
            "probability": None,
        }
        if champ.eligible and bars:
            try:
                out["probability"] = await svc.predict_latest(
                    champ, [b.t for b in bars], [b.h for b in bars], [b.l for b in bars], [b.c for b in bars])
            except ArtifactIntegrityError:
                out["eligible"], out["note"] = False, "model artifact failed its integrity check"
        return out

    # -- run ------------------------------------------------------------------------------
    @staticmethod
    def run_agents(ctx: AgentContext, enabled: set[str]) -> tuple[dict[str, Finding], dict[str, int]]:
        findings: dict[str, Finding] = {}
        timings: dict[str, int] = {}

        def call(name: str, fn, *args) -> None:
            t0 = time.perf_counter()
            if name not in enabled:
                findings[name] = Finding.abstain(name, "Agent disabled by an administrator")
            else:
                try:
                    findings[name] = fn(*args)
                except Exception as e:  # noqa: BLE001 - one agent must not sink the run
                    findings[name] = Finding(name, "error", summary=f"Agent failed: {e.__class__.__name__}")
            timings[name] = int((time.perf_counter() - t0) * 1000)

        call("technical", sp.technical, ctx)
        call("quant", sp.quant, ctx)
        call("regime", sp.regime, ctx)
        call("fundamental", sp.fundamental, ctx)
        call("news", sp.news, ctx)
        call("sentiment", sp.sentiment, ctx)
        call("ml", sp.ml_model, ctx)
        call("portfolio", sp.portfolio, ctx, findings["technical"].data.get("atr_1h"))
        call("risk", sp.risk_precheck, ctx, findings["regime"], findings["news"],
             findings["portfolio"])
        return findings, timings

    async def run(self, user: User, symbol: str, account_id: uuid.UUID | None) -> AIRun:
        started = datetime.now(UTC)
        t0 = time.perf_counter()
        ctx = await self.build_context(user, symbol, account_id)
        agents = {a.name: a for a in await self.db.scalars(select(AIAgent))}
        enabled = {n for n, a in agents.items() if a.enabled}
        weights = {n: a.weight for n, a in agents.items() if a.kind == "directional" and a.enabled}
        if not weights:
            raise BusinessRuleViolation("All directional agents are disabled")
        findings, timings = self.run_agents(ctx, enabled)
        d = decide(ctx, findings, weights)
        finished = datetime.now(UTC)

        run = AIRun(
            user_id=user.id, account_id=uuid.UUID(ctx.account.id) if ctx.account else None,
            symbol=ctx.instrument.symbol, decision=d.decision, bias=d.bias,
            net_score=d.net_score, agreement=d.agreement, coverage=d.coverage,
            confidence=d.confidence, reasons=d.reasons, weights=d.weights,
            context=self._snapshot(ctx), started_at=started, finished_at=finished,
            latency_ms=int((time.perf_counter() - t0) * 1000))
        self.db.add(run)
        await self.db.flush()
        for i, name in enumerate(ORDER):
            f = findings[name]
            self.db.add(AIFinding(
                run_id=run.id, ordinal=i, agent=name, status=f.status, direction=f.direction,
                score=f.score, confidence=f.confidence, summary=f.summary,
                evidence=[asdict(e) for e in f.evidence], duration_ms=timings[name]))
        if d.proposal:
            p = d.proposal
            self.db.add(TradeProposal(
                run_id=run.id, user_id=user.id, account_id=uuid.UUID(ctx.account.id),
                symbol=p["symbol"], direction=p["direction"], strategy_id=p["strategy_id"],
                entry_type=p["entry_type"], entry_price=p["entry_price"], stop_loss=p["stop_loss"],
                take_profit=p["take_profit"], quantity=p["quantity"], notional=p["notional"],
                risk_amount=p["risk_amount"], account_currency=ctx.account.currency,
                confidence=p["confidence"], reward_risk=p["reward_risk"],
                invalidation_conditions=p["invalidation_conditions"],
                risk_check_required=True, expires_at=p["expires_at"]))
        await self.db.flush()
        await self.db.refresh(run, ["findings", "proposal"])
        return run

    @staticmethod
    def _snapshot(ctx: AgentContext) -> dict[str, Any]:
        q = ctx.quote
        return {
            "as_of": ctx.now.isoformat(),
            "quote": None if q is None else {
                "last": q.last, "bid": q.bid, "ask": q.ask, "source": q.source,
                "market_open": q.market_open, "stale": q.stale, "tradable": q.tradable,
                "as_of": q.as_of.isoformat()},
            "bars_1h": len(ctx.bars_1h), "bars_1d": len(ctx.bars_1d),
            "last_bar": ctx.bars_1h[-1].t.isoformat() if ctx.bars_1h else None,
            "research_docs": len(ctx.docs), "macro_docs": len(ctx.macro_docs),
            "account": None if ctx.account is None else {
                "id": ctx.account.id, "currency": ctx.account.currency,
                "equity": str(ctx.account.equity), "cash": str(ctx.account.cash)},
            "fx_to_account": ctx.fx_to_account,
            "ml_champion": None if ctx.ml is None
            else {k: ctx.ml[k] for k in ("name", "version", "eligible")},
            "open_positions": ctx.open_positions,
        }


