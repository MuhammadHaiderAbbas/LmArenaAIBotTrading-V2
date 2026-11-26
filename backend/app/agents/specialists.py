"""Specialist agents.

Every agent is a pure function of an AgentContext snapshot -> Finding. They report
evidence and their own uncertainty; none of them can place or approve an order. The
algorithms are deliberately transparent so every output can be explained.
"""

import math
from decimal import ROUND_DOWN, Decimal

from app.agents import stats as st
from app.agents.base import AgentContext, Evidence, Finding
from app.core.config import get_settings
from app.market import indicators as ind

MIN_BARS = 60
RISK_PER_TRADE = Decimal("0.005")       # 0.5% of equity (blueprint development default)
MAX_POSITION_PCT = Decimal("0.20")      # notional cap per position
MAX_SPREAD_BPS = {"CRYPTO": 10.0, "FX": 3.0, "STOCK": 10.0, "ETF": 5.0}
STOP_ATR, TARGET_ATR = 2.0, 3.0


def _qty(q: Decimal) -> str:
    return format(q.normalize(), "f") if q else "0"


def _f(x: float, nd: int = 2) -> str:
    return f"{x:.{nd}f}"


# --- technical -----------------------------------------------------------------------
def technical(ctx: AgentContext) -> Finding:
    bars = ctx.bars_1h
    if len(bars) < MIN_BARS:
        return Finding.abstain("technical", f"Needs at least {MIN_BARS} hourly candles ({len(bars)} available)")
    closes = [b.c for b in bars]
    a = st.atr([b.h for b in bars], [b.l for b in bars], closes)
    sma20, sma50 = ind.sma(closes, 20)[-1], ind.sma(closes, 50)[-1]
    rsi = ind.rsi(closes, 14)[-1]
    hist = ind.macd(closes)["histogram"][-1]
    bb = ind.bollinger(closes, 20)
    up, lo = bb["upper"][-1], bb["lower"][-1]
    if sma20 is None or sma50 is None or rsi is None:   # explicit: asserts vanish under python -O
        raise ValueError("indicator warm-up incomplete")
    trend = st.clip((sma20 - sma50) / a) if a else 0.0
    macd_c = st.clip((hist or 0.0) / a * 4) if a else 0.0
    rsi_c = st.clip((rsi - 50) / 20)
    pct_b = (closes[-1] - lo) / (up - lo) if up is not None and lo is not None and up > lo else 0.5
    score = 0.5 * trend + 0.25 * macd_c + 0.25 * rsi_c
    notes = []
    if rsi > 75 and score > 0:
        score -= 0.3
        notes.append("overbought: RSI above 75 reduces the long signal")
    if rsi < 25 and score < 0:
        score += 0.3
        notes.append("oversold: RSI below 25 reduces the short signal")
    score = st.clip(score)
    comps = [math.copysign(1, x) for x in (trend, macd_c, rsi_c) if abs(x) > 0.05]
    agree = abs(sum(comps)) / len(comps) if comps else 0.0
    confidence = round(min(1.0, len(bars) / 200) * (0.4 + 0.6 * agree), 3)
    direction = 1 if score > 0.1 else -1 if score < -0.1 else 0
    word = {1: "bullish", -1: "bearish", 0: "neutral"}[direction]
    return Finding(
        "technical", "ok", direction, round(score, 3), confidence,
        f"Technical picture is {word}: SMA20 {'above' if sma20 > sma50 else 'below'} SMA50, "
        f"RSI {rsi:.0f}, MACD histogram {'positive' if (hist or 0) > 0 else 'negative'}."
        + (f" Note: {notes[0]}." if notes else ""),
        [Evidence("SMA20 − SMA50 (in ATRs)", _f(trend), "trend direction and strength"),
         Evidence("RSI(14)", _f(rsi, 1), "momentum; >70 overbought, <30 oversold"),
         Evidence("MACD histogram (in ATRs)", _f((hist or 0) / a if a else 0, 3), "momentum shift"),
         Evidence("Bollinger %B", _f(pct_b), "position inside the 20-bar band"),
         Evidence("ATR(14), 1h", _f(a, 6), "volatility used for stops")],
        {"atr_1h": a, "last_close": closes[-1]},
    )


