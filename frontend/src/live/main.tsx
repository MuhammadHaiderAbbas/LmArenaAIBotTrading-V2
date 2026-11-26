import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@supabase/supabase-js";
import { CandlestickSeries, ColorType, createChart, type IChartApi, type UTCTimestamp } from "lightweight-charts";
import "./live.css";

const SUPABASE_URL = String(import.meta.env.VITE_SUPABASE_URL ?? "");
const SUPABASE_ANON_KEY = String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? "");
const DEMO_URL = import.meta.env.BASE_URL.endsWith("/live/") ? "../" : "/";
const SOFT_BANNER = `<div data-testid="paper-trading-banner" class="soft-banner">` +
  `PAPER TRADING ONLY · VIRTUAL CAPITAL · NO REAL MONEY OR LIVE ORDERS · ` +
  `<a href="${DEMO_URL}status">Status</a> · <a href="${DEMO_URL}feedback">Feedback</a></div>`;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  document.getElementById("root")!.innerHTML =
    `<div class="wrap">${SOFT_BANNER}<div class="card"><h2>Live build is not configured</h2>` +
    '<p class="muted">Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY at build time, then rebuild.</p></div></div>';
  throw new Error("Live build missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storage: {
      getItem: (key: string) => sessionStorage.getItem(key),
      setItem: (key: string, value: string) => sessionStorage.setItem(key, value),
      removeItem: (key: string) => sessionStorage.removeItem(key),
    },
  },
});
const EDGE = `${SUPABASE_URL}/functions/v1`;
const SYMBOL = "BTC-USD";
const IDLE_MS = 15 * 60 * 1000;

function SoftLaunchBanner() {
  return <div data-testid="paper-trading-banner" className="soft-banner">
    PAPER TRADING ONLY · VIRTUAL CAPITAL · NO REAL MONEY OR LIVE ORDERS ·{" "}
    <a href={`${DEMO_URL}status`}>Status</a> · <a href={`${DEMO_URL}feedback`}>Feedback</a>
  </div>;
}

type Account = { account_id: string; currency: string; balance: number };
type Quote = { price: number; source: string; captured_at: string; tradable: boolean };
type Candle = { time: number; open: number; high: number; low: number; close: number };
type Enrol = { factorId: string; secret: string; uri: string };

