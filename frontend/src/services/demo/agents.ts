/**
 * Browser port of backend/app/agents (specialists, consensus) for the static demo.
 * Same rules and thresholds; Decimal maths is replaced by float maths for display only.
 */
import { ema, rsi, sma } from "./market";

export interface Bar { t: string; o: number; h: number; l: number; c: number }
export interface DocSig { title: string; doc_type: string; age_days: number; sentiment: number; is_sample: boolean }
export interface Ctx {
  symbol: string; asset_class: string; quote_currency: string; price_decimals: number; lot_size: number;
  now: number; h1: Bar[]; d1: Bar[];
  quote: { last: number; bid: number; ask: number; market_open: boolean; stale: boolean; tradable: boolean; source: string } | null;
  docs: DocSig[]; macro: DocSig[];
  account: { id: string; currency: string; equity: number; cash: number } | null;
  fx: number | null; open_positions: number;
}
export interface Ev { label: string; value: string; detail: string }
export interface Finding {
  agent: string; status: "ok" | "abstain" | "error"; direction: -1 | 0 | 1; score: number; confidence: number;
  summary: string; evidence: Ev[]; duration_ms: number; data: Record<string, unknown>;
}

const clip = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdev = (xs: number[]) => { if (xs.length < 2) return 0; const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)); };
const logret = (c: number[]) => c.slice(1).map((b, i) => Math.log(b / c[i]!));
const erf = (x: number) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
const ncdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
function atr(b: Bar[], n = 14) {
  const tr = b.slice(1).map((x, i) => Math.max(x.h - x.l, Math.abs(x.h - b[i]!.c), Math.abs(x.l - b[i]!.c)));
  if (tr.length < n) return 0;
  let v = mean(tr.slice(0, n));
  for (const x of tr.slice(n)) v = (v * (n - 1) + x) / n;
  return v;
}
const er = (c: number[]) => { const path = c.slice(1).reduce((a, x, i) => a + Math.abs(x - c[i]!), 0); return path ? Math.abs(c[c.length - 1]! - c[0]!) / path : 0; };
function ks(a: number[], b: number[]) {
  a = [...a].sort((x, y) => x - y); b = [...b].sort((x, y) => x - y);
  let i = 0, j = 0, d = 0;
  while (i < a.length && j < b.length) { if (a[i]! <= b[j]!) i++; else j++; d = Math.max(d, Math.abs(i / a.length - j / b.length)); }
  return d;
}
const f2 = (x: number, n = 2) => x.toFixed(n);
const abstain = (agent: string, summary: string, data: Record<string, unknown> = {}): Finding => ({ agent, status: "abstain", direction: 0, score: 0, confidence: 0, summary, evidence: [], duration_ms: 0, data });
const dir = (s: number, t = 0.1): -1 | 0 | 1 => (s > t ? 1 : s < -t ? -1 : 0);

