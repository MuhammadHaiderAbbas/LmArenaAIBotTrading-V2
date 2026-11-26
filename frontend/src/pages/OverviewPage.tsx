import { Activity, Bot, CandlestickChart, Briefcase, CircleDollarSign, Landmark, Plus, ShieldAlert, TrendingUp, Wallet } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorBanner, Spinner } from "@/components/ui/feedback";
import { Stat } from "@/components/ui/stat";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { CreateAccountDialog } from "@/features/accounts/CreateAccountDialog";
import { useAccounts, useMyActivity } from "@/features/accounts/hooks";
import { useActiveAccountId } from "@/features/accounts/activeAccount";
import { useLiveQuotes, useWatchlist } from "@/features/markets/hooks";
import { PortfolioChart } from "@/charts/PortfolioChart";
import { useLiveEquity } from "@/features/live/stream";
import { usePortfolio, usePortfolioHistory } from "@/features/trading/hooks";
import { useRiskOverview } from "@/features/risk/hooks";
import { Change, QuoteState, SourceBadge } from "@/pages/MarketsPage";
import { useAuth } from "@/features/auth/AuthProvider";
import { formatMoney, formatPrice, relativeTime, sumDecimals } from "@/lib/utils";
import type { TradingAccount } from "@/services/api";

const ACTION_LABELS: Record<string, string> = {
  "auth.register": "Account registered",
  "auth.login": "Signed in",
  "auth.logout": "Signed out",
  "auth.password_change": "Password changed",
  "account.paper.create": "Paper account created",
  "wallet.deposit": "Virtual deposit",
  "wallet.withdraw": "Virtual withdrawal",
  "user.settings.update": "Settings updated",
  "research.ask": "Research report generated",
  "research.document.add": "Research document indexed",
  "research.samples.load": "Sample research corpus loaded",
  "ai.run": "Agent analysis run",
  "ai.proposal.dismiss": "Trade proposal dismissed",
  "ai.agent.update": "Agent configuration changed",
  "ml.train": "Model trained and validated",
  "ml.promote": "Model promoted to champion",
  "ml.retire": "Model retired",
  "ml.drift_check": "Model drift check",
  "backtest.run": "Backtest run",
  "order.submit": "Paper order submitted",
  "order.cancel": "Paper order cancelled",
  "admin.bootstrap": "Administrator account created",
  "admin.user.update": "User updated by administrator",
};

function totalsByCurrency(accounts: TradingAccount[]) {
  const map = new Map<string, { equity: string[]; cash: string[] }>();
  for (const a of accounts) {
    const e = map.get(a.base_currency) ?? { equity: [], cash: [] };
    e.equity.push(a.equity); e.cash.push(a.cash_balance);
    map.set(a.base_currency, e);
  }
  return [...map.entries()].map(([ccy, v]) => ({ ccy, equity: sumDecimals(v.equity), cash: sumDecimals(v.cash) }));
}

