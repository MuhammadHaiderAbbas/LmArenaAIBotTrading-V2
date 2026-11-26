"""Unit tests for the specialist agents and the consensus engine (pure functions)."""

import math
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from app.agents import specialists as sp
from app.agents.base import AccountSnap, AgentContext, Bar, DocSignal, Finding, InstrumentSnap, QuoteSnap
from app.agents.consensus import decide
from app.agents.orchestrator import Orchestrator

NOW = datetime(2026, 11, 23, 12, tzinfo=UTC)
BTC = InstrumentSnap("BTC-USD", "CRYPTO", "CRYPTO_24_7", "USD", 2, Decimal("0.00000001"))
SHEL = InstrumentSnap("SHEL.L", "STOCK", "UK_EQUITY", "GBP", 2, Decimal("1"))
ALL = {"technical", "quant", "regime", "fundamental", "news", "sentiment", "portfolio", "risk"}


def series(n: int, start: float, drift: float, wobble: float, step: timedelta, vol_tail: float = 0.0,
           seed: int = 7) -> list[Bar]:
    bars, p = [], start
    for i in range(n):
        noise = wobble * math.sin(i * 1.7 + seed) + wobble * 0.5 * math.sin(i * 0.37)
        if vol_tail and i > n - 20:
            noise += vol_tail * (1 if i % 2 else -1)
        o = p
        p = p * (1 + drift + noise)
        hi, lo = max(o, p) * 1.001, min(o, p) * 0.999
        bars.append(Bar(NOW - step * (n - i), o, hi, lo, p))
    return bars


def quote(last: float, *, open_=True, stale=False, tradable=True, spread=0.0002) -> QuoteSnap:
    return QuoteSnap(last, last * (1 - spread / 2), last * (1 + spread / 2), open_, stale, tradable,
                     "synthetic", NOW)


def ctx(h1: list[Bar], d1: list[Bar], *, inst=BTC, q: QuoteSnap | None = None, docs=(), macro=(),
        account=True, fx=1.0, positioning=None, fundamentals=None) -> AgentContext:
    acct = AccountSnap("acct", "USD", Decimal("100000"), Decimal("100000")) if account else None
    return AgentContext(inst, NOW, h1, d1, q or quote(h1[-1].c), list(docs), list(macro), acct, fx,
                        positioning=positioning, fundamentals=fundamentals)


UP_H = series(300, 100, 0.0015, 0.002, timedelta(hours=1))
UP_D = series(250, 80, 0.002, 0.004, timedelta(days=1))
DOWN_H = series(300, 100, -0.0015, 0.002, timedelta(hours=1))
FLAT_H = series(300, 100, 0.0, 0.004, timedelta(hours=1))


def run(c: AgentContext, enabled=ALL):
    findings, _ = Orchestrator.run_agents(c, set(enabled))
    return findings, decide(c, findings)


def test_uptrend_produces_sized_buy_proposal():
    c = ctx(UP_H, UP_D)
    f, d = run(c)
    assert f["technical"].direction == 1 and f["quant"].direction == 1
    assert d.decision == "BUY" and d.reasons == [] and d.bias == "bullish"
    p = d.proposal
    assert p["direction"] == "BUY" and p["entry_type"] == "LIMIT" and p["risk_check_required"] is True
    assert p["stop_loss"] < p["entry_price"] < p["take_profit"]
    assert p["reward_risk"] == 1.5 and p["expires_at"] == NOW + timedelta(hours=4)
    assert p["risk_amount"] <= Decimal("500.00")          # 0.5% of 100k equity
    assert p["notional"] <= Decimal("20000.00")           # 20% per-position cap, no leverage
    assert p["quantity"] % BTC.lot_size == 0
    assert any("SMA20 crosses below SMA50" in x for x in p["invalidation_conditions"])
    assert 0 < d.confidence <= 1


def test_downtrend_is_bearish_but_never_shorts():
    f, d = run(ctx(DOWN_H, UP_D))
    assert d.bias == "bearish" and d.decision == "NO_TRADE" and d.proposal is None
    assert any("short selling is disabled" in r for r in d.reasons)


def test_flat_market_is_too_weak():
    _, d = run(ctx(FLAT_H, UP_D))
    assert d.decision == "NO_TRADE"
    assert any("signal too weak" in r for r in d.reasons)