export function technical(c: Ctx): Finding {
  const b = c.h1;
  if (b.length < 60) return abstain("technical", `Needs at least 60 hourly candles (${b.length} available)`);
  const cl = b.map((x) => x.c), a = atr(b);
  const s20 = sma(cl, 20).at(-1)!, s50 = sma(cl, 50).at(-1)!, r = rsi(cl).at(-1)!;
  const line = ema(cl, 12).map((v, i) => (v != null && ema(cl, 26)[i] != null ? v - ema(cl, 26)[i]! : null));
  const start = line.findIndex((v) => v != null);
  const sig = ema(line.slice(start) as number[], 9);
  const hist = (line.at(-1) ?? 0) - (sig.at(-1) ?? 0);
  const mid = sma(cl, 20).at(-1)!, sd = stdev(cl.slice(-20)) * Math.sqrt(19 / 20);
  const pctB = sd ? (cl.at(-1)! - (mid - 2 * sd)) / (4 * sd) : 0.5;
  const trend = a ? clip((s20 - s50) / a) : 0, mc = a ? clip(hist / a * 4) : 0, rc = clip((r - 50) / 20);
  let score = 0.5 * trend + 0.25 * mc + 0.25 * rc; let note = "";
  if (r > 75 && score > 0) { score -= 0.3; note = "overbought: RSI above 75 reduces the long signal"; }
  if (r < 25 && score < 0) { score += 0.3; note = "oversold: RSI below 25 reduces the short signal"; }
  score = clip(score);
  const comps = [trend, mc, rc].filter((x) => Math.abs(x) > 0.05).map(Math.sign);
  const agree = comps.length ? Math.abs(comps.reduce((x, y) => x + y, 0)) / comps.length : 0;
  const d = dir(score);
  return {
    agent: "technical", status: "ok", direction: d, score: +score.toFixed(3), confidence: +(Math.min(1, b.length / 200) * (0.4 + 0.6 * agree)).toFixed(3),
    summary: `Technical picture is ${["bearish", "neutral", "bullish"][d + 1]}: SMA20 ${s20 > s50 ? "above" : "below"} SMA50, RSI ${r.toFixed(0)}, MACD histogram ${hist > 0 ? "positive" : "negative"}.${note ? ` Note: ${note}.` : ""}`,
    evidence: [
      { label: "SMA20 − SMA50 (in ATRs)", value: f2(trend), detail: "trend direction and strength" },
      { label: "RSI(14)", value: f2(r, 1), detail: "momentum; >70 overbought, <30 oversold" },
      { label: "MACD histogram (in ATRs)", value: f2(a ? hist / a : 0, 3), detail: "momentum shift" },
      { label: "Bollinger %B", value: f2(pctB), detail: "position inside the 20-bar band" },
      { label: "ATR(14), 1h", value: a.toFixed(6), detail: "volatility used for stops" },
    ],
    duration_ms: 0, data: { atr: a },
  };
}

export function quant(c: Ctx): Finding {
  const cl = c.h1.map((x) => x.c), r = logret(cl).slice(-200);
  if (r.length < 60) return abstain("quant", "Not enough return history for a drift estimate");
  const mu = mean(r), s = stdev(r), n = r.length;
  if (!s) return abstain("quant", "Zero realised volatility; no statistical signal");
  const t = mu / (s / Math.sqrt(n)), p = ncdf(t), exp = mu * 24, half = 1.96 * s * Math.sqrt(24);
  const s50 = sma(cl, 50).at(-1) ?? cl.at(-1)!, z = (cl.at(-1)! - s50) / (stdev(cl.slice(-50)) || 1e-12);
  let score = clip(t / 3);
  const stretched = Math.abs(z) > 2;
  if (stretched && Math.sign(z) === Math.sign(score)) score *= 0.5;
  return {
    agent: "quant", status: "ok", direction: dir(score), score: +score.toFixed(3), confidence: +(Math.min(1, n / 200) * 0.7).toFixed(3),
    summary: `Drift estimate over ${n} hourly returns: t = ${t.toFixed(2)} (P(drift > 0) ≈ ${(p * 100).toFixed(0)}%). 24h expected return ${(exp * 100).toFixed(2)}% ± ${(half * 100).toFixed(2)}% (95%).${stretched ? " Price stretched more than 2σ from its 50-bar mean." : ""}`,
    evidence: [
      { label: "Mean hourly log return", value: `${(mu * 100).toFixed(4)}%`, detail: "" },
      { label: "Hourly volatility", value: `${(s * 100).toFixed(4)}%`, detail: "" },
      { label: "Drift t-statistic", value: f2(t), detail: "|t| > 2 is conventionally notable" },
      { label: "P(drift > 0)", value: `${(p * 100).toFixed(0)}%`, detail: "probability the underlying drift is positive, not of the next move" },
      { label: "24h forecast (95% interval)", value: `${(exp * 100).toFixed(2)}% ± ${(half * 100).toFixed(2)}%`, detail: "" },
      { label: "Distance from 50-bar mean", value: `${z.toFixed(2)}σ`, detail: "mean-reversion pressure" },
    ],
    duration_ms: 0, data: {},
  };
}