export function OverviewPage() {
  const { user } = useAuth();
  const accounts = useAccounts();
  const activity = useMyActivity();
  const [creating, setCreating] = useState(false);
  const list = accounts.data ?? [];
  const activeId = useActiveAccountId();
  const current = list.find((a) => a.id === activeId) ?? list[0];
  const totals = totalsByCurrency(list);
  const primary = totals[0];
  const portfolio = usePortfolio(current?.id);
  const pf = portfolio.data;
  const history = usePortfolioHistory(current?.id);
  const liveEquity = useLiveEquity(current?.id);
  const risk = useRiskOverview(current?.id).data;
  const pnl = pf ? Number(pf.unrealised_pnl) + Number(pf.realised_pnl) : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-subtle">Welcome back</p>
          <h2 className="text-2xl font-semibold tracking-tight">{user?.full_name}</h2>
        </div>
        <Button onClick={() => setCreating(true)}><Plus />New paper account</Button>
      </div>

      <ErrorBanner error={accounts.error} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Total equity" icon={<Landmark />} className="col-span-2 md:col-span-1"
          value={primary ? formatMoney(primary.equity, primary.ccy) : "—"}
          sub={totals.length > 1 ? totals.slice(1).map((t) => formatMoney(t.equity, t.ccy)).join(" · ") : `${list.length} paper account${list.length === 1 ? "" : "s"}`} />
        <Stat label="Available cash" icon={<CircleDollarSign />}
          value={primary ? formatMoney(primary.cash, primary.ccy) : "—"} sub="Virtual capital" />
        <Stat label="Total P&L" icon={<TrendingUp />} value={pf ? `${pnl > 0 ? "+" : ""}${formatMoney(pnl, pf.currency)}` : "—"}
          tone={pnl > 0 ? "positive" : pnl < 0 ? "negative" : "muted"} sub={pf ? `Realised + unrealised · ${pf.account_name}` : "No trades executed"} />
        <Stat label="Open positions" icon={<Briefcase />} value={<Link to="/portfolio" className="hover:text-accent">{pf?.open_positions ?? 0}</Link>}
          tone={pf?.open_positions ? undefined : "muted"} sub={pf ? `Exposure ${(pf.exposure * 100).toFixed(1)}%` : "Paper execution"} />
        <Stat label="Drawdown" icon={<ShieldAlert />} value={risk ? `${risk.metrics.drawdown_pct.toFixed(2)}%` : "—"}
          tone={risk?.state.blocked_reason ? "negative" : "muted"}
          sub={risk ? (risk.state.blocked_reason ? "New exposure blocked" : `Limit ${risk.limits.max_drawdown_pct}% · risk gate on`) : "Risk engine"} />
        <Stat label="AI agents" icon={<Bot />} className="col-span-2 md:col-span-1" value={<span className="flex items-center gap-2 text-base"><StatusDot tone={risk?.autopilot.status === "RUNNING" ? "positive" : "accent"} /> {risk?.autopilot.status === "RUNNING" ? "Autopilot on" : "Advisory"}</span>}
          sub={risk?.autopilot.status === "RUNNING" ? `${risk.autopilot.symbols.join(", ")} · via risk gate` : "Proposals go through the risk gate"} />
      </div>

      {pf && (history.data?.length ?? 0) + liveEquity.length >= 2 && (
        <Card>
          <CardHeader title={`Live equity · ${pf.account_name}`}
            description={`${formatMoney(pf.equity, pf.currency)} marked to market on live prices, updated every 2 seconds`}
            action={<Link to={`/portfolio?account=${pf.account_id}`} className="text-xs text-accent hover:underline">Portfolio</Link>} />
          <div className="px-2 pb-3"><PortfolioChart snapshots={history.data ?? []} live={liveEquity} height={180} /></div>
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader title="Paper accounts" description="Balances derived from the double-entry ledger"
            action={<Link to="/wallet" className="text-xs text-accent hover:underline">Open wallet</Link>} />
          {accounts.isLoading ? (
            <div className="p-8"><Spinner className="mx-auto" /></div>
          ) : list.length === 0 ? (
            <EmptyState icon={<Wallet />} title="No paper accounts yet">
              Create a paper account to receive a virtual starting balance.
              <div className="mt-4"><Button size="sm" onClick={() => setCreating(true)}><Plus />Create paper account</Button></div>
            </EmptyState>
          ) : (
            <Table>
              <thead><tr><Th>Account</Th><Th>Mode</Th><Th className="text-right">Cash</Th><Th className="text-right">Equity</Th><Th>Status</Th></tr></thead>
              <tbody>
                {list.map((a) => (
                  <Tr key={a.id}>
                    <Td><Link to={`/wallet?account=${a.id}`} className="font-medium hover:text-accent">{a.name}</Link>
                      <div className="text-[11px] text-subtle">{a.base_currency}</div></Td>
                    <Td><Badge tone="accent">{a.mode}</Badge></Td>
                    <Td className="num text-right">{formatMoney(a.cash_balance, a.base_currency)}</Td>
                    <Td className="num text-right font-medium">{formatMoney(a.equity, a.base_currency)}</Td>
                    <Td><Badge tone={a.status === "ACTIVE" ? "positive" : "neutral"}>{a.status}</Badge></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader title="Activity timeline" description="Your audited actions" />
          <CardBody className="p-0">
            {activity.isLoading ? <div className="p-8"><Spinner className="mx-auto" /></div> :
              (activity.data ?? []).length === 0 ? <EmptyState icon={<Activity />} title="No activity yet" /> : (
                <ol className="divide-y divide-border/60">
                  {activity.data!.map((ev) => (
                    <li key={ev.id} className="flex items-start gap-3 px-5 py-3">
                      <span className="mt-1.5"><StatusDot tone={ev.outcome === "success" ? "positive" : "negative"} /></span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm">{ACTION_LABELS[ev.action] ?? ev.action}
                          {typeof ev.details.amount === "string" && (
                            <span className="num text-muted"> · {formatMoney(ev.details.amount, String(ev.details.currency ?? "USD"))}</span>
                          )}
                        </p>
                        <p className="text-[11px] text-subtle">{relativeTime(ev.occurred_at)}{ev.ip_address && ` · ${ev.ip_address}`}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
          </CardBody>
        </Card>
      </div>

      <MarketSnapshot />

      <Card>
        <CardHeader title="Platform roadmap" description="All twelve phases have shipped. What comes next is gated, not scheduled." />
        <CardBody className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Live trading", "Stage 2", "Only after every go-live gate and a reviewed code change"],
          ].map(([t, p, d]) => (
            <div key={t} className="rounded-md border border-border bg-surface-2 p-3">
              <div className="flex items-center justify-between"><span className="text-sm font-medium">{t}</span><Badge>{p}</Badge></div>
              <p className="mt-1 text-xs text-muted">{d}</p>
            </div>
          ))}
        </CardBody>
      </Card>

      <CreateAccountDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function MarketSnapshot() {
  const wl = useWatchlist();
  const items = wl.data?.items ?? [];
  const { quotes } = useLiveQuotes(items.map((i) => i.instrument.symbol));
  return (
    <Card>
      <CardHeader title="Watchlist" description="Live quotes from the market-data service"
        action={<Link to="/markets" className="text-xs text-accent hover:underline">Open markets</Link>} />
      {wl.isLoading ? <div className="p-8"><Spinner className="mx-auto" /></div> : items.length === 0 ? (
        <EmptyState icon={<CandlestickChart />} title="Your watchlist is empty" />
      ) : (
        <div className="grid divide-border/60 sm:grid-cols-2 sm:divide-x lg:grid-cols-4">
          {items.slice(0, 8).map((i) => {
            const q = quotes[i.instrument.symbol] ?? i.quote;
            return (
              <Link key={i.instrument.symbol} to={`/markets?symbol=${i.instrument.slug}`} className="border-b border-border/60 p-4 hover:bg-surface-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{i.instrument.symbol}</span>
                  <QuoteState q={q} />
                </div>
                <div className="num mt-1 text-lg font-semibold">{formatPrice(q?.last, i.instrument.price_decimals)}</div>
                <div className="flex items-center justify-between text-xs"><Change q={q} /><SourceBadge source={q?.source} /></div>
              </Link>
            );
          })}
        </div>
      )}
    </Card>
  );
}
