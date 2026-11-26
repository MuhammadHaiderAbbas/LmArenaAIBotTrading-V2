/**
 * Public Coinbase Exchange data for the static demo. No API key, no credentials, and no
 * user data leaves the browser. Every response is cached briefly and failures return null
 * so callers can fall back to the clearly-labelled synthetic corpus.
 *
 * Candle shape mirrors backend/app/market/types.py and services/demo/market.ts.
 */

const BASE = "https://api.exchange.coinbase.com";
const NATIVE: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "1d": 86400 };
const MAX_ROWS = 300;
type Candle = { open_time: string; open: string; high: string; low: string; close: string; volume: string };
type Cache<T> = { until: number; value: T };
const cache = new Map<string, Cache<unknown>>();
const lastQuotes = new Map<string, Record<string, unknown>>();

/** Last successfully fetched public quote, even when the short HTTP cache has expired. */
export function cachedLiveQuote(symbol: string): Record<string, unknown> | null {
  return lastQuotes.get(symbol) ?? null;
}

function memo<T>(key: string, ttlMs: number, load: () => Promise<T | null>): Promise<T | null> {
  const hit = cache.get(key) as Cache<T> | undefined;
  if (hit && hit.until > Date.now()) return Promise.resolve(hit.value);
  return load().then((value) => {
    if (value) cache.set(key, { until: Date.now() + ttlMs, value });
    return value;
  });
}

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(9000), cache: "no-store" });
  if (!res.ok) throw new Error(`coinbase ${res.status}`);
  return res.json();
}

const num = (v: unknown, decimals = 2) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(decimals) : null;
};

export function isLiveCrypto(symbol: string): boolean {
  return ["BTC-USD", "ETH-USD", "SOL-USD"].includes(symbol);
}

export async function liveQuote(symbol: string, decimals: number): Promise<Record<string, unknown> | null> {
  if (!isLiveCrypto(symbol)) return null;
  return memo(`quote:${symbol}`, 10_000, async () => {
    try {
      const [ticker, stats] = await Promise.all([
        get(`/products/${symbol}/ticker`) as Promise<Record<string, unknown>>,
        get(`/products/${symbol}/stats`) as Promise<Record<string, unknown>>,
      ]);
      const last = Number(ticker.price);
      if (!Number.isFinite(last) || last <= 0) return null;
      const prev = Number(stats.open) || last;
      const bid = Number(ticker.bid) > 0 ? Number(ticker.bid) : last * 0.9995;
      const ask = Number(ticker.ask) > 0 ? Number(ticker.ask) : last * 1.0005;
      const asOf = ticker.time ? String(ticker.time) : new Date().toISOString();
      const age = Math.max(0, (Date.now() - Date.parse(asOf)) / 1000);
      const quote = {
        symbol, last: last.toFixed(decimals), bid: bid.toFixed(decimals), ask: ask.toFixed(decimals),
        prev_close: prev.toFixed(decimals), change: (last - prev).toFixed(decimals),
        change_pct: ((last - prev) / prev * 100).toFixed(2), as_of: asOf, source: "coinbase",
        market_open: true, stale: age > 120, tradable: age <= 120,
        age_seconds: Math.floor(age), pricing: "reference",
        note: "Real public price. Paper orders in this demo are simulated and do not execute at this price.",
      };
      lastQuotes.set(symbol, quote);
      return quote;
    } catch {
      return null;
    }
  });
}

function aggregate(hours: Candle[], seconds: number): Candle[] {
  const buckets = new Map<number, Candle[]>();
  for (const c of hours) {
    const key = Math.floor(Date.parse(c.open_time) / 1000 / seconds) * seconds;
    buckets.set(key, [...(buckets.get(key) ?? []), c]);
  }
  return [...buckets.keys()].sort((a, b) => a - b).map((key) => {
    const g = buckets.get(key)!;
    return {
      open_time: new Date(key * 1000).toISOString(), open: g[0]!.open,
      high: Math.max(...g.map((c) => +c.high)).toFixed(2),
      low: Math.min(...g.map((c) => +c.low)).toFixed(2),
      close: g[g.length - 1]!.close,
      volume: g.reduce((n, c) => n + Number(c.volume || 0), 0).toFixed(4),
    };
  });
}

export async function liveCandles(symbol: string, timeframe: string, limit: number): Promise<Candle[] | null> {
  if (!isLiveCrypto(symbol)) return null;
  const needHourly = timeframe === "4h" ? limit * 4 : limit;
  const gran = timeframe === "4h" ? 3600 : NATIVE[timeframe];
  if (!gran) return null;
  return memo(`candles:${symbol}:${timeframe}:${limit}`, gran <= 300 ? 15_000 : 60_000, async () => {
    try {
      const rows: Candle[] = [];
      const end = Date.now();
      let cursor = end - gran * MAX_ROWS * 1000;
      let requests = 0;
      while (cursor < end && requests < 8 && rows.length < needHourly) {
        const chunkEnd = Math.min(end, cursor + gran * MAX_ROWS * 1000);
        const data = await get(`/products/${symbol}/candles?granularity=${gran}` +
          `&start=${new Date(cursor).toISOString()}&end=${new Date(chunkEnd).toISOString()}`) as unknown[][];
        if (!Array.isArray(data)) return null;
        for (const [t, low, high, open, close, vol] of data) {
          const o = num(open), h = num(high), l = num(low), c = num(close);
          if (o === null || h === null || l === null || c === null) continue;
          rows.push({ open_time: new Date(Number(t) * 1000).toISOString(), open: o, high: h, low: l, close: c,
                      volume: num(vol, 8) ?? "0" });
        }
        cursor = chunkEnd;
        requests++;
      }
      const uniq = [...new Map(rows.map((c) => [c.open_time, c])).values()]
        .sort((a, b) => a.open_time.localeCompare(b.open_time));
      const out = timeframe === "4h" ? aggregate(uniq, 14_400) : uniq;
      return out.length ? out.slice(-limit) : null;
    } catch {
      return null;
    }
  });
}
