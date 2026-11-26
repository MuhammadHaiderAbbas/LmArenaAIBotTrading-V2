import { Radio, Search, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OrderTicket } from "@/features/trading/OrderTicket";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PriceChart } from "@/charts/PriceChart";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorBanner, Spinner } from "@/components/ui/feedback";
import { Input } from "@/components/ui/form";
import { useCandles, useLiveQuotes, useMarketOverview, useWatchlist, useWatchlistToggle } from "@/features/markets/hooks";
import { cn, formatDateTime, formatPct, formatPrice } from "@/lib/utils";
import type { AssetClass, Instrument, MarketStatus, Quote } from "@/services/api";

const TABS: { key: "WATCH" | AssetClass; label: string }[] = [
  { key: "WATCH", label: "Watchlist" }, { key: "CRYPTO", label: "Crypto" }, { key: "FX", label: "Forex" },
  { key: "STOCK", label: "Stocks" }, { key: "ETF", label: "ETFs" },
];
const TIMEFRAMES = ["5m", "15m", "1h", "4h", "1d"];
const INDICATORS = [
  { key: "sma20", label: "SMA 20" }, { key: "sma50", label: "SMA 50" }, { key: "ema20", label: "EMA 20" },
  { key: "bb20", label: "Bollinger" }, { key: "rsi14", label: "RSI 14" }, { key: "macd", label: "MACD" },
];
const SOURCE_LABEL: Record<string, string> = {
  synthetic: "Synthetic", coinbase: "Coinbase", ecb_reference: "ECB reference",
  finnhub: "Finnhub", oanda: "OANDA",
};
const PRICING_LABEL: Record<string, { label: string; hint: string }> = {
  actual: { label: "Real bid/ask", hint: "Executable bid and ask from the venue" },
  estimated_spread: { label: "Derived spread", hint: "Real last price; bid/ask estimated from a configured spread" },
  reference: { label: "Reference only", hint: "Daily fixing — not tradable" },
  simulated: { label: "Simulated", hint: "Demo prices, not real market data" },
};

export function SourceBadge({ source }: { source: string | null | undefined }) {
  if (!source) return null;
  return <Badge tone={source === "synthetic" ? "warning" : "info"} title={source === "synthetic" ? "Simulated prices — not real market data" : undefined}>{SOURCE_LABEL[source] ?? source}</Badge>;
}

export function PricingBadge({ pricing }: { pricing: string | null | undefined }) {
  if (!pricing) return null;
  const info = PRICING_LABEL[pricing] ?? { label: pricing, hint: "Provider pricing mode" };
  return <Badge tone={pricing === "actual" ? "positive" : "warning"} title={info.hint}>{info.label}</Badge>;
}

export function QuoteState({ q }: { q: Quote | undefined | null }) {
  if (!q) return <span className="text-xs text-subtle">No data</span>;
  if (!q.market_open) return <span className="flex items-center gap-1.5 text-xs text-subtle"><StatusDot />Closed</span>;
  if (q.stale) return <span className="flex items-center gap-1.5 text-xs text-warning" title={`Last update ${q.age_seconds}s ago`}><StatusDot tone="warning" />Stale</span>;
  return <span className="flex items-center gap-1.5 text-xs text-positive"><StatusDot tone="positive" />Open</span>;
}

export function Change({ q }: { q: Quote | undefined | null }) {
  const n = q?.change_pct == null ? 0 : Number(q.change_pct);
  return <span className={cn("num", n > 0 && "text-positive", n < 0 && "text-negative", n === 0 && "text-muted")}>{formatPct(q?.change_pct)}</span>;
}

