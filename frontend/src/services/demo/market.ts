/**
 * Browser port of backend/app/market/{calendar,providers/synthetic,indicators}.py
 * used by the static GitHub Pages demo. Keep the hashing and price model in sync
 * with the Python implementation (pinned values are asserted in both test suites).
 */

export type MarketKey = "CRYPTO_24_7" | "FX_24_5" | "US_EQUITY" | "UK_EQUITY";
export type AssetClassKey = "CRYPTO" | "FX" | "STOCK" | "ETF";
type Session = [number, number]; // UTC ms, half-open

// ---- calendar ---------------------------------------------------------------
const NYSE = new Set(["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
  "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15",
  "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"]);
const LSE = new Set(["2026-01-01", "2026-04-03", "2026-04-06", "2026-05-04", "2026-05-25", "2026-08-31",
  "2026-12-25", "2026-12-28", "2027-01-01", "2027-03-26", "2027-03-29", "2027-05-03", "2027-05-31",
  "2027-08-30", "2027-12-27", "2027-12-28"]);
const EQUITY: Record<string, { tz: string; open: [number, number]; close: [number, number]; holidays: Set<string> }> = {
  US_EQUITY: { tz: "America/New_York", open: [9, 30], close: [16, 0], holidays: NYSE },
  UK_EQUITY: { tz: "Europe/London", open: [8, 0], close: [16, 30], holidays: LSE },
};
// Local-time close overrides, mirroring backend/app/market/calendar.py::EARLY_CLOSES.
const EARLY_CLOSES: Record<string, Record<string, [number, number]>> = {
  US_EQUITY: { "2026-11-27": [13, 0], "2026-12-24": [13, 0], "2027-11-26": [13, 0] },
  UK_EQUITY: { "2026-12-24": [12, 30], "2026-12-31": [12, 30], "2027-12-24": [12, 30], "2027-12-31": [12, 30] },
};
const DAY = 86_400_000;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(tz: string, ms: number) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year!, m: +p.month!, d: +p.day!, h: +p.hour!, mi: +p.minute!, s: +p.second! };
}
function offset(tz: string, ms: number) {
  const p = parts(tz, ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
/** Wall-clock time in `tz` → UTC ms. */
function zoned(y: number, m: number, d: number, h: number, mi: number, tz: string) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - offset(tz, guess);
  return guess - offset(tz, first);
}
function localDate(tz: string, ms: number) {
  const p = parts(tz, ms);
  return Date.UTC(p.y, p.m - 1, p.d); // date as UTC-midnight ms
}
const iso = (dateMs: number) => new Date(dateMs).toISOString().slice(0, 10);
const ymd = (dateMs: number) => { const d = new Date(dateMs); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()] as const; };

export function sessions(market: MarketKey, start: number, end: number): Session[] {
  if (start >= end) return [];
  if (market === "CRYPTO_24_7") return [[start, end]];
  const raw: Session[] = [];
  if (market === "FX_24_5") {
    let d = localDate("America/New_York", start) - 7 * DAY;
    d -= ((new Date(d).getUTCDay()) % 7) * DAY; // back to Sunday
    for (;;) {
      const [y, m, dd] = ymd(d);
      const open = zoned(y, m, dd, 17, 0, "America/New_York");
      if (open >= end) break;
      const [y2, m2, d2] = ymd(d + 5 * DAY);
      raw.push([open, zoned(y2, m2, d2, 17, 0, "America/New_York")]);
      d += 7 * DAY;
    }
  } else {
    const cfg = EQUITY[market]!;
    let d = localDate(cfg.tz, start) - DAY;
    const last = localDate(cfg.tz, end);
    for (; d <= last; d += DAY) {
      const wd = new Date(d).getUTCDay();
      if (wd === 0 || wd === 6 || cfg.holidays.has(iso(d))) continue;
      const [y, m, dd] = ymd(d);
      const early = EARLY_CLOSES[market]?.[iso(d)] ?? cfg.close;
      raw.push([zoned(y, m, dd, cfg.open[0], cfg.open[1], cfg.tz), zoned(y, m, dd, early[0], early[1], cfg.tz)]);
    }
  }
  return raw.filter(([s, e]) => e > start && s < end).map(([s, e]) => [Math.max(s, start), Math.min(e, end)]);
}

/** DAY-order expiry: the end of the current (or next) session; UTC midnight for 24/7 crypto. */
export function dayExpiry(market: MarketKey, at: number): number {
  const tomorrow = (() => { const d = new Date(at); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); })();
  if (market === "CRYPTO_24_7") return tomorrow;
  const up = sessions(market, at, at + 10 * DAY);
  return up.length ? up[0]![1] : tomorrow;
}