# --- quant ----------------------------------------------------------------------------
def quant(ctx: AgentContext) -> Finding:
    closes = [b.c for b in ctx.bars_1h]
    rets = st.log_returns(closes)[-200:]
    if len(rets) < MIN_BARS:
        return Finding.abstain("quant", "Not enough return history for a drift estimate")
    mu, sigma, n = st.mean(rets), st.stdev(rets), len(rets)
    if sigma == 0:
        return Finding.abstain("quant", "Zero realised volatility; no statistical signal")
    t = mu / (sigma / math.sqrt(n))
    p_drift_up = st.norm_cdf(t)
    horizon = 24
    exp_ret = mu * horizon
    half = 1.96 * sigma * math.sqrt(horizon)
    sma50 = ind.sma(closes, 50)[-1] or closes[-1]
    price_sd = st.stdev(closes[-50:]) or 1e-12
    z = (closes[-1] - sma50) / price_sd
    score = st.clip(t / 3)
    notes = "price stretched more than 2σ from its 50-bar mean" if abs(z) > 2 else ""
    if notes and math.copysign(1, z) == math.copysign(1, score):
        score *= 0.5
    direction = 1 if score > 0.1 else -1 if score < -0.1 else 0
    confidence = round(min(1.0, n / 200) * 0.7, 3)   # a simple drift model: capped trust
    return Finding(
        "quant", "ok", direction, round(score, 3), confidence,
        f"Drift estimate over {n} hourly returns: t = {t:.2f} "
        f"(P(drift > 0) ≈ {p_drift_up:.0%}). 24h expected return {exp_ret * 100:+.2f}% "
        f"± {half * 100:.2f}% (95%)." + (f" {notes.capitalize()}." if notes else ""),
        [Evidence("Mean hourly log return", f"{mu * 100:+.4f}%"),
         Evidence("Hourly volatility", f"{sigma * 100:.4f}%"),
         Evidence("Drift t-statistic", _f(t), "|t| > 2 is conventionally notable"),
         Evidence("P(drift > 0)", f"{p_drift_up:.0%}", "probability the underlying drift is positive, not of the next move"),
         Evidence("24h forecast (95% interval)", f"{exp_ret * 100:+.2f}% ± {half * 100:.2f}%"),
         Evidence("Distance from 50-bar mean", f"{z:+.2f}σ", "mean-reversion pressure")],
        {"sigma_1h": sigma, "t_stat": t},
    )


# --- regime ---------------------------------------------------------------------------
def regime(ctx: AgentContext) -> Finding:
    """A gate, not a vote: decides whether trend-following is in its validated regime."""
    daily = [b.c for b in ctx.bars_1d]
    hourly_rets = st.log_returns([b.c for b in ctx.bars_1h])
    if len(daily) < 60 or len(hourly_rets) < 120:
        return Finding.abstain("regime", "Not enough history to classify the market regime")
    d_rets = st.log_returns(daily)
    vols = [st.stdev(d_rets[i - 20:i]) for i in range(20, len(d_rets) + 1)]
    current = vols[-1]
    pct = st.percentile_rank(vols[:-1], current)
    vol_label = ("extreme" if pct > 0.95 else "high" if pct > 0.8
                 else "low" if pct < 0.25 else "normal")
    er = st.efficiency_ratio(daily[-31:])
    trend_label = "trending" if er > 0.3 else "ranging" if er < 0.15 else "transitional"
    recent, base = hourly_rets[-60:], hourly_rets[-300:-60]
    d = st.ks_statistic(recent, base) if len(base) >= 60 else 0.0
    crit = st.ks_critical(len(recent), len(base)) if len(base) >= 60 else 1.0
    drift = d > crit
    gates = []
    if vol_label == "extreme":
        gates.append("volatility outside validated range (above 95th percentile)")
    if drift:
        gates.append("return distribution shift detected (KS test, α = 0.05)")
    suitability = max(0.0, min(1.0, er / 0.4)) * (0.5 if vol_label == "high" else 1.0)
    if gates:
        suitability = 0.0
    annual = current * math.sqrt(365 if ctx.instrument.asset_class == "CRYPTO" else 252)
    return Finding(
        "regime", "ok", 0, round(suitability, 3), round(min(1.0, len(vols) / 60), 3),
        f"Regime: {trend_label}, {vol_label} volatility (annualised ≈ {annual:.0%})."
        + (" Gate closed: " + "; ".join(gates) + "." if gates else " Trend strategies are within their validated regime."),
        [Evidence("20d realised vol percentile", f"{pct:.0%}", f"label: {vol_label}"),
         Evidence("Efficiency ratio (30d)", _f(er), ">0.30 trending, <0.15 ranging"),
         Evidence("KS distance recent vs base", f"{d:.3f} (critical {crit:.3f})",
                  "concept-drift check on hourly returns"),
         Evidence("Trend suitability", _f(suitability))],
        {"gates": gates, "vol_label": vol_label, "trend_label": trend_label, "drift": drift},
    )