@pytest.mark.parametrize("kw,reason", [
    ({"open_": False}, "market is closed"),
    ({"stale": True}, "quote is stale"),
    ({"tradable": False}, "is not tradable"),
    ({"spread": 0.01}, "exceeds 10 bps"),
])
def test_risk_precheck_blocks_unsafe_market_state(kw, reason):
    f, d = run(ctx(UP_H, UP_D, q=quote(UP_H[-1].c, **kw)))
    assert f["risk"].data["approved"] is False
    assert d.decision == "NO_TRADE" and any(reason in r for r in d.reasons)
    assert "final authority" in f["risk"].summary


def test_regime_gate_on_extreme_volatility_and_drift():
    wild_d = series(250, 80, 0.002, 0.004, timedelta(days=1), vol_tail=0.08)
    f, d = run(ctx(UP_H, wild_d))
    assert f["regime"].data["vol_label"] == "extreme"
    assert any("volatility outside validated range" in r for r in d.reasons)

    shifted = UP_H[:240] + series(60, UP_H[239].c, 0.0015, 0.03, timedelta(hours=1), seed=3)
    f, d = run(ctx(shifted, UP_D))
    assert f["regime"].data["drift"] is True
    assert any("distribution shift" in r for r in d.reasons) and d.decision == "NO_TRADE"


def test_insufficient_coverage_when_agents_abstain():
    f, d = run(ctx(UP_H[:30], UP_D[:30]))
    assert f["technical"].status == "abstain" and f["quant"].status == "abstain"
    assert any("insufficient agent coverage" in r for r in d.reasons)
    assert any("market regime could not be classified" in r for r in d.reasons)


def test_disagreement_blocks_trade():
    c = ctx(UP_H, UP_D)
    findings, _ = Orchestrator.run_agents(c, ALL)
    findings["quant"] = Finding("quant", "ok", -1, -0.9, 1.0)
    findings["news"] = Finding("news", "ok", -1, -1.0, 1.0)
    findings["sentiment"] = Finding("sentiment", "ok", -1, -1.0, 1.0)
    d = decide(c, findings)
    assert d.decision == "NO_TRADE" and any("agents disagree" in r for r in d.reasons)


def test_news_event_window_and_research_agents():
    docs = [DocSignal("Desk note", "analysis", 1, 0.6, False), DocSignal("Wire", "news", 2, 0.5, True)]
    macro = [DocSignal("Rate decision", "central_bank", 1, -0.2, False)]
    f, d = run(ctx(UP_H, UP_D, docs=docs, macro=macro))
    assert f["news"].direction == 1 and f["news"].data["event_risk"] is True
    assert "fictional sample" in f["news"].summary
    assert f["sentiment"].status == "ok"
    assert f["fundamental"].status == "abstain"  # crypto: fundamentals not applicable
    assert any("high-impact event" in r for r in d.reasons)


def test_portfolio_sizing_converts_currency_and_abstains_without_account():
    h = series(300, 25, 0.0015, 0.002, timedelta(hours=1))
    f, _ = run(ctx(h, UP_D, inst=SHEL, fx=1.27))
    pf = f["portfolio"].data
    assert pf["quantity"] == pf["quantity"].to_integral_value()   # whole shares
    assert pf["notional"] == pf["quantity"] * pf["entry"] * Decimal("1.27")
    f, d = run(ctx(UP_H, UP_D, account=False))
    assert f["portfolio"].status == "abstain"
    assert any("position cannot be sized" in r for r in d.reasons)
    f, _ = run(ctx(UP_H, UP_D, fx=None))
    assert f["portfolio"].status == "abstain" and "FX rate" in f["portfolio"].summary


def test_failing_or_disabled_agent_is_isolated(monkeypatch):
    def boom(_):
        raise RuntimeError("bad data")
    monkeypatch.setattr(sp, "technical", boom)
    f, d = run(ctx(UP_H, UP_D), enabled=ALL - {"news"})
    assert f["technical"].status == "error" and "RuntimeError" in f["technical"].summary
    assert f["news"].status == "abstain" and "disabled" in f["news"].summary
    assert f["quant"].status == "ok" and d.decision == "NO_TRADE"


def test_positioning_feed_tilts_sentiment_contrarian():
    pos = {"funding_bps": 20.0, "oi_change_pct": 12.0, "source": "binance_futures"}
    c = ctx(UP_H, UP_D, docs=(), positioning=pos)
    f, _ = run(c, {"sentiment"})
    assert f["sentiment"].status == "ok"
    assert "Perp funding +20.00 bps" in f["sentiment"].summary
    assert any(e.label == "Funding" for e in f["sentiment"].evidence)
    assert f["sentiment"].score < 0          # crowded longs are a bearish contrarian tilt
