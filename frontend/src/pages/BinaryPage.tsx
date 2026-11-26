import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowDown, ArrowUp, Timer } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorBanner, Spinner } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/form";
import { Stat } from "@/components/ui/stat";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { useBinaryConfig, useBinaryContracts, useBinaryStats, useOpenBinary } from "@/features/binary/hooks";
import { PriceChart, type ChartPriceLine } from "@/charts/PriceChart";
import { useCandles, useMarketOverview } from "@/features/markets/hooks";
import { usePortfolio } from "@/features/trading/hooks";
import { useAccountParam } from "@/features/trading/useAccountParam";
import { cn, formatDateTime, formatMoney, formatPrice } from "@/lib/utils";
import { ChecksList } from "@/pages/RiskPage";
import { api, ApiError, type BinaryContract, type BinaryDirection, type InstrumentWithQuote, type RiskCheck } from "@/services/api";
import { SourceBadge } from "@/pages/MarketsPage";

const EXPIRY_LABEL: Record<number, string> = { 60: "1 minute", 300: "5 minutes", 900: "15 minutes", 3600: "1 hour", 86400: "1 day" };
const label = (s: number) => EXPIRY_LABEL[s] ?? `${s}s`;
const pct = (v: number | null | undefined, dp = 1) => (v == null ? "—" : `${(v * 100).toFixed(dp)}%`);
const slug = (s: string) => s.replace("/", "");
const STATUS_TONE = { OPEN: "info", WON: "positive", LOST: "negative", TIE: "neutral", VOID: "neutral" } as const;
const token = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#888";

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function countdown(ms: number) {
  if (ms <= 0) return "settling…";
  const s = Math.ceil(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}:${String(r).padStart(2, "0")}`;
}

function Disclaimer({ notice }: { notice?: string }) {
  return (
    <div role="note" aria-label="Binary options warning" data-testid="binary-disclaimer" className="flex gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
      <div className="space-y-1">
        <div className="font-semibold">Paper simulation only — not available with real money</div>
        <p className="text-muted">{notice ?? "Binary options are banned for retail customers in the UK (FCA, since April 2019) and restricted across the EU/EEA."}</p>
      </div>
    </div>
  );
}

export function BinaryPage() {
  const { account, list, select } = useAccountParam();
  const cfg = useBinaryConfig();
  const overview = useMarketOverview();
  const portfolio = usePortfolio(account?.id);
  const [symbol, setSymbol] = useState("BTC-USD");
  const [direction, setDirection] = useState<BinaryDirection>("HIGHER");
  const [stake, setStake] = useState("1.00");
  const [expiry, setExpiry] = useState(60);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const open = useOpenBinary();
  const contracts = useBinaryContracts(account?.id, true);
  const stats = useBinaryStats(account?.id);
  const items = contracts.data?.items ?? [];
  const openItems = items.filter((c) => c.status === "OPEN");
  const settled = items.filter((c) => c.status !== "OPEN");
  const now = useNow(openItems.length > 0);

  const quote = useQuery({
    queryKey: ["instrument", symbol], refetchInterval: 1000,
    queryFn: () => api<InstrumentWithQuote>(`/markets/instruments/${encodeURIComponent(slug(symbol))}`),
  });
  const symbols = useMemo(() => Object.values(overview.data?.groups ?? {}).flat(), [overview.data]);
  const prices = useMemo(() => Object.fromEntries(symbols.map((s) => [s.instrument.symbol, s.quote])), [symbols]);
  const q = quote.data?.quote, inst = quote.data?.instrument;
  const mid = q ? (Number(q.bid) + Number(q.ask)) / 2 : null;
  const [chartTf, setChartTf] = useState("1m");
  const minute = useCandles(slug(symbol), chartTf, []);
  const strikes = useMemo<ChartPriceLine[]>(() => openItems.filter((c) => c.symbol === symbol).map((c) => ({
    id: c.id, price: Number(c.strike), title: c.direction === "HIGHER" ? "▲ strike" : "▼ strike",
    color: token(c.direction === "HIGHER" ? "--color-positive" : "--color-negative"),
  })), [openItems, symbol]);
  const tick = useMemo(() => (q && mid != null ? { t: Math.floor(Date.parse(q.as_of) / 1000), v: mid } : null), [q?.as_of, mid]); // eslint-disable-line react-hooks/exhaustive-deps
  const liveTick = useMemo(() => (tick ? { price: tick.v, at: new Date(tick.t * 1000).toISOString() } : null), [tick]);
  const ccy = account?.base_currency ?? "GBP";
  const payout = cfg.data?.payout_rate ?? 0.8;
  const breakEven = cfg.data?.break_even_win_rate ?? 1 / (1 + payout);
  const s = Number(stake) || 0;
  const equity = Number(portfolio.data?.equity ?? 0);
  const checks = open.error instanceof ApiError ? (open.error.details as { checks?: RiskCheck[] } | undefined)?.checks : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!account) return;
    try {
      await open.mutateAsync({ account_id: account.id, symbol, direction, stake, expiry_seconds: expiry, client_id: key.replace(/-/g, "").slice(0, 32) });
    } catch { /* shown through open.error, with the risk checks */ } finally { setKey(crypto.randomUUID()); }
  }

  if (list.length === 0) return <EmptyState title="No paper account">Create a paper account first (a £100 preset is available).</EmptyState>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-xl font-semibold tracking-tight">Binary options</h1>
          <p className="text-sm text-muted">Fixed-payout HIGHER / LOWER contracts on live prices, simulated with virtual money.</p></div>
        {list.length > 1 && (
          <Select aria-label="Account" className="h-9 w-56" value={account?.id} onChange={(e) => select(e.target.value)}>
            {list.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.base_currency}</option>)}
          </Select>)}
      </div>
      <Disclaimer notice={cfg.data?.notice} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,380px)_1fr]">
        <Card>
          <CardHeader title="New contract" description={`Win ${pct(payout, 0)} of your stake or lose all of it`} />
          <CardBody>
            <form onSubmit={submit} className="space-y-4">
              <Field label="Instrument" htmlFor="bin-symbol">
                <Select id="bin-symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
                  {(symbols.length ? symbols.map((x) => x.instrument.symbol) : ["BTC-USD"]).map((x) => <option key={x}>{x}</option>)}
                </Select>
              </Field>
              <div className="rounded-lg border border-border bg-surface-2 p-3" data-testid="binary-price">
                <div className="text-xs text-muted">Strike if opened now (mid price)</div>
                <div className="num text-2xl font-semibold">{mid == null ? "—" : formatPrice(mid, (inst?.price_decimals ?? 2) + 1)}</div>
                <div className="text-[11px] text-subtle">{q ? (q.tradable ? "Market open" : q.market_open ? "Quote stale" : "Market closed") : "Loading…"}</div>
              </div>
              <div className="grid grid-cols-2 gap-2" role="group" aria-label="Direction">
                <Button type="button" variant={direction === "HIGHER" ? "primary" : "secondary"} aria-pressed={direction === "HIGHER"}
                  className={cn(direction === "HIGHER" && "bg-positive hover:bg-positive/90")} onClick={() => setDirection("HIGHER")}><ArrowUp />Higher</Button>
                <Button type="button" variant={direction === "LOWER" ? "primary" : "secondary"} aria-pressed={direction === "LOWER"}
                  className={cn(direction === "LOWER" && "bg-negative hover:bg-negative/90")} onClick={() => setDirection("LOWER")}><ArrowDown />Lower</Button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label={`Stake (${ccy})`} htmlFor="bin-stake" hint={equity ? `${((s / equity) * 100).toFixed(2)}% of equity` : undefined}>
                  <Input id="bin-stake" inputMode="decimal" required pattern="^\d+(\.\d{1,2})?$" className="num" value={stake} onChange={(e) => setStake(e.target.value)} />
                </Field>
                <Field label="Expiry" htmlFor="bin-expiry">
                  <Select id="bin-expiry" value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
                    {(cfg.data?.expiries ?? [60, 300, 900, 3600, 86400]).map((x) => <option key={x} value={x}>{label(x)}</option>)}
                  </Select>
                </Field>
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg border border-border p-3 text-xs" data-testid="binary-maths">
                <dt className="text-muted">If right</dt><dd className="num text-right text-positive">+{formatMoney(s * payout, ccy)} (returns {formatMoney(s * (1 + payout), ccy)})</dd>
                <dt className="text-muted">If wrong</dt><dd className="num text-right text-negative">−{formatMoney(s, ccy)}</dd>
                <dt className="text-muted">Break-even win rate</dt><dd className="num text-right font-semibold">{pct(breakEven)}</dd>
                <dt className="text-muted">Expected at 50/50</dt><dd className="num text-right text-negative">{formatMoney(s * (0.5 * payout - 0.5), ccy)} per contract</dd>
              </dl>
              <ErrorBanner error={open.error} />
              {checks && <ChecksList checks={checks} compact />}
              {open.data && !open.isPending && !open.error && (
                <p className="text-xs text-positive" role="status">Opened {open.data.direction} {open.data.symbol} at {open.data.strike}, expires {formatDateTime(open.data.expires_at)}.</p>)}
              <Button type="submit" className="w-full" disabled={open.isPending || !account || !q?.tradable}>
                {open.isPending && <Spinner className="text-accent-fg" />}Open {direction === "HIGHER" ? "Higher" : "Lower"} contract
              </Button>
            </form>
          </CardBody>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title={`${symbol} · OHLC candles`} description={`${chartTf} candlesticks with live price ticks. Dashed lines are your open strikes.`}
              action={<div className="flex items-center gap-1"><SourceBadge source={minute.data?.source} />{[ "1m", "5m", "15m" ].map((tf) => (
                <button key={tf} onClick={() => setChartTf(tf)} aria-pressed={chartTf === tf}
                  className={cn("rounded border px-1.5 py-0.5 text-[11px]", chartTf === tf ? "border-accent/60 bg-accent/10 text-accent" : "border-border text-muted hover:text-fg")}>{tf}</button>
              ))}</div>} />
            <div className="px-2 pb-3">
              {minute.data && minute.data.candles.length > 0
                ? <PriceChart data={minute.data} decimals={(inst?.price_decimals ?? 2) + 1} height={260} live={liveTick} priceLines={strikes} testId="live-tick-chart" />
                : <div className="flex h-[260px] items-center justify-center"><Spinner /></div>}
              <p className="px-1 pt-2 text-[10px] text-subtle">
                {minute.data?.source === "coinbase" ? "Real public Coinbase OHLC candles" : "Simulated OHLC candles — not real market data"}. Paper contracts use {minute.data?.source === "coinbase" ? "public reference prices" : "simulated prices"}; no real money is traded.
              </p>
            </div>
          </Card>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="binary-stats">
            <Stat label="Win rate" value={pct(stats.data?.win_rate)} sub={`break-even ${pct(breakEven)}`}
              tone={stats.data?.win_rate == null ? "muted" : stats.data.win_rate >= breakEven ? "positive" : "negative"} />
            <Stat label="Net P&L" value={formatMoney(stats.data?.net_pnl ?? 0, ccy)} tone={Number(stats.data?.net_pnl ?? 0) >= 0 ? "positive" : "negative"}
              sub={`${stats.data?.won ?? 0} won · ${stats.data?.lost ?? 0} lost · ${stats.data?.ties ?? 0} tie`} />
            <Stat label="Return on stake" value={pct(stats.data?.return_on_stake)} sub={`staked ${formatMoney(stats.data?.staked ?? 0, ccy)}`} />
            <Stat label="At risk now" value={formatMoney(portfolio.data?.binary_at_risk ?? 0, ccy)} sub={`${openItems.length} open`} />
          </div>
          <Card>
            <CardHeader title="Open contracts" description="Settled automatically on the first price at or after expiry" />
            {openItems.length === 0 ? <EmptyState icon={<Timer />} title="No open contracts">Open one on the left.</EmptyState> : (
              <Table>
                <thead><tr><Th>Contract</Th><Th className="text-right">Stake</Th><Th className="text-right">Strike</Th><Th className="text-right">Now</Th><Th>Status</Th><Th className="text-right">Expires in</Th></tr></thead>
                <tbody>{openItems.map((c) => <OpenRow key={c.id} c={c} now={now} price={prices[c.symbol] ? (Number(prices[c.symbol]!.bid) + Number(prices[c.symbol]!.ask)) / 2 : c.symbol === symbol ? mid : null} />)}</tbody>
              </Table>)}
          </Card>
          <Card>
            <CardHeader title="History" description="Every settled contract, with the price it settled at" />
            {settled.length === 0 ? <EmptyState title="Nothing settled yet" /> : (
              <Table>
                <thead><tr><Th>Opened</Th><Th>Contract</Th><Th className="text-right">Strike → settle</Th><Th>Result</Th><Th className="text-right">P&L</Th></tr></thead>
                <tbody>{settled.map((c) => (
                  <Tr key={c.id}>
                    <Td className="num whitespace-nowrap text-xs text-muted">{formatDateTime(c.opened_at)}</Td>
                    <Td className="text-sm"><Dir d={c.direction} /> {c.symbol} · {label(c.expiry_seconds)}</Td>
                    <Td className="num text-right text-xs">{Number(c.strike)} → {c.settle_price == null ? "—" : Number(c.settle_price)}</Td>
                    <Td><Badge tone={STATUS_TONE[c.status]} title={c.void_reason ?? undefined}>{c.status}</Badge></Td>
                    <Td className={cn("num text-right", Number(c.pnl) > 0 ? "text-positive" : Number(c.pnl) < 0 ? "text-negative" : "text-muted")}>{formatMoney(c.pnl ?? 0, c.currency)}</Td>
                  </Tr>))}</tbody>
              </Table>)}
          </Card>
          {stats.data && Object.keys(stats.data.by_expiry).length > 0 && (
            <Card>
              <CardHeader title="By expiry" description="Are you beating the break-even rate anywhere? Small samples prove nothing." />
              <Table>
                <thead><tr><Th>Expiry</Th><Th className="text-right">Contracts</Th><Th className="text-right">Win rate</Th><Th className="text-right">Net P&L</Th></tr></thead>
                <tbody>{Object.entries(stats.data.by_expiry).map(([k, g]) => (
                  <Tr key={k}><Td>{label(Number(k))}</Td><Td className="num text-right">{g.contracts}</Td>
                    <Td className={cn("num text-right", g.win_rate != null && (g.win_rate >= breakEven ? "text-positive" : "text-negative"))}>{pct(g.win_rate)}</Td>
                    <Td className="num text-right">{formatMoney(g.net_pnl, ccy)}</Td></Tr>))}</tbody>
              </Table>
            </Card>)}
        </div>
      </div>
    </div>
  );
}

function Dir({ d }: { d: BinaryDirection }) {
  return d === "HIGHER" ? <span className="text-positive">▲ Higher</span> : <span className="text-negative">▼ Lower</span>;
}

function OpenRow({ c, now, price }: { c: BinaryContract; now: number; price: number | null }) {
  const strike = Number(c.strike);
  const winning = price == null || price === strike ? null : c.direction === "HIGHER" ? price > strike : price < strike;
  return (
    <Tr data-testid="binary-open-row">
      <Td className="text-sm"><Dir d={c.direction} /> {c.symbol}</Td>
      <Td className="num text-right">{formatMoney(c.stake, c.currency)}</Td>
      <Td className="num text-right">{strike}</Td>
      <Td className="num text-right">{price == null ? "—" : Number(price.toPrecision(10))}</Td>
      <Td>{winning == null ? <Badge tone="neutral">Level</Badge> : winning ? <Badge tone="positive">In the money</Badge> : <Badge tone="negative">Out of the money</Badge>}</Td>
      <Td className="num text-right">{countdown(new Date(c.expires_at).getTime() - now)}</Td>
    </Tr>
  );
}