export function regime(c: Ctx): Finding {
  const daily = c.d1.map((x) => x.c), hr = logret(c.h1.map((x) => x.c));
  if (daily.length < 60 || hr.length < 120) return abstain("regime", "Not enough history to classify the market regime");
  const dr = logret(daily);
  const vols: number[] = [];
  for (let i = 20; i <= dr.length; i++) vols.push(stdev(dr.slice(i - 20, i)));
  const cur = vols.at(-1)!, pct = vols.slice(0, -1).filter((v) => v <= cur).length / Math.max(1, vols.length - 1);
  const vl = pct > 0.95 ? "extreme" : pct > 0.8 ? "high" : pct < 0.25 ? "low" : "normal";
  const e = er(daily.slice(-31)), tl = e > 0.3 ? "trending" : e < 0.15 ? "ranging" : "transitional";
  const recent = hr.slice(-60), base = hr.slice(-300, -60);
  const D = base.length >= 60 ? ks(recent, base) : 0, crit = base.length >= 60 ? 1.358 * Math.sqrt((recent.length + base.length) / (recent.length * base.length)) : 1;
  const gates: string[] = [];
  if (vl === "extreme") gates.push("volatility outside validated range (above 95th percentile)");
  if (D > crit) gates.push("return distribution shift detected (KS test, α = 0.05)");
  let suit = Math.max(0, Math.min(1, e / 0.4)) * (vl === "high" ? 0.5 : 1);
  if (gates.length) suit = 0;
  const annual = cur * Math.sqrt(c.asset_class === "CRYPTO" ? 365 : 252);
  return {
    agent: "regime", status: "ok", direction: 0, score: +suit.toFixed(3), confidence: +Math.min(1, vols.length / 60).toFixed(3),
    summary: `Regime: ${tl}, ${vl} volatility (annualised ≈ ${(annual * 100).toFixed(0)}%).${gates.length ? ` Gate closed: ${gates.join("; ")}.` : " Trend strategies are within their validated regime."}`,
    evidence: [
      { label: "20d realised vol percentile", value: `${(pct * 100).toFixed(0)}%`, detail: `label: ${vl}` },
      { label: "Efficiency ratio (30d)", value: f2(e), detail: ">0.30 trending, <0.15 ranging" },
      { label: "KS distance recent vs base", value: `${D.toFixed(3)} (critical ${crit.toFixed(3)})`, detail: "concept-drift check on hourly returns" },
      { label: "Trend suitability", value: f2(suit), detail: "" },
    ],
    duration_ms: 0, data: { gates },
  };
}