# --- research-driven agents -------------------------------------------------------------
def _weighted_tone(docs, half_life_days: float) -> tuple[float, float]:
    ws = [math.exp(-d.age_days / half_life_days) for d in docs]
    total = sum(ws)
    tone = sum(w * d.sentiment for w, d in zip(ws, docs, strict=True)) / total if total else 0.0
    return tone, total


def news(ctx: AgentContext) -> Finding:
    recent = [d for d in ctx.docs if d.age_days <= 7 and d.doc_type in ("news", "analysis")]
    window = [d for d in (ctx.docs + ctx.macro_docs)
              if d.age_days <= 3 and d.doc_type in ("central_bank", "economic_data", "earnings")]
    event_risk = bool(window)
    if not recent:
        f = Finding.abstain("news", "No instrument-specific news or analysis in the last 7 days")
        f.data["event_risk"] = event_risk
        if event_risk:
            f.evidence.append(Evidence("High-impact event in window", window[0].title))
        return f
    tone, weight = _weighted_tone(recent, 3)
    score = st.clip(tone * 1.5)
    direction = 1 if score > 0.15 else -1 if score < -0.15 else 0
    sample = any(d.is_sample for d in recent)
    return Finding(
        "news", "ok", direction, round(score, 3), round(min(1.0, len(recent) / 3) * 0.6, 3),
        f"{len(recent)} recent item(s); recency-weighted tone {tone:+.2f}."
        + (" A high-impact event falls inside the 3-day window." if event_risk else "")
        + (" Includes fictional sample documents." if sample else ""),
        [Evidence(f"{d.doc_type} · {d.age_days:.0f}d", d.title, f"tone {d.sentiment:+.2f}")
         for d in recent[:5]]
        + ([Evidence("High-impact event in window", window[0].title)] if event_risk else []),
        {"event_risk": event_risk, "sample": sample},
    )


def sentiment(ctx: AgentContext) -> Finding:
    docs = [d for d in ctx.docs if d.age_days <= 30]
    if not docs and not ctx.positioning:
        return Finding.abstain("sentiment", "No research coverage or positioning feed in 30 days")
    tone, _ = _weighted_tone(docs, 10)
    score = st.clip(tone * 1.2)
    evidence = [Evidence("Documents (30d)", str(len(docs))), Evidence("Weighted tone", f"{tone:+.2f}")]
    note = "Lexical measure only."
    if ctx.positioning:
        # Crowded longs (positive funding) are a contrarian bearish tilt, and vice versa.
        funding_bps = float(ctx.positioning.get("funding_bps", 0.0))
        oi_pct = float(ctx.positioning.get("oi_change_pct", 0.0))
        tilt = -st.clip(funding_bps / 20) * 0.3
        score = st.clip(score + tilt)
        side = "longs" if funding_bps > 0 else "shorts" if funding_bps < 0 else "balanced"
        note = (f"Perp funding {funding_bps:+.2f} bps ({side}), open interest "
                f"{oi_pct:+.1f}% over the window; contrarian congestion tilt {tilt:+.2f} "
                f"from {ctx.positioning.get('source', 'venue')}.")
        evidence += [Evidence("Funding", f"{funding_bps:+.2f} bps"),
                     Evidence("Open interest", f"{oi_pct:+.1f}%")]
    direction = 1 if score > 0.15 else -1 if score < -0.15 else 0
    pos = sum(d.sentiment > 0.15 for d in docs)
    neg = sum(d.sentiment < -0.15 for d in docs)
    return Finding(
        "sentiment", "ok", direction, round(score, 3),
        round(min(1.0, len(docs) / 5) * 0.5 + (0.2 if ctx.positioning else 0.0), 3),
        f"Research tone over 30 days: {pos} positive, {neg} negative, "
        f"{len(docs) - pos - neg} neutral (weighted {tone:+.2f}). {note}",
        evidence,
    )