async function edge(path: string, options: RequestInit = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in first");
  let response: Response;
  try {
    response = await fetch(`${EDGE}/${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers ?? {}) },
    });
  } catch {
    throw new Error("Cannot reach the live API. It may be waking after a free-tier pause — retry shortly.");
  }
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    if (response.status >= 500) throw new Error("Live API or provider is temporarily unavailable — retry shortly.");
    throw new Error(payload?.error ?? `HTTP ${response.status}`);
  }
  return payload;
}

function PriceChart({ candles }: { candles: Candle[] }) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candleSeries = useRef<any>(null);

  useEffect(() => {
    if (!host.current) return;
    const c = createChart(host.current, {
      layout: { background: { type: ColorType.Solid, color: "#121922" }, textColor: "#93a2b5" },
      grid: { vertLines: { color: "#1e2835" }, horzLines: { color: "#1e2835" } },
      rightPriceScale: { borderColor: "#26313f" },
      timeScale: { borderColor: "#26313f" },
      crosshair: { vertLine: { color: "#5eead4" }, horzLine: { color: "#5eead4" } },
    });
    candleSeries.current = c.addSeries(CandlestickSeries, {
      upColor: "#34d399", downColor: "#f87171", borderUpColor: "#34d399", borderDownColor: "#f87171",
      wickUpColor: "#34d399", wickDownColor: "#f87171",
    });
    chart.current = c;
    const observer = new ResizeObserver(() => c.applyOptions({ width: host.current?.clientWidth ?? 800 }));
    observer.observe(host.current);
    return () => { observer.disconnect(); c.remove(); chart.current = null; };
  }, []);

  useEffect(() => {
    const series = candleSeries.current;
    if (!series || !candles.length) return;
    series.setData(candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
    chart.current?.timeScale().fitContent();
  }, [candles]);

  return <div ref={host} className="chart" data-testid="edge-chart" />;
}

function App() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [mfaReady, setMfaReady] = useState(false);
  const [needEnrol, setNeedEnrol] = useState(false);
  const [challengeFactor, setChallengeFactor] = useState<string | null>(null);
  const [enrol, setEnrol] = useState<Enrol | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState("");
  const [amount, setAmount] = useState("50");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);

  const loadData = useCallback(async () => {
    const acc = await edge("accounts");
    setAccounts(acc.accounts ?? []);
    setAccountId((current) => current || acc.accounts?.[0]?.account_id || "");
    setQuote(await edge(`quote?symbol=${SYMBOL}`));
    const c = await edge(`candles?symbol=${SYMBOL}&granularity=3600`);
    setCandles(c.candles ?? []);
  }, []);

  const checkMfa = useCallback(async () => {
    const { data: factorsData } = await supabase.auth.mfa.listFactors();
    const factors = ((factorsData as any)?.totp ?? []) as { id: string; status: string }[];
    const verified = factors.find((f) => f.status === "verified");
    if (!verified) { setNeedEnrol(true); setMfaReady(false); return; }
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.nextLevel === "aal2" && aal.currentLevel !== "aal2") {
      setChallengeFactor(verified.id); setMfaReady(false);
    } else {
      setChallengeFactor(null); setNeedEnrol(false); setMfaReady(true);
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSignedIn(!!data.session);
      if (data.session) void checkMfa();
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setSignedIn(!!session);
      if (session) void checkMfa();
      else { setMfaReady(false); setNeedEnrol(false); setEnrol(null); setChallengeFactor(null); }
    });
    return () => sub.subscription.unsubscribe();
  }, [checkMfa]);

  useEffect(() => {
    if (!mfaReady) return;
    let live = true;
    (async () => {
      try {
        await edge("profile", { method: "POST", body: JSON.stringify({ full_name: email.split("@")[0] || "AUREX user" }) });
        await loadData();
      } catch (e) { if (live) setMessage((e as Error).message); }
    })();
    const timer = setInterval(async () => {
      try { setQuote(await edge(`quote?symbol=${SYMBOL}`)); } catch { /* keep last quote */ }
    }, 15000);
    return () => { live = false; clearInterval(timer); };
  }, [mfaReady, loadData, email]);

  useEffect(() => {
    if (!signedIn) return;
    let timer: number;
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { void supabase.auth.signOut({ scope: "global" }); }, IDLE_MS);
    };
    arm();
    const events = ["click", "keydown", "mousemove"];
    events.forEach((e) => window.addEventListener(e, arm, { passive: true }));
    return () => { window.clearTimeout(timer); events.forEach((e) => window.removeEventListener(e, arm)); };
  }, [signedIn]);

  async function signIn() {
    setBusy(true); setMessage("");
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await checkMfa();
    } catch (e) { setMessage((e as Error).message); }
    finally { setBusy(false); }
  }

  async function signUp() {
    setBusy(true); setMessage("");
    try {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
      setMessage("Check your inbox to confirm the email, then sign in. TOTP setup comes next.");
    } catch (e) { setMessage((e as Error).message); }
    finally { setBusy(false); }
  }

  async function startEnrol() {
    setBusy(true); setMessage("");
    try {
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "AUREX live" });
      if (error) throw error;
      setEnrol({ factorId: data.id, secret: (data as any).totp.secret, uri: (data as any).totp.uri });
    } catch (e) { setMessage((e as Error).message); }
    finally { setBusy(false); }
  }

  async function verifyCode() {
    setBusy(true); setMessage("");
    try {
      const factorId = enrol?.factorId ?? challengeFactor;
      if (!factorId) throw new Error("No authenticator factor");
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
      if (error) throw error;
      setEnrol(null); setNeedEnrol(false); setChallengeFactor(null); setCode(""); setMfaReady(true);
      await loadData();
    } catch (e) { setMessage((e as Error).message); }
    finally { setBusy(false); }
  }

  async function deposit() {
    setBusy(true); setMessage("");
    try {
      await edge("deposit", { method: "POST", body: JSON.stringify({ account_id: accountId, amount: Number(amount) }) });
      await loadData();
      setMessage("Virtual deposit posted to the double-entry ledger.");
    } catch (e) { setMessage((e as Error).message); }
    finally { setBusy(false); }
  }

  async function signOut() {
    await supabase.auth.signOut({ scope: "global" });
    setSignedIn(false); setMfaReady(false);
  }

  if (!signedIn) {
    return <div className="wrap">
      <SoftLaunchBanner />
      <header><h1>AUREX Live</h1><span className="badge ok">REAL API</span><span className="badge warn">PAPER ONLY · MFA REQUIRED</span><a className="badge" href={DEMO_URL}>Simulated demo</a></header>
      <div className="card">
        <h2>Sign in with Supabase Auth</h2>
        <label htmlFor="live-email">Email</label>
        <input id="live-email" aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        <label htmlFor="live-password">Password</label>
        <input id="live-password" aria-label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        <div className="row"><button className="primary" disabled={busy} onClick={signIn}>Sign in</button><button disabled={busy} onClick={signUp}>Create account</button></div>
        {message && <p className={message.includes("Check") ? "notice" : "error"}>{message}</p>}
        <p className="muted">Stage 1: virtual capital only. Sessions use browser-session storage and expire after 15 minutes of inactivity.</p>
      </div>
    </div>;
  }

  if (needEnrol || challengeFactor || enrol) {
    return <div className="wrap">
      <SoftLaunchBanner />
      <header><h1>AUREX Live</h1><span className="badge ok">REAL API</span><span className="badge warn">PAPER ONLY</span><span className="badge">SECURITY STEP</span><a className="badge" href={DEMO_URL}>Simulated demo</a><button style={{ marginLeft: "auto" }} onClick={signOut}>Sign out everywhere</button></header>
      <div className="card">
        <h2>{enrol ? "Set up two-factor authentication" : challengeFactor ? "Enter your authenticator code" : "Two-factor authentication is required"}</h2>
        {enrol ? (
          <>
            <p className="muted">Scan the QR code or add this secret to your authenticator app, then enter the 6-digit code.</p>
            <p>Secret: <code data-testid="mfa-secret">{enrol.secret}</code></p>
          </>
        ) : challengeFactor ? (
          <p className="muted">Your session needs a second factor before any account data is shown.</p>
        ) : (
          <button className="primary" disabled={busy} onClick={startEnrol}>Enrol authenticator</button>
        )}
        {(enrol || challengeFactor) && <>
          <label htmlFor="mfa-code">Authenticator code</label>
          <input id="mfa-code" aria-label="Authenticator code" data-testid="mfa-code" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          <button className="primary" disabled={busy || code.length !== 6} onClick={verifyCode}>Verify code</button>
        </>}
        {message && <p className="error">{message}</p>}
      </div>
    </div>;
  }

  if (!mfaReady) return <div className="wrap"><SoftLaunchBanner /><p className="muted">Checking your session…</p>{message && <p className="error">{message}</p>}</div>;

  const selected = accounts.find((a) => a.account_id === accountId);
  const lastCandleTime = candles.at(-1)?.time ?? 0;

  return <div className="wrap">
    <SoftLaunchBanner />
    <header>
      <h1>AUREX Live</h1>
      <span className="badge warn">PAPER ONLY</span>
      <span className="badge ok">MFA · AAL2</span>
      <span className="badge ok">LIVE COINBASE DATA</span>
      <span className="badge ok">REAL API</span>
      <span className="badge">EDGE FUNCTIONS</span>
      <a className="badge" href={DEMO_URL}>Static demo (simulated)</a>
      <button style={{ marginLeft: "auto" }} onClick={signOut}>Sign out everywhere</button>
    </header>

    <div className="grid">
      <div className="card">
        <h2>Paper account</h2>
        <div className="muted">Balance</div>
        <div className="kpi" data-testid="edge-balance">{selected ? `${selected.currency} ${Number(selected.balance).toFixed(2)}` : "—"}</div>
        <p className="muted">{accounts.length} account(s) · {accountId.slice(0, 8) || "—"}</p>
        <label htmlFor="live-amount">Deposit virtual cash</label>
        <input id="live-amount" aria-label="Deposit amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        <button className="primary" disabled={busy || !accountId} onClick={deposit}>Deposit virtual cash</button>
      </div>

      <div className="card">
        <h2>{SYMBOL} live quote</h2>
        <div className="kpi" data-testid="edge-price">{quote ? `$${Number(quote.price).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}</div>
        <p className="muted">{quote ? `${quote.source} · ${new Date(quote.captured_at).toLocaleTimeString()} · tradable=${quote.tradable}` : "Connecting…"}</p>
        <button onClick={async () => setQuote(await edge(`quote?symbol=${SYMBOL}`))}>Refresh quote</button>
      </div>
    </div>

    <div className="card">
      <h2>Live candles · 1h · Coinbase</h2>
      <PriceChart candles={candles} />
      <p className="muted">{candles.length} candles · source Coinbase · {lastCandleTime ? new Date(lastCandleTime * 1000).toLocaleString() : "—"}</p>
    </div>

    {message && <p className={message.includes("posted") ? "notice" : "error"}>{message}</p>}
    <p className="muted">Real Supabase Edge API · real Coinbase prices · virtual capital only (not the simulated demo). Shared rate limits via Postgres · Session: sessionStorage, 15-minute idle timeout, global sign-out · No secrets in this bundle.</p>
  </div>;
}

createRoot(document.getElementById("root")!).render(<App />);