function tone(docs: DocSig[], half: number) {
  const w = docs.map((d) => Math.exp(-d.age_days / half)), tot = w.reduce((a, b) => a + b, 0);
  return tot ? docs.reduce((a, d, i) => a + w[i]! * d.sentiment, 0) / tot : 0;
}
export function news(c: Ctx): Finding {
  const recent = c.docs.filter((d) => d.age_days <= 7 && (d.doc_type === "news" || d.doc_type === "analysis"));
  const win = [...c.docs, ...c.macro].filter((d) => d.age_days <= 3 && ["central_bank", "economic_data", "earnings"].includes(d.doc_type));
  const eventEv = win.length ? [{ label: "High-impact event in window", value: win[0]!.title, detail: "" }] : [];
  if (!recent.length) { const f = abstain("news", "No instrument-specific news or analysis in the last 7 days", { event_risk: win.length > 0 }); f.evidence = eventEv; return f; }
  const t = tone(recent, 3), score = clip(t * 1.5), sample = recent.some((d) => d.is_sample);
  return {
    agent: "news", status: "ok", direction: dir(score, 0.15), score: +score.toFixed(3), confidence: +(Math.min(1, recent.length / 3) * 0.6).toFixed(3),
    summary: `${recent.length} recent item(s); recency-weighted tone ${t >= 0 ? "+" : ""}${t.toFixed(2)}.${win.length ? " A high-impact event falls inside the 3-day window." : ""}${sample ? " Includes fictional sample documents." : ""}`,
    evidence: [...recent.slice(0, 5).map((d) => ({ label: `${d.doc_type} · ${d.age_days.toFixed(0)}d`, value: d.title, detail: `tone ${d.sentiment.toFixed(2)}` })), ...eventEv],
    duration_ms: 0, data: { event_risk: win.length > 0 },
  };
}
export function sentimentAgent(c: Ctx): Finding {
  const docs = c.docs.filter((d) => d.age_days <= 30);
  if (!docs.length) return abstain("sentiment", "No research coverage of this instrument in 30 days");
  const t = tone(docs, 10), score = clip(t * 1.2);
  const pos = docs.filter((d) => d.sentiment > 0.15).length, neg = docs.filter((d) => d.sentiment < -0.15).length;
  return {
    agent: "sentiment", status: "ok", direction: dir(score, 0.15), score: +score.toFixed(3), confidence: +(Math.min(1, docs.length / 5) * 0.5).toFixed(3),
    summary: `Research tone over 30 days: ${pos} positive, ${neg} negative, ${docs.length - pos - neg} neutral (weighted ${t >= 0 ? "+" : ""}${t.toFixed(2)}). Lexical measure only; no positioning data is connected yet.`,
    evidence: [{ label: "Documents (30d)", value: String(docs.length), detail: "" }, { label: "Weighted tone", value: t.toFixed(2), detail: "" }], duration_ms: 0, data: {},
  };
}
export function fundamental(c: Ctx): Finding {
  if (c.asset_class !== "STOCK" && c.asset_class !== "ETF") return abstain("fundamental", "Company fundamentals do not apply to this instrument");
  const docs = c.docs.filter((d) => (d.doc_type === "earnings" || d.doc_type === "filing") && d.age_days <= 400);
  if (!docs.length) return abstain("fundamental", "No earnings reports or filings for this instrument in the corpus");
  const t = tone(docs, 90), score = clip(t * 1.2);
  return {
    agent: "fundamental", status: "ok", direction: dir(score, 0.15), score: +score.toFixed(3), confidence: +(Math.min(1, docs.length / 2) * 0.5).toFixed(3),
    summary: `${docs.length} earnings/filing document(s); 90-day lexical tone ${t.toFixed(2)} from the demo corpus. Advisory signal only — no valuation model.`,
    evidence: docs.slice(0, 5).map((d) => ({ label: `${d.doc_type} · ${d.age_days.toFixed(0)}d`, value: d.title, detail: `tone ${d.sentiment.toFixed(2)}` })), duration_ms: 0, data: {},
  };
}
export function portfolio(c: Ctx, a: number | undefined): Finding {
  const acct = c.account, q = c.quote;
  if (!acct) return abstain("portfolio", "No active paper account to size against");
  if (!q || !a) return abstain("portfolio", "Needs a live quote and ATR to size a position");
  if (c.fx == null) return abstain("portfolio", `No FX rate from ${c.quote_currency} to ${acct.currency}`);
  const entry = q.ask, stop = 2 * a, budget = acct.equity * 0.005;
  let qty = stop > 0 ? budget / (stop * c.fx) : 0;
  const cap = Math.min(acct.equity * 0.2, acct.cash) / (entry * c.fx), capped = qty > cap;
  qty = Math.floor(Math.min(qty, cap) / c.lot_size) * c.lot_size;
  qty = +qty.toFixed(8);
  const notional = qty * entry * c.fx, risk = qty * stop * c.fx, ok = qty > 0 && notional >= 1;
  const m = (v: number) => v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return {
    agent: "portfolio", status: "ok", direction: 0, score: ok ? 1 : 0, confidence: 1,
    summary: ok ? `Size ${qty} units (≈ ${m(notional)} ${acct.currency}, ${(notional / acct.equity * 100).toFixed(1)}% of equity), risking ${m(risk)} ${acct.currency} (${(risk / acct.equity * 100).toFixed(2)}%).${capped ? " Capped by the per-position / cash limit." : ""}` : qty <= 0 ? "Position size rounds to zero within risk and cash limits." : `Position (≈ ${m(notional)} ${acct.currency}) is below the minimum order of 1.00 ${acct.currency}.`,
    evidence: [
      { label: "Equity", value: `${m(acct.equity)} ${acct.currency}`, detail: "" },
      { label: "Risk budget (0.5%)", value: `${m(budget)} ${acct.currency}`, detail: "" },
      { label: "Stop distance (2 × ATR)", value: `${stop.toFixed(6)} ${c.quote_currency}`, detail: "" },
      { label: "Quantity", value: String(qty), detail: "" },
      { label: "Notional", value: `${m(notional)} ${acct.currency}`, detail: "no leverage: capped at cash and 20% of equity" },
      { label: "Open positions", value: String(c.open_positions), detail: "" },
    ],
    duration_ms: 0, data: { qty, notional, risk, entry, stop, sized: ok },
  };
}
const MAX_SPREAD: Record<string, number> = { CRYPTO: 10, FX: 3, STOCK: 10, ETF: 5 };
export function riskCheck(c: Ctx, reg: Finding, nw: Finding, pf: Finding): Finding {
  const reasons: string[] = [], q = c.quote;
  let spread: number | null = null;
  if (!q) reasons.push("no quote available");
  else {
    if (!q.market_open) reasons.push("market is closed");
    if (q.stale) reasons.push("quote is stale");
    if (!q.tradable) reasons.push(`quote source '${q.source}' is not tradable`);
    const mid = (q.bid + q.ask) / 2; spread = mid ? ((q.ask - q.bid) / mid) * 1e4 : null;
    if (spread != null && spread > MAX_SPREAD[c.asset_class]!) reasons.push(`spread ${spread.toFixed(1)} bps exceeds ${MAX_SPREAD[c.asset_class]} bps`);
  }
  reasons.push(...((reg.data.gates as string[] | undefined) ?? []));
  if (nw.data.event_risk) reasons.push("high-impact event inside the 3-day window");
  if (pf.status !== "ok" || !pf.data.sized) reasons.push("position cannot be sized within limits");
  const ok = !reasons.length;
  return {
    agent: "risk", status: "ok", direction: 0, score: ok ? 1 : 0, confidence: 1,
    summary: `${ok ? "Pre-check passed. " : `Pre-check failed: ${reasons.join("; ")}. `}Advisory only; the independent risk engine has final authority over any order.`,
    evidence: [
      { label: "Market open", value: q ? String(q.market_open) : "—", detail: "" },
      { label: "Quote stale", value: q ? String(q.stale) : "—", detail: "" },
      { label: "Spread", value: spread != null ? `${spread.toFixed(2)} bps` : "—", detail: `limit ${MAX_SPREAD[c.asset_class]} bps` },
      { label: "Leverage", value: "0 (spot paper trading)", detail: "" },
      { label: "Max risk per trade", value: "0.5% of equity", detail: "" },
    ],
    duration_ms: 0, data: { approved: ok, reasons },
  };
}