def fundamental(ctx: AgentContext) -> Finding:
    if ctx.instrument.asset_class not in ("STOCK", "ETF"):
        return Finding.abstain("fundamental", "Company fundamentals do not apply to this instrument")
    docs = [d for d in ctx.docs if d.doc_type in ("earnings", "filing") and d.age_days <= 400]
    ratios = (ctx.fundamentals or {}).get("ratios", {})
    if not docs and not ratios:
        return Finding.abstain("fundamental", "No earnings reports, filings or fundamental ratios available")
    tone, _ = _weighted_tone(docs, 90)
    score = st.clip(tone * 1.2)
    evidence = [Evidence(f"{d.doc_type} · {d.age_days:.0f}d", d.title, f"tone {d.sentiment:+.2f}")
                for d in docs[:5]]
    note = f"{len(docs)} earnings/filing document(s); weighted tone {tone:+.2f}."
    if ratios:
        # Conservative valuation/margin scoring; never a price target or a recommendation.
        pe, margin, debt = (ratios.get("pe_ratio"), ratios.get("net_margin"),
                            ratios.get("debt_to_equity"))
        tilt = 0.0
        if pe is not None:
            tilt += 0.2 if 0 < pe <= 15 else -0.2 if pe >= 35 else 0.0
        if margin is not None:
            tilt += 0.1 if margin > 0.15 else -0.2 if margin < 0 else 0.0
        if debt is not None and debt > 2:
            tilt -= 0.1
        score = st.clip(score + tilt)
        source = (ctx.fundamentals or {}).get("source", "unknown")
        note += (f" Ratios from {source}: P/E {pe:.1f}" if pe is not None else
                 f" Ratios from {source}") + (
            f", net margin {margin:.1%}" if margin is not None else "") + (
            f", debt/equity {debt:.2f}" if debt is not None else "") + (
            f"; valuation tilt {tilt:+.2f}.")
        evidence.append(Evidence("Fundamental source", source))
        for key in ("pe_ratio", "net_margin", "debt_to_equity"):
            if key in ratios:
                evidence.append(Evidence(key, f"{ratios[key]:.4f}"))
    direction = 1 if score > 0.15 else -1 if score < -0.15 else 0
    confidence = round(min(1.0, len(docs) / 2) * 0.5 + (0.2 if ratios else 0.0), 3)
    return Finding("fundamental", "ok", direction, round(score, 3), confidence, note, evidence)


def ml_model(ctx: AgentContext) -> Finding:
    m = ctx.ml
    if not m:
        return Finding.abstain("ml", "No promoted champion model for this instrument")
    if not m.get("eligible"):
        return Finding.abstain("ml", f"Champion v{m['version']} is not eligible: {m.get('note', '')}")
    p = m.get("probability")
    if p is None:
        return Finding.abstain("ml", "Not enough recent bars to compute model features")
    score = st.clip((p - 0.5) * 4)
    return Finding(
        "ml", "ok", 1 if p > 0.55 else -1 if p < 0.45 else 0, round(score, 3), 0.6,
        f"Champion {m['name']} v{m['version']}: P(up over {m['horizon']}h) = {p:.0%}. "
        f"Validated out-of-sample AUC {m['auc']:.2f}, Brier {m['brier']:.3f}.",
        [Evidence("P(up)", f"{p:.1%}", f"{m['horizon']}h horizon"),
         Evidence("Model", f"{m['name']} v{m['version']}", f"trained on {m['data_source']} data"),
         Evidence("Out-of-sample AUC", f"{m['auc']:.3f}"), Evidence("Out-of-sample Brier", f"{m['brier']:.4f}")],
    )