export const isOpen = (market: MarketKey, at: number) => sessions(market, at, at + 1000).length > 0;

export function lastClose(market: MarketKey, at: number): number | null {
  if (market === "CRYPTO_24_7") return null;
  const ends = sessions(market, at - 10 * DAY, at).map(([, e]) => e).filter((e) => e < at);
  return ends.length ? ends[ends.length - 1]! : null;
}

export function status(market: MarketKey, at: number) {
  if (market === "CRYPTO_24_7") return { is_open: true, next_change: null as number | null };
  const up = sessions(market, at, at + 10 * DAY);
  const open = up.length > 0 && up[0]![0] <= at;
  return { is_open: open, next_change: up.length ? (open ? up[0]![1] : up[0]![0]) : null };
}

// ---- synthetic prices ---------------------------------------------------------
const YEAR = 365 * 86400;
const AMP = 0.45;
const VOL: Record<AssetClassKey, number> = { CRYPTO: 0.65, FX: 0.08, STOCK: 0.28, ETF: 0.16 };
export const SPREAD: Record<AssetClassKey, number> = { CRYPTO: 0.0002, FX: 0.00004, STOCK: 0.0002, ETF: 0.0001 };
const CYCLES: [number, number][] = [[2 * 3600, 0.5], [9 * 3600, 0.7], [3 * 86400, 1], [11 * 86400, 1], [37 * 86400, 1], [97 * 86400, 1], [YEAR, 1]];