function SessionStrip({ markets }: { markets: MarketStatus[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {markets.map((m) => (
        <div key={m.market} className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5 text-xs">
          <StatusDot tone={m.is_open ? "positive" : "neutral"} />
          <span className="font-medium">{m.label}</span>
          <span className="text-subtle">
            {m.next_change ? `${m.is_open ? "closes" : "opens"} ${formatDateTime(m.next_change)}` : "always open"}
          </span>
        </div>
      ))}
    </div>
  );
}

export function MarketsPage() {
  const overview = useMarketOverview();
  const watchlist = useWatchlist();
  const toggle = useWatchlistToggle();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("WATCH");
  const [search, setSearch] = useState("");
  const [timeframe, setTimeframe] = useState("1h");
  const [indicators, setIndicators] = useState<string[]>(["sma20", "rsi14"]);
  const [ticket, setTicket] = useState<"BUY" | "SELL" | null>(null);

  const all = useMemo(() => Object.values(overview.data?.groups ?? {}).flat(), [overview.data]);
  const watched = new Set(watchlist.data?.items.map((i) => i.instrument.symbol));
  const rows = (tab === "WATCH" ? watchlist.data?.items ?? [] : overview.data?.groups[tab] ?? [])
    .filter((r) => !search || `${r.instrument.symbol} ${r.instrument.display_name}`.toLowerCase().includes(search.toLowerCase()));

  const { quotes: liveQuotes, live } = useLiveQuotes(all.map((r) => r.instrument.symbol));
  const quoteOf = (r: { instrument: Instrument; quote: Quote | null }) => liveQuotes[r.instrument.symbol] ?? r.quote;

  const selectedSlug = params.get("symbol") ?? "BTC-USD";
  const selected = all.find((r) => r.instrument.slug === selectedSlug) ?? all[0];
  const candles = useCandles(selected?.instrument.slug, timeframe, indicators);
  const sq = selected ? quoteOf(selected) : null;
  const liveTick = useMemo(() => (sq && sq.market_open ? { price: Number(sq.last), at: sq.as_of } : null), [sq?.last, sq?.as_of, sq?.market_open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (overview.isLoading) return <Spinner className="mx-auto mt-16" />;
  return (
    <div className="space-y-4">
      <ErrorBanner error={overview.error ?? candles.error ?? toggle.error} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SessionStrip markets={overview.data?.markets ?? []} />
        <div className="flex items-center gap-2 text-xs text-muted">
          <Radio className={cn("size-3.5", live ? "text-positive" : "text-subtle")} />
          {live ? "Streaming" : "Polling"}
          {overview.data?.data_mode === "synthetic" && <Badge tone="warning" title="Prices are generated deterministically for development. They are not real market data.">Synthetic data</Badge>}
          {overview.data?.data_mode === "mixed" && <Badge tone="warning" title={overview.data.price_source_note ?? "Crypto uses public data; other instruments are simulated."}>Mixed data</Badge>}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[420px_1fr]">
        <Card className="min-w-0">
          <div className="flex gap-1 overflow-x-auto border-b border-border px-2 pt-2" role="tablist">
            {TABS.map((t) => (
              <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
                className={cn("whitespace-nowrap border-b-2 px-3 pb-2 text-xs font-medium",
                  tab === t.key ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg")}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="relative border-b border-border p-2">
            <Search className="pointer-events-none absolute top-1/2 left-5 size-3.5 -translate-y-1/2 text-subtle" />
            <Input aria-label="Search instruments" placeholder="Search" className="h-8 pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {rows.length === 0 ? <EmptyState title={tab === "WATCH" ? "Watchlist is empty" : "No instruments"} /> : (
            <ul className="max-h-[560px] divide-y divide-border/60 overflow-y-auto">
              {rows.map((r) => {
                const q = quoteOf(r);
                const active = r.instrument.slug === selected?.instrument.slug;
                const on = watched.has(r.instrument.symbol);
                return (
                  <li key={r.instrument.symbol}>
                    <div className={cn("flex items-center gap-2 px-3 py-2.5", active ? "bg-surface-3" : "hover:bg-surface-2")}>
                      <button aria-label={on ? `Remove ${r.instrument.symbol} from watchlist` : `Add ${r.instrument.symbol} to watchlist`}
                        onClick={() => toggle.mutate({ slug: r.instrument.slug, on: !on })}
                        className={cn("shrink-0", on ? "text-accent" : "text-subtle hover:text-muted")}>
                        <Star className={cn("size-3.5", on && "fill-current")} />
                      </button>
                      <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => setParams({ symbol: r.instrument.slug })}>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium">{r.instrument.symbol}</div>
                          <div className="truncate text-[11px] text-subtle">{r.instrument.display_name}</div>
                        </div>
                        <div className="text-right">
                          <div className="num text-sm">{formatPrice(q?.last, r.instrument.price_decimals)}</div>
                          <div className="text-[11px]"><Change q={q} /></div>
                        </div>
                        <div className="hidden w-14 sm:block"><QuoteState q={q} /></div>
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {selected && (
          <Card className="min-w-0">
            <CardHeader
              title={<span className="flex flex-wrap items-center gap-2"><span className="text-base">{selected.instrument.symbol}</span>
                <span className="font-normal text-muted">{selected.instrument.display_name}</span>
                <Badge>{selected.instrument.instrument_type}</Badge><SourceBadge source={sq?.source} /><PricingBadge pricing={sq?.pricing} /></span>}
              description={`${selected.instrument.venue} · quoted in ${selected.instrument.quote_currency}`}
              action={<QuoteState q={sq} />}
            />
            <div className="flex flex-wrap items-end gap-x-6 gap-y-2 border-b border-border px-5 py-3">
              <div>
                <div className="num text-2xl font-semibold tracking-tight" data-testid="last-price">{formatPrice(sq?.last, selected.instrument.price_decimals)}</div>
                <div className="text-xs"><Change q={sq} /> <span className="text-subtle">vs prev close</span></div>
              </div>
              <dl className="grid grid-cols-3 gap-x-6 text-xs">
                <div><dt className="text-subtle">Bid</dt><dd className="num">{formatPrice(sq?.bid, selected.instrument.price_decimals)}</dd></div>
                <div><dt className="text-subtle">Ask</dt><dd className="num">{formatPrice(sq?.ask, selected.instrument.price_decimals)}</dd></div>
                <div><dt className="text-subtle">As of</dt><dd className="num">{sq ? formatDateTime(sq.as_of) : "—"}</dd></div>
              </dl>
              <div className="ml-auto flex items-center gap-2">
                {sq && !sq.tradable && (
                  <Badge tone="warning" title="Orders on closed markets or stale prices are rejected; limit and stop orders wait for the market.">Not tradable now</Badge>
                )}
                <Button size="sm" onClick={() => setTicket("BUY")}>Buy</Button>
                <Button size="sm" variant="danger" onClick={() => setTicket("SELL")}>Sell</Button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 px-5 py-2.5">
              <div className="flex rounded-md bg-surface-2 p-0.5" role="group" aria-label="Timeframe">
                {TIMEFRAMES.map((tf) => (
                  <button key={tf} aria-pressed={timeframe === tf} onClick={() => setTimeframe(tf)}
                    className={cn("rounded px-2.5 py-1 text-xs num", timeframe === tf ? "bg-surface-3 text-fg" : "text-muted hover:text-fg")}>{tf}</button>
                ))}
              </div>
              <div className="flex flex-wrap gap-1" role="group" aria-label="Indicators">
                {INDICATORS.map((i) => {
                  const on = indicators.includes(i.key);
                  return (
                    <button key={i.key} aria-pressed={on}
                      onClick={() => setIndicators(on ? indicators.filter((x) => x !== i.key) : [...indicators, i.key])}
                      className={cn("rounded border px-2 py-0.5 text-[11px]", on ? "border-accent/60 bg-accent/10 text-accent" : "border-border text-muted hover:text-fg")}>
                      {i.label}
                    </button>
                  );
                })}
              </div>
              {candles.isFetching && <Spinner className="ml-auto" />}
            </div>
            <div className="px-2 pb-3">
              {candles.data && candles.data.candles.length > 0 ? (
                <PriceChart data={candles.data} decimals={selected.instrument.price_decimals} live={liveTick} />
              ) : candles.isLoading ? <div className="flex h-[420px] items-center justify-center"><Spinner /></div> : (
                <EmptyState title="No candles for this timeframe" />
              )}
              <p className="px-3 pt-2 text-[10px] text-subtle">
                {candles.data?.candles.length ?? 0} OHLC candles · source {SOURCE_LABEL[candles.data?.source ?? ""] ?? candles.data?.source ?? "—"}{candles.data?.source === "coinbase" ? " (real public data)" : " (simulated, not real market data)"} · charts by TradingView Lightweight Charts
              </p>
            </div>
          </Card>
        )}
      </div>
      {selected && ticket && <OrderTicket open onClose={() => setTicket(null)} symbol={selected.instrument.symbol} side={ticket} />}
    </div>
  );
}