# --- portfolio & risk (gates) ------------------------------------------------------------
def portfolio(ctx: AgentContext, atr_1h: float | None) -> Finding:
    acct, q = ctx.account, ctx.quote
    if acct is None:
        return Finding.abstain("portfolio", "No active paper account to size against")
    if q is None or not atr_1h:
        return Finding.abstain("portfolio", "Needs a live quote and ATR to size a position")
    if ctx.fx_to_account is None:
        return Finding.abstain("portfolio", f"No FX rate from {ctx.instrument.quote_currency} to {acct.currency}")
    fx = Decimal(str(ctx.fx_to_account))
    entry = Decimal(str(q.ask))
    stop_dist = Decimal(str(STOP_ATR * atr_1h))
    risk_budget = acct.equity * RISK_PER_TRADE
    lot = ctx.instrument.lot_size
    qty = (risk_budget / (stop_dist * fx)) if stop_dist > 0 else Decimal(0)
    cap_qty = (min(acct.equity * MAX_POSITION_PCT, acct.cash) / (entry * fx)) if entry > 0 else Decimal(0)
    capped = qty > cap_qty
    qty = min(qty, cap_qty)
    qty = (qty / lot).to_integral_value(rounding=ROUND_DOWN) * lot
    notional = qty * entry * fx
    risk_amt = qty * stop_dist * fx
    minimum = Decimal(get_settings().min_order_value)
    ok = qty > 0 and notional >= minimum
    return Finding(
        "portfolio", "ok", 0, 1.0 if ok else 0.0, 1.0,
        (f"Size {_qty(qty)} units (≈ {notional:,.2f} {acct.currency}, "
         f"{notional / acct.equity:.1%} of equity), risking {risk_amt:,.2f} {acct.currency} "
         f"({risk_amt / acct.equity:.2%})." + (" Capped by the per-position / cash limit." if capped else ""))
        if ok else ("Position size rounds to zero within risk and cash limits." if qty <= 0 else
                    f"Position (≈ {notional:,.2f} {acct.currency}) is below the minimum order of {minimum:,.2f} {acct.currency}."),
        [Evidence("Equity", f"{acct.equity:,.2f} {acct.currency}"),
         Evidence("Risk budget (0.5%)", f"{risk_budget:,.2f} {acct.currency}"),
         Evidence("Stop distance (2 × ATR)", f"{stop_dist:.6f} {ctx.instrument.quote_currency}"),
         Evidence("Quantity", _qty(qty)),
         Evidence("Notional", f"{notional:,.2f} {acct.currency}", "no leverage: capped at cash and 20% of equity"),
         Evidence("Open positions", str(ctx.open_positions))],
        {"quantity": qty, "notional": notional, "risk_amount": risk_amt, "entry": entry,
         "stop_distance": stop_dist, "sized": ok},
    )


def risk_precheck(ctx: AgentContext, regime_f: Finding, news_f: Finding,
                  portfolio_f: Finding) -> Finding:
    """Advisory pre-check. The independent risk engine (app/risk) has final authority."""
    reasons: list[str] = []
    q = ctx.quote
    spread_bps = None
    if q is None:
        reasons.append("no quote available")
    else:
        if not q.market_open:
            reasons.append("market is closed")
        if q.stale:
            reasons.append("quote is stale")
        if not q.tradable:
            reasons.append(f"quote source '{q.source}' is not tradable")
        mid = (q.bid + q.ask) / 2
        spread_bps = (q.ask - q.bid) / mid * 1e4 if mid else None
        limit = MAX_SPREAD_BPS[ctx.instrument.asset_class]
        if spread_bps is not None and spread_bps > limit:
            reasons.append(f"spread {spread_bps:.1f} bps exceeds {limit:.0f} bps")
    reasons += list(regime_f.data.get("gates", []))
    if news_f.data.get("event_risk"):
        reasons.append("high-impact event inside the 3-day window")
    if portfolio_f.status != "ok" or not portfolio_f.data.get("sized"):
        reasons.append("position cannot be sized within limits")
    if ctx.open_positions >= 5:
        reasons.append("maximum of 5 open positions reached")
    ok = not reasons
    return Finding(
        "risk", "ok", 0, 1.0 if ok else 0.0, 1.0,
        ("Pre-check passed. " if ok else "Pre-check failed: " + "; ".join(reasons) + ". ")
        + "Advisory only; the independent risk engine has final authority over any order.",
        [Evidence("Market open", str(q.market_open) if q else "—"),
         Evidence("Quote stale", str(q.stale) if q else "—"),
         Evidence("Spread", f"{spread_bps:.2f} bps" if spread_bps is not None else "—",
                  f"limit {MAX_SPREAD_BPS[ctx.instrument.asset_class]:.0f} bps"),
         Evidence("Leverage", "0 (spot paper trading)"),
         Evidence("Max risk per trade", "0.5% of equity")],
        {"approved": ok, "reasons": reasons},
    )
