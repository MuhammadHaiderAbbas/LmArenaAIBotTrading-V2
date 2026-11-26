import { LogOut, Menu, X } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet, useLocation, useSearchParams } from "react-router-dom";
import { Badge, StatusDot } from "@/components/ui/badge";
import { useAccounts, useSystemInfo } from "@/features/accounts/hooks";
import { useActiveAccountId } from "@/features/accounts/activeAccount";
import { setActiveAccountId } from "@/features/accounts/activeAccount";
import { useAccountParam } from "@/features/trading/useAccountParam";
import { useAuth } from "@/features/auth/AuthProvider";
import { useAccountStream, useLiveMode } from "@/features/live/stream";
import { useSystemHalt } from "@/features/risk/hooks";
import { isDemo } from "@/services/api";
import { cn } from "@/lib/utils";
import { NAV } from "./nav";
import { PaperTradingBanner } from "./PaperTradingBanner";

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-8" />
      <div className="leading-tight">
        <div className="text-[15px] font-bold tracking-[0.18em]">AUREX<span className="text-accent"> AI</span></div>
        <div className="text-[10px] uppercase tracking-wider text-subtle">Trading Intelligence Terminal</div>
      </div>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useAuth();
  return (
    <nav aria-label="Main" className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-4">
      {NAV.filter((n) => !n.adminOnly || user?.role === "admin").map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === "/"}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              "group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
              isActive ? "bg-surface-3 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
            )
          }
        >
          {({ isActive }) => (
            <>
              <item.icon className={cn("size-4 shrink-0", isActive && "text-accent")} />
              <span className="flex-1 truncate">{item.label}</span>
              {item.phase && <span className="text-[10px] text-subtle">P{item.phase}</span>}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

function AccountPicker() {
  const accounts = useAccounts();
  const active = useActiveAccountId();
  const [params, setParams] = useSearchParams();
  const list = accounts.data ?? [];
  const id = list.find((a) => a.id === active)?.id ?? list[0]?.id ?? "";
  return (
    <select
      aria-label="Active paper account"
      title="The account used by trading, portfolio and risk pages"
      className="hidden max-w-44 rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-fg md:block"
      value={id}
      onChange={(e) => {
        setActiveAccountId(e.target.value);
        const next = new URLSearchParams(params);
        if (e.target.value) next.set("account", e.target.value); else next.delete("account");
        setParams(next);
      }}
    >
      {list.length === 0 && <option value="">No paper account</option>}
      {list.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.base_currency}</option>)}
    </select>
  );
}

function useAccountParamSync() {
  useAccountParam();
}

function LiveBadge() {
  const { mode } = useLiveMode();
  const label = mode === "live" ? "Live" : mode === "polling" ? "Live · polling" : mode === "connecting" ? "Connecting" : "Offline";
  const tone = mode === "live" || mode === "polling" ? "positive" : mode === "connecting" ? "warning" : "neutral";
  return (
    <Badge tone={tone} data-testid="live-status" title={mode === "live" ? "Trades, fills, balances and valuations stream over a WebSocket"
      : mode === "polling" ? "Refreshing every 2 seconds" : "Live updates are not connected"}>
      <StatusDot tone={tone} /> <span className={cn(mode === "live" && "animate-pulse")}>{label}</span>
    </Badge>
  );
}

export function AppShell() {
  const halt = useSystemHalt();
  const auth = useAuth();
  useAccountStream(!!auth.user);
  const { user, logout } = useAuth();
  const info = useSystemInfo();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  // Keep a single validated account selection for every route (including deep links).
  useAccountParamSync();
  const current = NAV.find((n) => (n.to === "/" ? location.pathname === "/" : location.pathname.startsWith(n.to)));

  return (
    <div className="flex h-full">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 print:hidden shrink-0 flex-col border-r border-border bg-surface lg:flex">
        <div className="border-b border-border px-5 py-4"><Logo /></div>
        <Sidebar />
        <div className="border-t border-border px-5 py-3 text-[11px] text-subtle">
          v{info.data?.version ?? "—"} · {info.data?.environment ?? "—"}
          {isDemo && <p className="mt-1 leading-snug">Demo data is stored only in this browser.</p>}
        </div>
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-border bg-surface">
            <div className="flex items-center justify-between border-b border-border px-4 py-4">
              <Logo />
              <button onClick={() => setOpen(false)} aria-label="Close menu" className="text-muted"><X className="size-5" /></button>
            </div>
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <PaperTradingBanner />
        {isDemo && (
          <div data-testid="demo-banner" className="print:hidden border-b border-info/40 bg-info/10 px-4 py-2 text-center text-xs font-medium text-info">
            SIMULATED DATA — accounts, ledger and non-crypto prices are generated in this browser. Crypto candles use public Coinbase data when reachable. Virtual money only.
          </div>
        )}
        <header className="flex h-14 print:hidden shrink-0 items-center gap-3 border-b border-border bg-surface/80 px-4 backdrop-blur lg:px-6">
          <button className="text-muted lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><Menu className="size-5" /></button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold">{current?.label ?? "AUREX AI"}</h1>
            <p className="hidden truncate text-xs text-muted sm:block">{current?.description}</p>
          </div>
          <AccountPicker />
          <LiveBadge />
          {isDemo && <Badge tone="info" title="Static demo: runs entirely in your browser with simulated data">Demo</Badge>}
          <Badge tone="accent" title="Virtual capital only. No real money is traded.">
            <StatusDot tone="accent" /> Paper mode
          </Badge>
          {halt.data?.halted ? (
            <Badge tone="negative" title={`Platform trading halted: ${halt.data.reason ?? ""}. Exits and protective stops still work.`}>
              <StatusDot tone="negative" /> Trading halted
            </Badge>
          ) : (
            <Badge tone="neutral" className="hidden md:inline-flex" title="Every order, manual or AI, passes the independent risk engine">
              <StatusDot tone="positive" /> Risk gate on
            </Badge>
          )}
          <div className="hidden text-right sm:block">
            <div className="text-xs font-medium">{user?.full_name}</div>
            <div className="text-[11px] capitalize text-subtle">{user?.role}</div>
          </div>
          <button onClick={() => logout()} className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-fg" aria-label="Sign out" title="Sign out">
            <LogOut className="size-4" />
          </button>
        </header>
        <main className="flex-1 overflow-y-auto print:overflow-visible">
          <div className="mx-auto max-w-[1400px] p-4 lg:p-6"><Outlet /></div>
        </main>
      </div>
    </div>
  );
}