export const DEFAULT_WEIGHTS: Record<string, number> = { technical: 0.35, quant: 0.25, fundamental: 0.15, news: 0.15, sentiment: 0.1, ml: 0 };
export const ORDER = ["technical", "quant", "regime", "fundamental", "news", "sentiment", "ml", "portfolio", "risk"];

export function runAgents(c: Ctx, enabled: Set<string>) {
  const f: Record<string, Finding> = {};
  const call = (name: string, fn: () => Finding) => {
    const t0 = performance.now();
    try { f[name] = enabled.has(name) ? fn() : abstain(name, "Agent disabled by an administrator"); }
    catch (e) { f[name] = { ...abstain(name, `Agent failed: ${(e as Error).name}`), status: "error" }; }
    f[name]!.duration_ms = Math.round(performance.now() - t0);
  };
  call("technical", () => technical(c)); call("quant", () => quant(c)); call("regime", () => regime(c));
  call("fundamental", () => fundamental(c)); call("news", () => news(c)); call("sentiment", () => sentimentAgent(c));
  // Models trained on synthetic data can never be promoted, so the demo never has a champion.
  call("ml", () => abstain("ml", "No promoted champion model for this instrument"));
  call("portfolio", () => portfolio(c, f.technical!.data.atr as number | undefined));
  call("risk", () => riskCheck(c, f.regime!, f.news!, f.portfolio!));
  return f;
}