export function fnv1a(s: string) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h >>> 0;
}
export function rnd(seed: number, k: number) {
  let h = (seed ^ Math.imul(k >>> 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}
export function priceAt(symbol: string, cls: AssetClassKey, base: number, tSec: number) {
  const seed = fnv1a(symbol);
  const vol = VOL[cls];
  let x = 0;
  CYCLES.forEach(([period, w], j) => {
    x += vol * Math.sqrt(period / YEAR) * AMP * w * Math.sin((2 * Math.PI * tSec) / period + rnd(seed, 1000 + j) * 2 * Math.PI);
  });
  x += vol * Math.sqrt(60 / YEAR) * 2.5 * (rnd(seed, Math.floor(tSec / 60)) - 0.5);
  return base * Math.exp(x);
}

export interface DemoInstrument {
  symbol: string; display_name: string; asset_class: AssetClassKey; instrument_type: string; venue: string;
  market: MarketKey; base_currency: string; quote_currency: string; price_decimals: number;
  tick_size: string; lot_size: string; reference_price: number;
}
export const TIMEFRAMES: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

function ohlc(i: DemoInstrument, s: number, e: number) {
  const step = Math.max(60, (e - s) / 16);
  const samples = [priceAt(i.symbol, i.asset_class, i.reference_price, s)];
  for (let t = s + step; t < e; t += step) samples.push(priceAt(i.symbol, i.asset_class, i.reference_price, t));
  samples.push(priceAt(i.symbol, i.asset_class, i.reference_price, e));
  return [samples[0]!, Math.max(...samples), Math.min(...samples), samples[samples.length - 1]!] as const;
}

const BASE_VOLUME: Record<AssetClassKey, number> = { CRYPTO: 40, FX: 2e6, STOCK: 1.5e5, ETF: 3e5 };

export function candles(i: DemoInstrument, timeframe: string, limit: number, nowMs = Date.now()) {
  const tf = TIMEFRAMES[timeframe]!;
  const seed2 = fnv1a(i.symbol + ":vol");
  const d = i.price_decimals;
  const mk = (openMs: number, s: number, e: number) => {
    const [o, h, l, c] = ohlc(i, s, e);
    const v = BASE_VOLUME[i.asset_class] * (0.4 + 1.2 * rnd(seed2, Math.floor(s / tf))) * (e - s) / 3600;
    return { open_time: new Date(openMs).toISOString(), open: o.toFixed(d), high: h.toFixed(d), low: l.toFixed(d), close: c.toFixed(d), volume: v.toFixed(4) };
  };
  const out: ReturnType<typeof mk>[] = [];
  const equity = i.market === "US_EQUITY" || i.market === "UK_EQUITY";
  const factor = i.market === "CRYPTO_24_7" ? 1 : i.market === "FX_24_5" ? 1.5 : timeframe === "1d" ? 1.6 : (24 / 6.5) * 1.5;
  const start = nowMs - (tf * limit * factor + tf) * 1000;
  if (timeframe === "1d" && equity) {
    for (const [so, sc] of sessions(i.market, start - DAY, nowMs)) {
      if (so < start || sc > nowMs) continue;
      out.push(mk(so, so / 1000, sc / 1000));
    }
  } else {
    for (let t = Math.ceil(start / 1000 / tf) * tf; (t + tf) * 1000 <= nowMs; t += tf) {
      const inter = sessions(i.market, t * 1000, (t + tf) * 1000);
      if (!inter.length) continue;
      out.push(mk(t * 1000, Math.min(...inter.map((x) => x[0])) / 1000, Math.max(...inter.map((x) => x[1])) / 1000));
    }
  }
  return out.slice(-limit);
}

export function quote(i: DemoInstrument, nowMs = Date.now()) {
  const open = isOpen(i.market, nowMs);
  const asOf = open ? nowMs : lastClose(i.market, nowMs) ?? nowMs;
  const p = (ms: number) => priceAt(i.symbol, i.asset_class, i.reference_price, ms / 1000);
  let prevT = asOf - DAY;
  if (i.market === "US_EQUITY" || i.market === "UK_EQUITY") {
    const recent = sessions(i.market, asOf - 10 * DAY, asOf);
    const sessionOpen = recent.length ? recent[recent.length - 1]![0] : asOf;
    prevT = lastClose(i.market, sessionOpen) ?? asOf - DAY;
  }
  const d = i.price_decimals;
  const last = +p(asOf).toFixed(d);
  const prev = +p(prevT).toFixed(d);
  const half = SPREAD[i.asset_class] / 2;
  const change = last - prev;
  return {
    symbol: i.symbol, last: last.toFixed(d), bid: (last * (1 - half)).toFixed(d), ask: (last * (1 + half)).toFixed(d),
    prev_close: prev.toFixed(d), change: change.toFixed(d), change_pct: ((change / prev) * 100).toFixed(2),
    as_of: new Date(asOf).toISOString(), source: "synthetic", market_open: open, stale: false,
    tradable: open, age_seconds: Math.max(0, Math.floor((nowMs - asOf) / 1000)), pricing: "simulated",
  };
}

// ---- indicators -------------------------------------------------------------------
type S = (number | null)[];
export function sma(v: number[], n: number): S {
  const out: S = Array(v.length).fill(null); let w = 0;
  v.forEach((x, i) => { w += x; if (i >= n) w -= v[i - n]!; if (i >= n - 1) out[i] = w / n; });
  return out;
}
export function ema(v: number[], n: number): S {
  const out: S = Array(v.length).fill(null);
  if (v.length < n) return out;
  const k = 2 / (n + 1); let prev = v.slice(0, n).reduce((a, b) => a + b, 0) / n; out[n - 1] = prev;
  for (let i = n; i < v.length; i++) { prev = v[i]! * k + prev * (1 - k); out[i] = prev; }
  return out;
}
export function rsi(v: number[], n = 14): S {
  const out: S = Array(v.length).fill(null);
  if (v.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = v[i]! - v[i - 1]!; g += Math.max(d, 0); l += Math.max(-d, 0); }
  g /= n; l /= n;
  const r = (a: number, b: number) => (b === 0 ? 100 : 100 - 100 / (1 + a / b));
  out[n] = r(g, l);
  for (let i = n + 1; i < v.length; i++) {
    const d = v[i]! - v[i - 1]!;
    g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; out[i] = r(g, l);
  }
  return out;
}
const diff = (a: S, b: S): S => a.map((x, i) => (x != null && b[i] != null ? x - b[i]! : null));
export function indicators(names: string[], closes: number[]) {
  const out: Record<string, unknown> = {};
  for (const n of names) {
    if (/^sma\d+$/.test(n)) out[n] = sma(closes, +n.slice(3));
    else if (/^ema\d+$/.test(n)) out[n] = ema(closes, +n.slice(3));
    else if (n === "rsi14") out[n] = rsi(closes);
    else if (n === "bb20") {
      const mid = sma(closes, 20);
      const sd = closes.map((_, i) => {
        if (i < 19) return null;
        const w = closes.slice(i - 19, i + 1); const m = mid[i]!;
        return Math.sqrt(w.reduce((a, x) => a + (x - m) ** 2, 0) / 20);
      });
      out[n] = { middle: mid, upper: mid.map((m, i) => (m == null ? null : m + 2 * sd[i]!)), lower: mid.map((m, i) => (m == null ? null : m - 2 * sd[i]!)) };
    } else if (n === "macd") {
      const line = diff(ema(closes, 12), ema(closes, 26));
      const start = line.findIndex((x) => x != null);
      const sig: S = start < 0 ? Array(closes.length).fill(null) : [...Array(start).fill(null), ...ema(line.slice(start) as number[], 9)];
      out[n] = { macd: line, signal: sig, histogram: diff(line, sig) };
    }
  }
  return out;
}