export function decide(c: Ctx, f: Record<string, Finding>, weights: Record<string, number>) {
  const w = Object.fromEntries(Object.entries(weights).filter(([k]) => f[k]));
  const active = Object.keys(w).filter((k) => f[k]!.status === "ok");
  const tot = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  const coverage = active.reduce((a, k) => a + w[k]!, 0) / tot;
  const wc = Object.fromEntries(active.map((k) => [k, w[k]! * f[k]!.confidence]));
  const den = Object.values(wc).reduce((a, b) => a + b, 0);
  const net = den ? active.reduce((a, k) => a + wc[k]! * f[k]!.score, 0) / den : 0;
  const side = Math.sign(net);
  const voting = active.filter((k) => f[k]!.direction !== 0);
  const vw = voting.reduce((a, k) => a + wc[k]!, 0);
  const agreement = vw && side ? voting.filter((k) => f[k]!.direction === side).reduce((a, k) => a + wc[k]!, 0) / vw : 0;
  const bias = net >= 0.2 ? "bullish" : net <= -0.2 ? "bearish" : "neutral";
  const reasons: string[] = [];
  if (coverage < 0.5) reasons.push(`insufficient agent coverage (${(coverage * 100).toFixed(0)}% of directional weight)`);
  if (Math.abs(net) < 0.2) reasons.push(`signal too weak (net score ${net >= 0 ? "+" : ""}${net.toFixed(2)}, needs ±0.20)`);
  if (voting.length && agreement < 0.6) reasons.push(`agents disagree (${(agreement * 100).toFixed(0)}% weighted agreement)`);
  const gates = (f.regime?.status === "ok" ? (f.regime.data.gates as string[]) : null);
  if (!gates) reasons.push("market regime could not be classified"); else reasons.push(...gates);
  if (f.risk && !f.risk.data.approved) for (const r of f.risk.data.reasons as string[]) if (!(gates ?? []).includes(r)) reasons.push(`risk pre-check: ${r}`);
  if (bias === "bearish") reasons.push("bearish view: short selling is disabled in spot paper trading");
  const confidence = +(Math.abs(net) * agreement * coverage).toFixed(3);
  const decision = reasons.length || side <= 0 ? "NO_TRADE" : "BUY";
  let proposal: Record<string, unknown> | null = null;
  if (decision === "BUY") {
    const pf = f.portfolio!.data as { qty: number; notional: number; risk: number; entry: number };
    const a = f.technical!.data.atr as number, d = c.price_decimals, r = (v: number) => v.toFixed(d);
    proposal = {
      symbol: c.symbol, direction: "BUY", strategy_id: "consensus_trend_v1", confidence, entry_type: "LIMIT",
      entry_price: r(pf.entry), stop_loss: r(pf.entry - 2 * a), take_profit: r(pf.entry + 3 * a), quantity: String(pf.qty),
      notional: pf.notional.toFixed(2), risk_amount: pf.risk.toFixed(2), reward_risk: 1.5,
      invalidation_conditions: [`Hourly close below the stop at ${r(pf.entry - 2 * a)}`, "Trend reversal: SMA20 crosses below SMA50 on the hourly chart",
        "Volatility regime moves outside the validated range", "Quote becomes stale or the market closes before entry",
        ...(f.news!.status === "ok" ? ["A high-impact event enters the 3-day window"] : [])],
      risk_check_required: true, expires_at: new Date(c.now + 4 * 3600_000).toISOString(),
    };
  }
  return { decision, bias, net_score: +net.toFixed(3), agreement: +agreement.toFixed(3), coverage: +coverage.toFixed(3), confidence, reasons, weights: w, proposal };
}
