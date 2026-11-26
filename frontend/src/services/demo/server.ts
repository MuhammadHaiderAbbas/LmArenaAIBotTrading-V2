/**
 * In-browser implementation of the AUREX REST API for the static GitHub Pages demo.
 *
 * It mirrors the backend's contract and business rules (validation, double-entry
 * postings, idempotency, audit hash chain, RBAC) so the real UI runs unchanged.
 * Everything is stored in this browser's localStorage — it is a demonstration, not
 * a security boundary, and no data leaves the device.
 */
import { fromUnits, toUnits } from "@/lib/utils";
import { INSTRUMENTS } from "./instruments";
import * as mkt from "./market";
import * as rs from "./research";
import * as ag from "./agents";
import * as ml from "./ml";
import * as bt from "./backtest";
import * as risk from "./risk";
import * as an from "./analytics";
import * as totp from "./totp";

const KEY = "aurex-demo-v1";
const REFRESH_KEY = "aurex-demo-refresh";
const MAX_BALANCE = toUnits("10000000");
const MIN_ORDER_VALUE = 1;   // account currency; entry orders only (mirrors AUREX_MIN_ORDER_VALUE)
const MONEY_RE = /^\d+(\.\d{1,8})?$/;
const CURRENCIES = ["USD", "GBP", "EUR"];
const CHART: [string, string, string][] = [
  ["CASH", "ASSET", "Cash"], ["INVESTMENTS", "ASSET", "Investments at cost"],
  ["OPENING_EQUITY", "EQUITY", "Opening equity"], ["CAPITAL_CONTRIBUTIONS", "EQUITY", "Capital contributions"],
  ["CAPITAL_WITHDRAWALS", "EQUITY", "Capital withdrawals"], ["REALISED_PNL", "INCOME", "Realised profit and loss"],
  ["FEES", "EXPENSE", "Trading fees"],
];
const DEBIT_NORMAL = new Set(["ASSET", "EXPENSE"]);

interface DUser { id: string; email: string; full_name: string; pw: string; salt: string; role: "admin" | "user"; is_active: boolean; created_at: string; last_login_at: string | null;
  // Demo only: the seed lives in this browser's localStorage. The real backend encrypts it with AES-GCM.
  mfa_enabled?: boolean; mfa_secret?: string | null; mfa_pending?: string | null; mfa_last_step?: number | null; mfa_recovery?: string[] | null }
interface DSession { id: string; user_id: string; access: string; refresh: string; family: string; revoked: string | null; reason: string | null; created_at?: string; user_agent?: string }
interface DEntry { ledger_code: string; direction: "DEBIT" | "CREDIT"; amount: string; currency: string }
interface DTxn { id: string; account_id: string; type: string; description: string; created_at: string; created_by: string; idem: string | null; entries: DEntry[] }
interface DAccount { id: string; owner_id: string; name: string; mode: "PAPER"; base_currency: string; status: "ACTIVE"; created_at: string }
interface DAudit { id: number; occurred_at: string; actor_user_id: string | null; action: string; resource_type: string | null; resource_id: string | null; outcome: string; ip_address: string | null; request_id: string | null; details: Record<string, unknown>; prev_hash: string; hash: string }
interface DOrder { id: string; account_id: string; user_id: string; symbol: string; side: "BUY" | "SELL"; type: "MARKET" | "LIMIT" | "STOP"; quantity: string; limit_price: string | null; stop_price: string | null; time_in_force: "GTC" | "DAY"; status: string; filled_qty: string; avg_fill_price: string | null; client_order_id: string | null; source: string; reject_reason: string | null; expires_at: string | null; created_at: string; updated_at: string; events: { type: string; detail: Record<string, unknown>; created_at: string }[]; stop_loss: string | null; take_profit: string | null; parent_order_id: string | null; oco_group: string | null; proposal_id: string | null }
interface DRisk extends risk.Limits { kill_switch: boolean; kill_reason: string | null; kill_engaged_at: string | null; daily_halt_date: string | null; drawdown_halted: boolean; drawdown_halted_at: string | null; peak_pnl_equity: number | null; day_date: string | null; day_start_pnl_equity: number | null; day_start_equity: number | null; autopilot_status: "STOPPED" | "RUNNING" | "PAUSED"; autopilot_symbols: string[]; autopilot_last_cycle_at: string | null; binary_enabled?: boolean }
interface DBinary { id: string; account_id: string; user_id: string; symbol: string; direction: "HIGHER" | "LOWER"; stake: string; currency: string; payout_rate: number; strike: string; expiry_seconds: number; opened_at: string; expires_at: string; status: "OPEN" | "WON" | "LOST" | "TIE" | "VOID"; settle_price: string | null; settle_price_at: string | null; settled_at: string | null; returned: string | null; pnl: string | null; void_reason: string | null; client_id: string | null }
interface DDecision { id: string; account_id: string; order_id: string | null; binary_id?: string | null; proposal_id: string | null; source: string; symbol: string; side: string; approved: boolean; reason: string | null; checks: risk.Check[]; created_at: string }
interface DPosition { id: string; account_id: string; symbol: string; quantity: string; avg_price: string; cost_basis: string; realised_pnl: string; fees: string; status: "OPEN" | "CLOSED"; opened_at: string; closed_at: string | null }
interface State {
  users: DUser[]; sessions: DSession[]; accounts: DAccount[]; txns: DTxn[]; audit: DAudit[];
  settings: Record<string, { timezone: string; base_currency: string; theme: string; updated_at: string }>;
  watchlists: Record<string, string[]>;
  docs: rs.DDoc[];
  chunks: rs.DChunk[];
  aiRuns: Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  aiAgents: Record<string, { enabled: boolean; weight: number }>;
  mlModels: { id: string; name: string; symbol: string; timeframe: string; horizon: number; algorithm: string; created_at: string }[];
  mlVersions: Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  backtests: Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  mlEvals: { id: string; version_id: string; kind: string; status: string; metrics: Record<string, unknown>; created_at: string }[];
  opsAnchors?: { at: string; last_record_id: number; head_hash: string; records: number }[];
  opsAttestations?: Record<string, { at: string; by: string; reference: string; label: string }>;
  feedback?: { id: number; created_at: string; category: string; message: string; reply_email: string | null; status: string }[];
  riskProfiles: Record<string, DRisk>; riskDecisions: DDecision[]; systemHalt: { halted: boolean; reason: string | null; since: string | null };
  riskEvents: { id: string; account_id: string | null; type: string; message: string; detail: Record<string, unknown>; created_at: string }[];
  binaries?: DBinary[];
  orders: DOrder[]; executions: Record<string, any>[]; positions: DPosition[]; snapshots: { account_id: string; taken_at: string; cash: string; market_value: string; equity: string; reason: string }[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  reports: { id: string; user_id: string; question: string; symbols: string[]; engine: string; confidence: number; insufficient_evidence: boolean; created_at: string; latency_ms: number; body: unknown }[];
}

let memory: State | null = null;
function load(): State {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      memory = JSON.parse(raw) as State;
      memory.docs ??= []; memory.chunks ??= []; memory.reports ??= []; // states saved by older demo builds
      memory.aiRuns ??= []; memory.aiAgents ??= {};
      memory.mlModels ??= []; memory.mlVersions ??= []; memory.mlEvals ??= []; memory.backtests ??= [];
      memory.orders ??= []; memory.executions ??= []; memory.positions ??= []; memory.snapshots ??= [];
      memory.binaries ??= [];
      memory.feedback ??= [];
      memory.riskProfiles ??= {}; memory.riskDecisions ??= []; memory.riskEvents ??= []; memory.systemHalt ??= { halted: false, reason: null, since: null };
      for (const o of memory.orders) { o.stop_loss ??= null; o.take_profit ??= null; o.parent_order_id ??= null; o.oco_group ??= null; o.proposal_id ??= null; }
      return memory;
    }
  } catch { /* storage unavailable: fall back to memory */ }
  return (memory = { users: [], sessions: [], accounts: [], txns: [], audit: [], settings: {}, watchlists: {}, docs: [], chunks: [], reports: [], feedback: [], aiRuns: [], aiAgents: {}, mlModels: [], mlVersions: [], mlEvals: [], backtests: [], orders: [], executions: [], positions: [], snapshots: [], riskProfiles: {}, riskDecisions: [], riskEvents: [], systemHalt: { halted: false, reason: null, since: null } });
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch { /* ignore */ } }
const refreshStore = {
  get: () => { try { return localStorage.getItem(REFRESH_KEY); } catch { return null; } },
  set: (v: string | null) => { try { if (v) localStorage.setItem(REFRESH_KEY, v); else localStorage.removeItem(REFRESH_KEY); } catch { /* ignore */ } },
};

const now = () => new Date().toISOString();
const uuid = (): string => crypto.randomUUID();
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
const bad = (msg: string, field = "body") => new HttpError(422, "validation_error", "Request validation failed", [{ loc: [field], msg, type: "value_error" }]);

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

// ---- audit -------------------------------------------------------------------------
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
}
const auditRecord = (a: DAudit) => ({ occurred_at: a.occurred_at, actor_user_id: a.actor_user_id, action: a.action, resource_type: a.resource_type, resource_id: a.resource_id, outcome: a.outcome, ip_address: a.ip_address, request_id: a.request_id, details: a.details });
async function audit(s: State, actor: string | null, action: string, opts: { type?: string; id?: string; outcome?: string; details?: Record<string, unknown> } = {}) {
  const prev = s.audit.length ? s.audit[s.audit.length - 1]!.hash : "0".repeat(64);
  const a: DAudit = {
    id: s.audit.length + 1, occurred_at: now(), actor_user_id: actor, action, resource_type: opts.type ?? null,
    resource_id: opts.id ?? null, outcome: opts.outcome ?? "success", ip_address: "browser", request_id: null,
    details: JSON.parse(JSON.stringify(opts.details ?? {})), prev_hash: prev, hash: "",
  };
  a.hash = await sha256(prev + canonical(auditRecord(a)));
  s.audit.push(a);
}

// ---- helpers -----------------------------------------------------------------------
function validatePassword(pw: unknown, field = "password") {
  if (typeof pw !== "string" || pw.length < 12) throw bad("Password must be at least 12 characters", field);
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 3) throw bad("Password must contain at least three of: lowercase, uppercase, digit, symbol", field);
}
const userRead = (u: DUser) => ({ id: u.id, email: u.email, full_name: u.full_name, role: u.role, is_active: u.is_active, created_at: u.created_at, last_login_at: u.last_login_at, mfa_enabled: !!u.mfa_enabled });
const mfaChallenges = new Map<string, { user: string; exp: number }>();     // in memory: challenges die with the tab
async function secondFactor(u: DUser, code: string): Promise<"totp" | "recovery" | null> {
  if (u.mfa_secret) {
    const step = await totp.verify(u.mfa_secret, code, u.mfa_last_step ?? null);
    if (step != null) { u.mfa_last_step = step; return "totp"; }
  }
  const h = await sha256(code.trim().toLowerCase());
  if (u.mfa_recovery?.includes(h)) { u.mfa_recovery = u.mfa_recovery.filter((x) => x !== h); return "recovery"; }
  return null;
}
async function passwordOk(u: DUser, pw: unknown) { return (await sha256(u.salt + String(pw ?? ""))) === u.pw; }

function balances(s: State, acct: DAccount) {
  const net = new Map<string, bigint>();
  for (const t of s.txns) if (t.account_id === acct.id) for (const e of t.entries) {
    net.set(e.ledger_code, (net.get(e.ledger_code) ?? 0n) + (e.direction === "DEBIT" ? toUnits(e.amount) : -toUnits(e.amount)));
  }
  const lines = CHART.map(([code, type, name]) => {
    const n = net.get(code) ?? 0n;
    return { code, name, type, currency: acct.base_currency, balance: fromUnits(DEBIT_NORMAL.has(type) ? n : -n), _net: n };
  }).sort((a, b) => a.code.localeCompare(b.code));
  const assets = lines.filter((l) => l.type === "ASSET").reduce((a, l) => a + toUnits(l.balance), 0n);
  const liab = lines.filter((l) => l.type === "LIABILITY").reduce((a, l) => a + toUnits(l.balance), 0n);
  const get = (c: string) => lines.find((l) => l.code === c)!.balance;
  return { lines, cash: get("CASH"), investments: get("INVESTMENTS"), equity: fromUnits(assets - liab), balanced: lines.reduce((a, l) => a + l._net, 0n) === 0n };
}
function accountRead(s: State, a: DAccount) {
  const b = balances(s, a);
  return { ...a, cash_balance: b.cash, equity: b.equity };
}
function post(s: State, acct: DAccount, type: string, legs: [string, "DEBIT" | "CREDIT", string][], user: string, description = "", idem: string | null = null) {
  const deb = legs.filter((l) => l[1] === "DEBIT").reduce((a, l) => a + toUnits(l[2]), 0n);
  const cred = legs.filter((l) => l[1] === "CREDIT").reduce((a, l) => a + toUnits(l[2]), 0n);
  if (deb !== cred) throw new HttpError(400, "ledger_imbalance", "Ledger transaction must balance (debits == credits)");
  const t: DTxn = { id: uuid(), account_id: acct.id, type, description, created_at: now(), created_by: user, idem,
    entries: legs.map(([c, d, a]) => ({ ledger_code: c, direction: d, amount: fromUnits(toUnits(a)), currency: acct.base_currency })) };
  s.txns.push(t);
  return t;
}
const txnRead = (t: DTxn) => ({ id: t.id, type: t.type, description: t.description, created_at: t.created_at, created_by: t.created_by,
  entries: [...t.entries].sort((a, b) => (a.direction === b.direction ? 0 : a.direction === "DEBIT" ? -1 : 1)) });
function money(v: unknown) {
  const str = typeof v === "number" ? String(v) : v;
  if (typeof str !== "string" || !MONEY_RE.test(str) || toUnits(str) <= 0n) throw bad("Amount must be greater than zero with at most 8 decimal places", "amount");
  return str;
}

// ---- markets --------------------------------------------------------------------------
const slug = (s: string) => s.replace("/", "");
const instRead = (i: mkt.DemoInstrument) => { const { reference_price: _r, ...rest } = i; return { ...rest, slug: slug(i.symbol) }; };
function findInst(sym: string) {
  const k = decodeURIComponent(sym).toUpperCase().replace("/", "");
  const i = INSTRUMENTS.find((x) => slug(x.symbol).toUpperCase() === k);
  if (!i) throw new HttpError(404, "not_found", `Unknown instrument ${sym}`);
  return i;
}
const withQuote = (i: mkt.DemoInstrument) => ({ instrument: instRead(i), quote: mkt.quote(i) });
const LABELS: Record<string, string> = { CRYPTO_24_7: "Crypto (24/7)", FX_24_5: "Forex (24/5)", US_EQUITY: "US equities (NYSE/Nasdaq)", UK_EQUITY: "UK equities (LSE)" };
const marketStatuses = () => Object.entries(LABELS).map(([m, label]) => {
  const st = mkt.status(m as mkt.MarketKey, Date.now());
  return { market: m, label, is_open: st.is_open, next_change: st.next_change ? new Date(st.next_change).toISOString() : null };
});
function watchlist(s: State, userId: string) {
  s.watchlists[userId] ??= ["BTC-USD", "EUR/USD", "AAPL", "SPY"];
  return { id: `wl-${userId}`, name: "Default", items: s.watchlists[userId]!.map((sym) => withQuote(findInst(sym))) };
}

// ---- router ---------------------------------------------------------------------------
type Ctx = { s: State; body: Record<string, unknown>; headers: Headers; params: string[]; query: URLSearchParams; form?: FormData };
type Handler = (c: Ctx) => Promise<Response> | Response;

function authUser(c: Ctx): { user: DUser; session: DSession } {
  const t = c.headers.get("Authorization")?.replace(/^Bearer /, "");
  const session = c.s.sessions.find((x) => x.access === t && !x.revoked);
  const user = session && c.s.users.find((u) => u.id === session.user_id);
  if (!session || !user || !user.is_active) throw new HttpError(401, "unauthorized", "Authentication required");
  return { user, session };
}
function admin(c: Ctx) {
  const a = authUser(c);
  if (a.user.role !== "admin") throw new HttpError(403, "forbidden", "Administrator role required");
  return a;
}
function ownedAccount(c: Ctx, id: string) {
  const { user } = authUser(c);
  const a = c.s.accounts.find((x) => x.id === id && x.owner_id === user.id);
  if (!a) throw new HttpError(404, "not_found", "Trading account not found");
  return { user, a };
}
function issue(s: State, user: DUser, family = uuid()) {
  const sess: DSession = { id: uuid(), user_id: user.id, access: token(), refresh: token(), family, revoked: null, reason: null,
    created_at: now(), user_agent: typeof navigator === "undefined" ? undefined : navigator.userAgent };
  s.sessions.push(sess);
  refreshStore.set(sess.refresh);
  return { access_token: sess.access, token_type: "bearer", expires_in: 900, user: userRead(user) };
}

async function movement(c: Ctx, kind: "VIRTUAL_DEPOSIT" | "VIRTUAL_WITHDRAWAL") {
  const { user, a } = ownedAccount(c, c.params[0]!);
  const amount = money(c.body.amount);
  const idem = c.headers.get("Idempotency-Key");
  if (idem) {
    const prev = c.s.txns.find((t) => t.account_id === a.id && t.idem === idem);
    if (prev) {
      const cash = prev.entries.find((e) => e.ledger_code === "CASH")!;
      if (prev.type !== kind || toUnits(cash.amount) !== toUnits(amount)) throw new HttpError(409, "conflict", "Idempotency key reused with a different request");
      return json(200, txnRead(prev), { "Idempotent-Replay": "true" });
    }
  }
  const cash = toUnits(balances(c.s, a).cash);
  let t: DTxn;
  if (kind === "VIRTUAL_DEPOSIT") {
    if (cash + toUnits(amount) > MAX_BALANCE) throw new HttpError(422, "business_rule_violation", "Virtual cash may not exceed 10000000");
    t = post(c.s, a, kind, [["CASH", "DEBIT", amount], ["CAPITAL_CONTRIBUTIONS", "CREDIT", amount]], user.id, String(c.body.description ?? ""), idem);
  } else {
    if (toUnits(amount) > cash) throw new HttpError(422, "business_rule_violation", "Insufficient virtual cash", { available: fromUnits(cash), requested: amount });
    t = post(c.s, a, kind, [["CAPITAL_WITHDRAWALS", "DEBIT", amount], ["CASH", "CREDIT", amount]], user.id, String(c.body.description ?? ""), idem);
  }
  await audit(c.s, user.id, kind === "VIRTUAL_DEPOSIT" ? "wallet.deposit" : "wallet.withdraw", { type: "trading_account", id: a.id, details: { amount, currency: a.base_currency, ledger_transaction_id: t.id } });
  return json(201, txnRead(t));
}

// ---- research ---------------------------------------------------------------------------
const ALIASES: Record<string, string[]> = Object.fromEntries(INSTRUMENTS.map((i) => {
  const names = new Set([i.symbol, slug(i.symbol)]);
  if (i.asset_class === "CRYPTO") { names.add(i.base_currency); names.add(i.display_name.split(" /")[0]!); }
  if (i.asset_class === "STOCK" || i.asset_class === "ETF") { names.add(i.display_name); names.add(i.symbol.split(".")[0]!); }
  return [i.symbol, [...names].sort((a, b) => b.length - a.length)];
}));
const docRead = (d: rs.DDoc) => { const { content_hash: _h, ...rest } = d; return rest; };

async function ingest(s: State, input: { title: string; text: string; source_name: string; source_url?: string | null; published_at?: string | null; doc_type?: string | null; content_type: string; is_sample?: boolean }): Promise<[rs.DDoc, boolean]> {
  const text = rs.normalise(input.text);
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 5) throw new HttpError(422, "business_rule_violation", "Document has too little text to index");
  if (input.doc_type && !rs.DOC_TYPES.includes(input.doc_type)) throw bad(`doc_type must be one of ${rs.DOC_TYPES.join(", ")}`, "doc_type");
  const hash = await sha256(text);
  const existing = s.docs.find((d) => d.content_hash === hash);
  if (existing) return [existing, false];
  const title = input.title.slice(0, 300).trim() || "(untitled)";
  const doc: rs.DDoc = {
    id: uuid(), title, source_name: input.source_name.slice(0, 120), source_url: input.source_url ?? null,
    doc_type: input.doc_type || rs.classify(title, text), content_type: input.content_type,
    published_at: input.published_at ?? null, retrieved_at: now(), content_hash: hash, word_count: words, page_count: null,
    symbols: rs.tagInstruments(`${title}\n${text}`, ALIASES), sentiment: rs.sentiment(text), is_sample: !!input.is_sample,
  };
  s.docs.push(doc);
  for (const c of rs.chunk(text)) {
    s.chunks.push({ id: uuid(), document_id: doc.id, ordinal: c.ordinal, text: c.text, page: null, paragraph: c.paragraph, sentiment: rs.sentiment(c.text), embedding: rs.embed(`${title}\n${c.text}`) });
  }
  return [doc, true];
}
async function finishIngest(s: State, user: DUser, results: [rs.DDoc, boolean][], via: string) {
  for (const [d, created] of results) if (created) await audit(s, user.id, "research.document.add", { type: "research_document", id: d.id, details: { title: d.title, via } });
  return json(201, { created: results.filter((r) => r[1]).length, duplicates: results.filter((r) => !r[1]).length, documents: results.map(([d]) => docRead(d)) });
}
async function loadSamples(s: State) {
  let created = 0;
  for (const [title, type, age, text] of rs.SAMPLES) {
    const [, isNew] = await ingest(s, { title, text, source_name: rs.SAMPLE_SOURCE, published_at: new Date(Date.now() - age * 86_400_000).toISOString(), doc_type: type, content_type: "text/plain", is_sample: true });
    created += +isNew;
  }
  return created;
}
const reportSummary = (r: State["reports"][number]) => { const { body: _b, user_id: _u, latency_ms: _l, ...rest } = r; return rest; };

// ---- agents -------------------------------------------------------------------------------
const AGENT_META: [string, string, "directional" | "gate", string][] = [
  ["technical", "Technical Agent", "directional", "Trend, momentum and volatility from hourly OHLCV (SMA, RSI, MACD, Bollinger, ATR)."],
  ["quant", "Quant Agent", "directional", "Statistical drift estimate with a forecast interval and mean-reversion check."],
  ["fundamental", "Fundamental Agent", "directional", "Earnings and filings evidence for shares and ETFs."],
  ["news", "News Agent", "directional", "Recent instrument news/analysis tone and high-impact event windows."],
  ["sentiment", "Sentiment Agent", "directional", "30-day research tone for the instrument."],
  ["regime", "Regime Agent", "gate", "Volatility regime, trend efficiency and distribution-drift (KS) gate."],
  ["portfolio", "Portfolio Agent", "gate", "Position sizing at 0.5% risk of equity, no leverage, exposure caps."],
  ["ml", "ML Model Agent", "directional", "Probability from the promoted champion model for the instrument; abstains when no eligible champion exists. Zero vote weight until an administrator assigns it."],
  ["risk", "Risk Agent", "gate", "Advisory pre-check: market state, staleness, spread, events, limits. The independent risk gate has final authority."],
];
const agentList = (s: State) => AGENT_META.map(([name, display_name, kind, role]) => ({
  name, display_name, kind, role, version: "1.0",
  weight: s.aiAgents[name]?.weight ?? ag.DEFAULT_WEIGHTS[name] ?? 0, enabled: s.aiAgents[name]?.enabled ?? true,
}));
function lastPrice(sym: string) { const i = INSTRUMENTS.find((x) => x.symbol === sym); return i ? +mkt.quote(i).last : null; }
function fxRate(src: string, dst: string): number | null {
  if (src === dst) return 1;
  const rate = (a: string, b: string) => { const d = lastPrice(`${a}/${b}`); if (d) return d; const inv = lastPrice(`${b}/${a}`); return inv ? 1 / inv : null; };
  const direct = rate(src, dst); if (direct) return direct;
  const x = rate(src, "USD"), y = rate("USD", dst);
  return x != null && y != null ? x * y : null;
}
const withEffective = (p: Record<string, unknown> | null) => p && ({ ...p, effective_status: p.status === "PENDING_RISK_REVIEW" && Date.parse(p.expires_at as string) <= Date.now() ? "EXPIRED" : p.status });
const runSummary = (r: Record<string, unknown>) => ({ id: r.id, symbol: r.symbol, decision: r.decision, bias: r.bias, net_score: r.net_score, agreement: r.agreement, coverage: r.coverage, confidence: r.confidence, created_at: r.created_at, latency_ms: r.latency_ms });

// ---- model lab -----------------------------------------------------------------------------
const ML_ALGOS = [{ key: "logistic", label: "Logistic regression", description: "Regularised linear baseline (L2, C = 0.5). Runs in your browser.", params: { C: 0.5 } }];
function mlSummary(v: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const o = v.metrics.oos, b = v.metrics.baselines;
  return { auc: o.auc, brier: o.brier, brier_climatology: o.brier_climatology, net_return: o.strategy_net_return, sharpe: o.strategy_sharpe, buy_hold_return: b.buy_hold.net_return, trades: o.strategy_trades };
}
const SUMMARY_KEYS = ["id", "model_id", "symbol", "version", "status", "eligible", "eligibility_note", "data_source", "trained_at", "promoted_at", "retired_at", "n_samples"];
const mlSummaryRead = (v: Record<string, any>) => ({ ...Object.fromEntries(SUMMARY_KEYS.map((k) => [k, v[k]])), summary: mlSummary(v) }); // eslint-disable-line @typescript-eslint/no-explicit-any
function mlDetail(s: State, v: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const m = s.mlModels.find((x) => x.id === v.model_id)!;
  return { ...mlSummaryRead(v), gates: v.gates, metrics: v.metrics, params: { C: 0.5 }, features: ml.FEATURES, feature_importance: v.feature_importance,
    train_from: v.train_from, train_to: v.train_to, artifact_sha256: v.artifact_sha256, model: { name: m.name, algorithm: m.algorithm, horizon: m.horizon, timeframe: m.timeframe },
    evaluations: s.mlEvals.filter((e) => e.version_id === v.id).slice().reverse() };
}
const hourBars = (inst: mkt.DemoInstrument, n: number) => mkt.candles(inst, "1h", n).map((b) => ({ t: b.open_time, h: +b.high, l: +b.low, c: +b.close }));


// ---- paper execution (mirror of backend app/trading) -------------------------------------
const FEE_BPS: Record<string, number> = { CRYPTO: 10, FX: 0, STOCK: 1, ETF: 1 };
const SLIP_BPS: Record<string, number> = { CRYPTO: 2, FX: 0.5, STOCK: 2, ETF: 1 };
const AUTOPILOT_INTERVAL_S = 900;
const u8 = (n: number) => toUnits(n.toFixed(8));
const DEC_RE = /^\d+(\.\d{1,10})?$/;
const instOf = (sym: string) => INSTRUMENTS.find((i) => i.symbol === sym)!;
const openPos = (s: State, acct: string, sym: string) => s.positions.find((p) => p.account_id === acct && p.symbol === sym && p.status === "OPEN");
const orderRead = (o: DOrder) => { const { events: _e, user_id: _u, ...rest } = o; return rest; };
const orderDetail = (s: State, o: DOrder) => ({
  ...orderRead(o), events: o.events, executions: s.executions.filter((x) => x.order_id === o.id),
  risk_checks: [...s.riskDecisions].reverse().find((d) => d.order_id === o.id)?.checks ?? [],
  children: s.orders.filter((x) => x.parent_order_id === o.id).map(orderRead),
});
function ev(o: DOrder, type: string, detail: Record<string, unknown> = {}) { o.events.push({ type, detail, created_at: now() }); o.updated_at = now(); }
function reject(o: DOrder, reason: string) { o.status = "REJECTED"; o.reject_reason = reason; ev(o, "REJECTED", { reason }); }
function cancelOrder(o: DOrder, reason: string, type = "CANCELLED") { o.status = "CANCELLED"; o.reject_reason = reason; ev(o, type, { reason }); }

function matchFill(o: DOrder, bid: number, ask: number, slip: number): { price: number; reference: number } | null {
  const lim = o.limit_price ? +o.limit_price : null, stop = o.stop_price ? +o.stop_price : null;
  if (o.side === "BUY") {
    const worst = ask * (1 + slip);
    if (o.type === "MARKET") return { price: worst, reference: ask };
    if (o.type === "LIMIT" && lim != null && ask <= lim) return { price: Math.min(lim, worst), reference: ask };
    if (o.type === "STOP" && stop != null && ask >= stop) return { price: worst, reference: ask };
    return null;
  }
  const worst = bid * (1 - slip);
  if (o.type === "MARKET") return { price: worst, reference: bid };
  if (o.type === "LIMIT" && lim != null && bid >= lim) return { price: Math.max(lim, worst), reference: bid };
  if (o.type === "STOP" && stop != null && bid <= stop) return { price: worst, reference: bid };
  return null;
}

function reservedUnits(s: State, a: DAccount, exclude?: string) {
  return s.orders.filter((o) => o.account_id === a.id && o.side === "BUY" && o.status === "OPEN" && o.id !== exclude).reduce((acc, o) => {
    const i = instOf(o.symbol);
    const px = +(o.limit_price ?? o.stop_price ?? 0);
    return acc + u8(+o.quantity * px * (fxRate(i.quote_currency, a.base_currency) ?? 1) * (1 + (FEE_BPS[i.asset_class]! + SLIP_BPS[i.asset_class]!) / 1e4));
  }, 0n);
}

function businessCheck(s: State, a: DAccount, o: DOrder): string | null {
  const i = instOf(o.symbol);
  const pos = openPos(s, a.id, o.symbol);
  if (o.side === "SELL") {
    const pending = s.orders.filter((x) => x.account_id === a.id && x.symbol === o.symbol && x.side === "SELL" && x.status === "OPEN" && x.id !== o.id && x.source !== "protective").reduce((acc, x) => acc + +x.quantity, 0);
    const held = pos ? +pos.quantity : 0;
    if (+o.quantity > held - pending + 1e-12) return `insufficient position: holding ${held}, ${pending} already in open sell orders (short selling is disabled)`;
    return null;
  }
  const fx = fxRate(i.quote_currency, a.base_currency);
  if (fx == null) return `no FX rate from ${i.quote_currency} to ${a.base_currency}`;
  const gross = +o.quantity * estimate(o, +mkt.quote(i).ask, SLIP_BPS[i.asset_class]! / 1e4) * fx;
  if (gross < MIN_ORDER_VALUE) return `order value ≈${gross.toFixed(2)} ${a.base_currency} is below the minimum order of ${MIN_ORDER_VALUE.toFixed(2)} ${a.base_currency}`;
  const est = u8(gross * (1 + FEE_BPS[i.asset_class]! / 1e4));
  const avail = toUnits(balances(s, a).cash) - reservedUnits(s, a, o.id);
  if (est > avail) return `insufficient cash: needs ≈${(Number(est) / 1e8).toFixed(2)} ${a.base_currency}, available ${(Number(avail) / 1e8).toFixed(2)} (no leverage)`;
  return null;
}
const estimate = (o: DOrder, ask: number, slip: number) =>
  o.type === "LIMIT" ? +o.limit_price! : o.type === "STOP" ? Math.max(+o.stop_price!, ask) * (1 + slip) : ask * (1 + slip);

function portfolio(s: State, a: DAccount) {
  const b = balances(s, a);
  const line = (c: string) => toUnits(b.lines.find((l) => l.code === c)!.balance);
  const rows = s.positions.filter((p) => p.account_id === a.id && p.status === "OPEN").map((p) => {
    const i = instOf(p.symbol); const q = mkt.quote(i); const fx = fxRate(i.quote_currency, a.base_currency) ?? 0;
    const mv = u8(+p.quantity * +q.bid * fx);
    const cost = toUnits(p.cost_basis);
    return { id: p.id, symbol: p.symbol, asset_class: i.asset_class, quantity: p.quantity, avg_price: p.avg_price, last: q.last, bid: q.bid,
      quote_currency: i.quote_currency, fx_rate: fx.toFixed(8), cost_basis: p.cost_basis, market_value: fromUnits(mv), unrealised_pnl: fromUnits(mv - cost),
      unrealised_pct: cost ? Number(mv - cost) / Number(cost) : 0, realised_pnl: p.realised_pnl, fees: p.fees, opened_at: p.opened_at,
      price_as_of: q.as_of, stale: q.stale, price_decimals: i.price_decimals, _mv: mv };
  });
  const atRisk = (s.binaries ?? []).filter((b) => b.account_id === a.id && b.status === "OPEN").reduce((acc, b) => acc + toUnits(b.stake), 0n);
  const mv = rows.reduce((acc, r) => acc + r._mv, 0n) + atRisk;   // open binaries are carried at their stake
  const cash = line("CASH"), equity = cash + mv;
  const alloc: Record<string, number> = {};
  for (const r of rows) alloc[r.asset_class] = (alloc[r.asset_class] ?? 0) + (equity ? Number(r._mv) / Number(equity) : 0);
  if (atRisk) alloc.BINARY = equity ? Number(atRisk) / Number(equity) : 0;
  return { account_id: a.id, account_name: a.name, currency: a.base_currency, cash: fromUnits(cash), available_cash: fromUnits(cash - reservedUnits(s, a)),
    investments_at_cost: fromUnits(line("INVESTMENTS")), market_value: fromUnits(mv), equity: fromUnits(equity), unrealised_pnl: fromUnits(mv - line("INVESTMENTS")),
    realised_pnl: fromUnits(line("REALISED_PNL")), fees: fromUnits(line("FEES")), exposure: equity ? Number(mv) / Number(equity) : 0,
    open_positions: rows.length, allocation: alloc, positions: rows.map(({ _mv, ...r }) => r), binary_at_risk: fromUnits(atRisk) };
}
function snapshot(s: State, a: DAccount, reason: string) {
  const p = portfolio(s, a);
  s.snapshots.push({ account_id: a.id, taken_at: now(), cash: p.cash, market_value: p.market_value, equity: p.equity, reason });
  if (s.snapshots.length > 1500) s.snapshots.splice(0, s.snapshots.length - 1500);
  return p;
}

// ---- risk engine (mirror of backend app/risk) --------------------------------------------
const today = () => new Date().toISOString().slice(0, 10);
function profile(s: State, accountId: string): DRisk {
  const existing = s.riskProfiles[accountId];
  if (existing) { existing.binary_max_stake_pct ??= risk.DEFAULTS.binary_max_stake_pct; existing.binary_max_open ??= risk.DEFAULTS.binary_max_open; existing.binary_enabled ??= true; }
  return (s.riskProfiles[accountId] ??= { ...risk.DEFAULTS, kill_switch: false, kill_reason: null, kill_engaged_at: null, daily_halt_date: null,
    drawdown_halted: false, drawdown_halted_at: null, peak_pnl_equity: null, day_date: null, day_start_pnl_equity: null, day_start_equity: null,
    autopilot_status: "STOPPED", autopilot_symbols: ["BTC-USD", "ETH-USD", "SPY"], autopilot_last_cycle_at: null, binary_enabled: true });
}
function riskEvent(s: State, accountId: string | null, type: string, message: string, detail: Record<string, unknown> = {}) {
  s.riskEvents.push({ id: uuid(), account_id: accountId, type, message, detail, created_at: now() });
  if (s.riskEvents.length > 400) s.riskEvents.splice(0, s.riskEvents.length - 400);
}
function cancelOpen(s: State, accountId: string | null, reason: string, pred: (o: DOrder) => boolean = (o) => o.side === "BUY") {
  let n = 0;
  for (const o of s.orders) if (o.status === "OPEN" && (accountId == null || o.account_id === accountId) && pred(o)) { cancelOrder(o, reason); n++; }
  return n;
}
const dailyHalted = (p: DRisk) => p.daily_halt_date === today();
function blockReason(s: State, p: DRisk): string | null {
  if (s.systemHalt.halted) return `platform trading is halted: ${s.systemHalt.reason}`;
  if (p.kill_switch) return `account kill switch is engaged: ${p.kill_reason}`;
  if (dailyHalted(p)) return `daily loss limit of ${p.daily_loss_limit_pct}% reached`;
  if (p.drawdown_halted) return `maximum drawdown of ${p.max_drawdown_pct}% reached`;
  return null;
}
function trip(s: State, a: DAccount, p: DRisk, type: string, message: string, detail: Record<string, unknown>) {
  const cancelled = cancelOpen(s, a.id, `risk: ${message}`);
  if (p.autopilot_status === "RUNNING") p.autopilot_status = "PAUSED";
  riskEvent(s, a.id, type, message, { ...detail, cancelled_orders: cancelled });
}
function metrics(s: State, a: DAccount, pf = portfolio(s, a)) {
  const p = profile(s, a.id);
  const b = balances(s, a);
  const line = (c: string) => +b.lines.find((l) => l.code === c)!.balance;
  const netContrib = line("CAPITAL_CONTRIBUTIONS") + line("CAPITAL_WITHDRAWALS");
  const equity = +pf.equity, pnl = equity - netContrib;
  if (p.day_date !== today() || p.day_start_pnl_equity == null) { p.day_date = today(); p.day_start_pnl_equity = pnl; p.day_start_equity = equity; }
  if (p.peak_pnl_equity == null || pnl > p.peak_pnl_equity) p.peak_pnl_equity = pnl;
  const dayLoss = p.day_start_pnl_equity - pnl;
  const dailyPct = p.day_start_equity! > 0 ? (dayLoss / p.day_start_equity!) * 100 : 0;
  const ddBase = p.peak_pnl_equity + netContrib;
  const ddPct = ddBase > 0 ? ((p.peak_pnl_equity - pnl) / ddBase) * 100 : 0;
  if (dailyPct >= p.daily_loss_limit_pct && p.daily_halt_date !== today()) {
    p.daily_halt_date = today();
    trip(s, a, p, "BREAKER_DAILY_LOSS", `Daily loss breaker tripped: −${dailyPct.toFixed(2)}% (limit ${p.daily_loss_limit_pct}%)`, { loss_pct: dailyPct });
  }
  if (ddPct >= p.max_drawdown_pct && !p.drawdown_halted) {
    p.drawdown_halted = true; p.drawdown_halted_at = now();
    trip(s, a, p, "BREAKER_DRAWDOWN", `Drawdown breaker tripped: −${ddPct.toFixed(2)}% from peak (limit ${p.max_drawdown_pct}%)`, { drawdown_pct: ddPct });
  }
  const largest = pf.positions.reduce((m, x) => Math.max(m, +x.market_value), 0);
  return { equity: pf.equity, pnl_equity: pnl.toFixed(8), peak_pnl_equity: p.peak_pnl_equity.toFixed(8), day_start_equity: p.day_start_equity!.toFixed(8),
    daily_pnl: (-dayLoss).toFixed(8), daily_loss_pct: Math.max(0, dailyPct), drawdown_pct: Math.max(0, ddPct), exposure_pct: pf.exposure * 100,
    largest_position_pct: equity > 0 ? (largest / equity) * 100 : 0, open_positions: pf.positions.length };
}
function engageKill(s: State, a: DAccount, p: DRisk, reason: string, automatic = false) {
  p.kill_switch = true; p.kill_reason = reason; p.kill_engaged_at = now();
  if (p.autopilot_status === "RUNNING") p.autopilot_status = "PAUSED";
  const cancelled = cancelOpen(s, a.id, `risk: kill switch engaged (${reason})`);
  riskEvent(s, a.id, automatic ? "ABNORMAL_ACTIVITY" : "KILL_SWITCH_ON", `Kill switch engaged${automatic ? " automatically" : ""}: ${reason}`, { cancelled_orders: cancelled });
}
function riskGate(s: State, a: DAccount, o: DOrder, entry: number, bid: number, ask: number) {
  const i = instOf(o.symbol);
  const p = profile(s, a.id);
  const pf = portfolio(s, a);
  metrics(s, a, pf);
  const fx = fxRate(i.quote_currency, a.base_currency) ?? 1;
  const held = openPos(s, a.id, o.symbol);
  const notional = +o.quantity * entry * fx;
  const stop = o.stop_loss != null ? +o.stop_loss : entry * (1 - risk.DEFAULT_STOP_PCT[i.asset_class]! / 100);
  const current = +(pf.positions.find((x) => x.symbol === o.symbol)?.market_value ?? 0);
  const symbols = new Set([...pf.positions.map((x) => x.symbol), ...s.orders.filter((x) => x.account_id === a.id && x.side === "BUY" && x.status === "OPEN" && x.id !== o.id).map((x) => x.symbol), o.symbol]);
  let collar: number | null = null;
  if (o.type === "LIMIT" && o.limit_price) collar = o.side === "BUY" ? (+o.limit_price / ask - 1) * 100 : (1 - +o.limit_price / bid) * 100;
  const recent = s.orders.filter((x) => x.account_id === a.id && x.id !== o.id && x.source !== "protective" && Date.now() - Date.parse(x.created_at) < 60_000).length;
  const checks = risk.evaluate({
    side: o.side, reduces: o.side === "SELL" && !!held, system_halt: s.systemHalt.halted ? (s.systemHalt.reason ?? "halted") : null,
    kill_switch: p.kill_switch ? (p.kill_reason ?? "engaged") : null, daily_halted: dailyHalted(p), drawdown_halted: p.drawdown_halted,
    equity: +pf.equity, notional, risk_amount: +o.quantity * Math.max(entry - stop, 0) * fx, position_after: current + notional,
    exposure_after: +pf.market_value + Number(reservedUnits(s, a, o.id)) / 1e8 + notional, open_positions_after: symbols.size,
    collar_through_pct: collar, orders_last_minute: recent,
  }, p);
  const reason = risk.firstFailure(checks);
  const rate = checks.find((c) => c.name === "order_rate")!;
  if (!rate.passed && !p.kill_switch) engageKill(s, a, p, rate.message, true);
  s.riskDecisions.push({ id: uuid(), account_id: a.id, order_id: o.id, proposal_id: o.proposal_id, source: o.source, symbol: o.symbol, side: o.side,
    approved: reason == null, reason, checks, created_at: now() });
  if (s.riskDecisions.length > 400) s.riskDecisions.splice(0, s.riskDecisions.length - 400);
  return { approved: reason == null, checks, reason };
}

function fill(s: State, a: DAccount, o: DOrder, f: { price: number; reference: number }, bid: number, ask: number) {
  const i = instOf(o.symbol);
  const fx = fxRate(i.quote_currency, a.base_currency);
  if (fx == null) return reject(o, "FX rate unavailable at fill time");
  let pos = openPos(s, a.id, o.symbol);
  if (o.side === "SELL" && o.source === "protective" && pos && +o.quantity > +pos.quantity) { o.quantity = pos.quantity; ev(o, "RESIZED", { quantity: o.quantity }); }
  const qty = +o.quantity, px = f.price;
  const notional = u8(qty * px * fx), fee = (notional * BigInt(Math.round(FEE_BPS[i.asset_class]! * 100))) / 1_000_000n;
  const mid = (bid + ask) / 2;
  let realised: bigint | null = null;
  let txn: DTxn;
  const label = `${o.side === "BUY" ? "Buy" : "Sell"} ${qty} ${o.symbol} @ ${+px.toFixed(8)}`;
  const feeLegs: [string, "DEBIT" | "CREDIT", string][] = fee > 0n ? [["FEES", "DEBIT", fromUnits(fee)], ["CASH", "CREDIT", fromUnits(fee)]] : [];
  if (o.side === "BUY") {
    if (notional + fee > toUnits(balances(s, a).cash)) return reject(o, "insufficient cash at fill time");
    txn = post(s, a, "TRADE_BUY", [["INVESTMENTS", "DEBIT", fromUnits(notional)], ["CASH", "CREDIT", fromUnits(notional)], ...feeLegs], o.user_id, label);
    if (!pos) {
      pos = { id: uuid(), account_id: a.id, symbol: o.symbol, quantity: o.quantity, avg_price: px.toFixed(10), cost_basis: fromUnits(notional), realised_pnl: "0", fees: fromUnits(fee), status: "OPEN", opened_at: now(), closed_at: null };
      s.positions.push(pos);
    } else {
      const total = +pos.quantity + qty;
      pos.avg_price = ((+pos.avg_price * +pos.quantity + px * qty) / total).toFixed(10);
      pos.quantity = String(+total.toFixed(10)); pos.cost_basis = fromUnits(toUnits(pos.cost_basis) + notional); pos.fees = fromUnits(toUnits(pos.fees) + fee);
    }
  } else {
    if (!pos || qty > +pos.quantity + 1e-12) return reject(o, "position changed: insufficient quantity at fill time");
    const all = Math.abs(qty - +pos.quantity) < 1e-12;
    const cost = all ? toUnits(pos.cost_basis) : u8(Number(toUnits(pos.cost_basis)) / 1e8 * qty / +pos.quantity);
    realised = notional - cost;
    const pnlLeg: [string, "DEBIT" | "CREDIT", string][] = realised > 0n ? [["REALISED_PNL", "CREDIT", fromUnits(realised)]] : realised < 0n ? [["REALISED_PNL", "DEBIT", fromUnits(-realised)]] : [];
    txn = post(s, a, "TRADE_SELL", [["CASH", "DEBIT", fromUnits(notional)], ["INVESTMENTS", "CREDIT", fromUnits(cost)], ...pnlLeg, ...feeLegs], o.user_id, label);
    pos.quantity = all ? "0" : String(+(+pos.quantity - qty).toFixed(10));
    pos.cost_basis = fromUnits(toUnits(pos.cost_basis) - cost);
    pos.realised_pnl = fromUnits(toUnits(pos.realised_pnl) + realised);
    pos.fees = fromUnits(toUnits(pos.fees) + fee);
    if (all) { pos.status = "CLOSED"; pos.closed_at = now(); }
  }
  s.executions.push({ id: uuid(), order_id: o.id, account_id: a.id, symbol: o.symbol, side: o.side, quantity: o.quantity, price: px.toFixed(10), reference_price: f.reference.toFixed(10),
    mid_price: mid.toFixed(10), fx_rate: fx.toFixed(8), fee: fromUnits(fee), spread_cost: (Math.abs(f.reference - mid) * qty * fx).toFixed(8),
    slippage_cost: (Math.abs(px - f.reference) * qty * fx).toFixed(8), realised_pnl: realised == null ? null : fromUnits(realised), ledger_transaction_id: txn.id, executed_at: now() });
  o.status = "FILLED"; o.filled_qty = o.quantity; o.avg_fill_price = px.toFixed(10);
  ev(o, "FILLED", { price: px.toFixed(8), quantity: o.quantity, fee: fromUnits(fee), reference: f.reference.toFixed(8) });
  if (o.oco_group) for (const x of s.orders) if (x.oco_group === o.oco_group && x.id !== o.id && x.status === "OPEN") cancelOrder(x, "one-cancels-other: sibling filled", "OCO_CANCELLED");
  if (o.side === "BUY" && (o.stop_loss || o.take_profit)) spawnBrackets(s, o);
  if (o.side === "SELL") {
    const remaining = +pos.quantity;
    for (const x of s.orders) if (x.account_id === a.id && x.symbol === o.symbol && x.source === "protective" && x.status === "OPEN") {
      if (remaining <= 0) cancelOrder(x, "position closed");
      else if (+x.quantity > remaining) { x.quantity = pos.quantity; ev(x, "RESIZED", { quantity: x.quantity }); }
    }
  }
  metrics(s, a, snapshot(s, a, "fill"));
}

function newOrder(o: Partial<DOrder> & Pick<DOrder, "account_id" | "user_id" | "symbol" | "side" | "type" | "quantity">): DOrder {
  return { id: uuid(), limit_price: null, stop_price: null, time_in_force: "GTC", status: "OPEN", filled_qty: "0", avg_fill_price: null, client_order_id: null,
    source: "manual", reject_reason: null, expires_at: null, created_at: now(), updated_at: now(), events: [], stop_loss: null, take_profit: null,
    parent_order_id: null, oco_group: null, proposal_id: null, ...o };
}
function spawnBrackets(s: State, parent: DOrder) {
  const group = parent.stop_loss && parent.take_profit ? uuid() : null;
  const expires = new Date(Date.now() + 30 * 864e5).toISOString();
  const legs: ["STOP" | "LIMIT", string | null, string | null][] = [];
  if (parent.stop_loss) legs.push(["STOP", null, parent.stop_loss]);
  if (parent.take_profit) legs.push(["LIMIT", parent.take_profit, null]);
  for (const [type, limit, stop] of legs) {
    const child = newOrder({ account_id: parent.account_id, user_id: parent.user_id, symbol: parent.symbol, side: "SELL", type, quantity: parent.quantity,
      limit_price: limit, stop_price: stop, source: "protective", expires_at: expires, parent_order_id: parent.id, oco_group: group, proposal_id: parent.proposal_id });
    s.orders.push(child);
    ev(child, "CREATED", { side: "SELL", type, quantity: parent.quantity, limit_price: limit, stop_price: stop, parent: parent.id, source: "protective" });
    ev(child, "ACCEPTED", { expires_at: expires });
    ev(parent, "BRACKET_PLACED", { child: child.id, type, price: limit ?? stop });
  }
}

/** The matcher. The backend runs it every few seconds; the demo runs it on every trading request. */
function processOpen(s: State) {
  const stats = { checked: 0, filled: 0, expired: 0, rejected: 0 };
  for (const o of s.orders.filter((x) => x.status === "OPEN")) {
    stats.checked++;
    if (o.expires_at && Date.parse(o.expires_at) <= Date.now()) { o.status = "EXPIRED"; ev(o, "EXPIRED"); stats.expired++; continue; }
    if (o.side === "BUY") {
      const block = blockReason(s, profile(s, o.account_id));
      if (block) { cancelOrder(o, `risk: ${block}`); stats.rejected++; continue; }
    } else if (o.source === "protective" && !openPos(s, o.account_id, o.symbol)) { cancelOrder(o, "position closed"); continue; }
    const i = instOf(o.symbol); const q = mkt.quote(i);
    if (!q.tradable) continue;
    const f = matchFill(o, +q.bid, +q.ask, SLIP_BPS[i.asset_class]! / 1e4);
    if (!f) continue;
    fill(s, s.accounts.find((a) => a.id === o.account_id)!, o, f, +q.bid, +q.ask);
    stats[o.status === "FILLED" ? "filled" : "rejected"]++;
  }
  settleBinaries(s);
  for (const a of s.accounts) if (s.positions.some((p) => p.account_id === a.id && p.status === "OPEN")) metrics(s, a);
  return stats;
}
function accountIds(c: Ctx, user: DUser) {
  const id = c.query.get("account_id");
  if (id) return [ownedAccount(c, id).a.id];
  return c.s.accounts.filter((a) => a.owner_id === user.id).map((a) => a.id);
}
const page = <T,>(c: Ctx, all: T[]) => { const limit = Number(c.query.get("limit") ?? 50), offset = Number(c.query.get("offset") ?? 0); return { items: all.slice(offset, offset + limit), total: all.length, limit, offset }; };

interface OrderBody { account_id?: unknown; symbol?: unknown; side?: unknown; type?: unknown; quantity?: unknown; limit_price?: unknown; stop_price?: unknown; time_in_force?: unknown; client_order_id?: unknown; stop_loss?: unknown; take_profit?: unknown }
async function placeOrder(s: State, user: DUser, a: DAccount, b: OrderBody, source = "manual", proposalId: string | null = null): Promise<{ o: DOrder; replay: boolean }> {
  const coid = b.client_order_id == null ? null : String(b.client_order_id);
  if (coid != null && !/^[A-Za-z0-9_-]{8,64}$/.test(coid)) throw bad("client_order_id must be 8-64 characters of A-Z, 0-9, _ or -", "client_order_id");
  if (coid) { const ex = s.orders.find((o) => o.account_id === a.id && o.client_order_id === coid); if (ex) return { o: ex, replay: true }; }
  const inst = findInst(String(b.symbol ?? ""));
  const side = b.side, type = (b.type ?? "MARKET") as DOrder["type"], tif = (b.time_in_force ?? "GTC") as DOrder["time_in_force"];
  if (side !== "BUY" && side !== "SELL") throw bad("side must be BUY or SELL", "side");
  if (!["MARKET", "LIMIT", "STOP"].includes(type)) throw bad("type must be MARKET, LIMIT or STOP", "type");
  if (tif !== "GTC" && tif !== "DAY") throw bad("time_in_force must be GTC or DAY", "time_in_force");
  const qty = String(b.quantity ?? "");
  if (!DEC_RE.test(qty) || +qty <= 0) throw bad("Quantity must be positive", "quantity");
  const rule = (m: string) => new HttpError(422, "business_rule_violation", m);
  const lot = +inst.lot_size;
  if (Math.abs(Math.round(+qty / lot) * lot - +qty) > lot * 1e-6) throw rule(`Quantity must be a multiple of the lot size ${lot}`);
  for (const k of ["limit_price", "stop_price", "stop_loss", "take_profit"] as const) {
    const v = b[k];
    if (v == null) continue;
    if (!DEC_RE.test(String(v)) || +String(v) <= 0 || (String(v).split(".")[1]?.length ?? 0) > inst.price_decimals) throw rule(`${k} must be positive with at most ${inst.price_decimals} decimals`);
    if ((k === "stop_loss" || k === "take_profit") && side !== "BUY") throw rule(`${k} can only be attached to BUY (entry) orders`);
  }
  if (type === "LIMIT" && b.limit_price == null) throw rule("LIMIT orders need a limit_price");
  if (type === "STOP" && b.stop_price == null) throw rule("STOP orders need a stop_price");
  if (type === "MARKET" && (b.limit_price != null || b.stop_price != null)) throw rule("MARKET orders take no limit or stop price");
  if (b.stop_loss != null && b.take_profit != null && +String(b.stop_loss) >= +String(b.take_profit)) throw rule("stop_loss must be below take_profit");
  processOpen(s);
  const t = new Date();
  const expires = type === "MARKET" ? null : tif === "DAY" ? new Date(mkt.dayExpiry(inst.market as mkt.MarketKey, t.getTime())).toISOString() : new Date(t.getTime() + 30 * 864e5).toISOString();
  const str = (v: unknown) => (v == null ? null : String(v));
  const o = newOrder({ account_id: a.id, user_id: user.id, symbol: inst.symbol, side, type, quantity: qty, limit_price: str(b.limit_price), stop_price: str(b.stop_price),
    time_in_force: tif, client_order_id: coid, source, expires_at: expires, stop_loss: str(b.stop_loss), take_profit: str(b.take_profit), proposal_id: proposalId });
  s.orders.push(o);
  ev(o, "CREATED", { side, type, quantity: qty, limit_price: o.limit_price, stop_price: o.stop_price, tif, stop_loss: o.stop_loss, take_profit: o.take_profit, source });
  const done = async () => {
    if (s.orders.length > 400) s.orders.splice(0, s.orders.length - 400);
    await audit(s, user.id, "order.submit", { type: "order", id: o.id, details: { symbol: o.symbol, side, type, quantity: qty, status: o.status, reason: o.reject_reason } });
    return { o, replay: false };
  };
  const why = businessCheck(s, a, o);
  if (why) { reject(o, why); return done(); }
  const q = mkt.quote(inst), slip = SLIP_BPS[inst.asset_class]! / 1e4;
  let f = null as { price: number; reference: number } | null;
  if (type === "MARKET") {
    if (!q.tradable) { reject(o, q.market_open ? "quote is stale" : "market is closed"); return done(); }
    f = matchFill(o, +q.bid, +q.ask, slip);
  }
  const entry = f ? f.price : estimate(o, +q.ask, slip);
  const d = inst.price_decimals;
  if (o.stop_loss && +o.stop_loss >= entry) { reject(o, `stop_loss ${+o.stop_loss} must be below the entry price (≈${entry.toFixed(d)})`); return done(); }
  if (o.take_profit && +o.take_profit <= entry) { reject(o, `take_profit ${+o.take_profit} must be above the entry price (≈${entry.toFixed(d)})`); return done(); }
  const gate = riskGate(s, a, o, entry, +q.bid, +q.ask);
  ev(o, gate.approved ? "RISK_APPROVED" : "RISK_REJECTED", { failed: gate.checks.filter((c) => !c.passed).map((c) => c.name) });
  if (!gate.approved) { reject(o, `risk: ${gate.reason}`); return done(); }
  if (f) fill(s, a, o, f, +q.bid, +q.ask);
  else ev(o, "ACCEPTED", { expires_at: expires });
  return done();
}

function executeProposal(s: State, user: DUser, run: Record<string, any>, source = "ai") { // eslint-disable-line @typescript-eslint/no-explicit-any
  const p = run.proposal;
  if (p.status !== "PENDING_RISK_REVIEW") throw new HttpError(422, "business_rule_violation", `Proposal is ${String(p.status).toLowerCase().replaceAll("_", " ")}`);
  if (Date.parse(p.expires_at) <= Date.now()) throw new HttpError(422, "business_rule_violation", "Proposal has expired");
  const a = s.accounts.find((x) => x.id === p.account_id)!;
  const inst = instOf(p.symbol);
  const f = 10 ** inst.price_decimals;
  return placeOrder(s, user, a, { symbol: p.symbol, side: "BUY", type: "MARKET", quantity: String(+p.quantity), client_order_id: `proposal-${p.id.replaceAll("-", "")}`.slice(0, 64),
    stop_loss: (Math.floor(+p.stop_loss * f) / f).toFixed(inst.price_decimals), take_profit: (Math.ceil(+p.take_profit * f) / f).toFixed(inst.price_decimals) }, source, p.id)
    .then(({ o }) => {
      p.decided_at = now(); p.order_id = o.id;
      if (o.status === "REJECTED") { p.status = "RISK_REJECTED"; p.decision_reason = o.reject_reason; } else { p.status = "EXECUTED"; p.decision_reason = null; }
      return { p, o };
    });
}

async function autopilotCycle(s: State, a: DAccount) {
  const p = profile(s, a.id);
  const user = s.users.find((u) => u.id === a.owner_id)!;
  const out: { at: string; skipped?: string; results: Record<string, unknown>[] } = { at: now(), results: [] };
  const block = blockReason(s, p);
  p.autopilot_last_cycle_at = now();
  if (block) { out.skipped = block; riskEvent(s, a.id, "AUTOPILOT_CYCLE", `Autopilot cycle skipped: ${block}`); return out; }
  for (const symbol of p.autopilot_symbols) {
    if (openPos(s, a.id, symbol) || s.orders.some((o) => o.account_id === a.id && o.symbol === symbol && o.side === "BUY" && o.status === "OPEN")) {
      out.results.push({ symbol, outcome: "skipped", detail: "already positioned" }); continue;
    }
    const run = await runAnalysis(s, user, symbol, a.id);
    if (!run.proposal) { out.results.push({ symbol, outcome: "no_trade", run_id: run.id, detail: run.reasons.slice(0, 2).join("; ") || "no proposal" }); continue; }
    const { p: prop, o } = await executeProposal(s, user, run, "autopilot");
    out.results.push({ symbol, outcome: prop.status === "EXECUTED" ? "executed" : "risk_rejected", run_id: run.id, order_id: o.id, detail: prop.decision_reason ?? o.status });
  }
  riskEvent(s, a.id, "AUTOPILOT_CYCLE", `Autopilot cycle: ${out.results.length} symbols analysed, ${out.results.filter((r) => r.outcome === "executed").length} orders placed`, { results: out.results });
  return out;
}

function riskOverview(s: State, a: DAccount) {
  const p = profile(s, a.id);
  const m = metrics(s, a);
  const limits = { ...Object.fromEntries(Object.keys(risk.DEFAULTS).map((k) => [k, p[k as keyof risk.Limits]])), binary_enabled: p.binary_enabled ?? true };
  return { account_id: a.id, currency: a.base_currency, limits, defaults: risk.DEFAULTS, ceilings: risk.CEILINGS,
    state: { kill_switch: p.kill_switch, kill_reason: p.kill_reason, kill_engaged_at: p.kill_engaged_at, daily_halted: dailyHalted(p),
      drawdown_halted: p.drawdown_halted, drawdown_halted_at: p.drawdown_halted_at, blocked_reason: blockReason(s, p) },
    metrics: m, autopilot: { status: p.autopilot_status, symbols: p.autopilot_symbols, last_cycle_at: p.autopilot_last_cycle_at, interval_seconds: AUTOPILOT_INTERVAL_S },
    system: s.systemHalt };
}
async function dueAutopilot(s: State, a: DAccount) {
  const p = profile(s, a.id);
  if (p.autopilot_status === "RUNNING" && (!p.autopilot_last_cycle_at || Date.now() - Date.parse(p.autopilot_last_cycle_at) >= AUTOPILOT_INTERVAL_S * 1000)) await autopilotCycle(s, a);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runAnalysis(s: State, user: DUser, symbol: string, accountId: string | null): Promise<Record<string, any>> {
  const t0 = performance.now(), started = now();
  const inst = findInst(symbol);
  const mine = s.accounts.filter((a) => a.owner_id === user.id && a.status === "ACTIVE");
  const acct = accountId ? mine.find((a) => a.id === accountId) : mine[0];
  if (accountId && !acct) throw new HttpError(404, "not_found", "Trading account not found");
  const bars = (tf: string, n: number) => mkt.candles(inst, tf, n).map((b) => ({ t: b.open_time, o: +b.open, h: +b.high, l: +b.low, c: +b.close }));
  const q = mkt.quote(inst);
  const nowMs = Date.now();
  const sig = (d: rs.DDoc) => ({ title: d.title, doc_type: d.doc_type, age_days: d.published_at ? (nowMs - Date.parse(d.published_at)) / 86_400_000 : 9999, sentiment: d.sentiment, is_sample: d.is_sample });
  const docs = s.docs.filter((d) => d.symbols.includes(inst.symbol) && d.published_at).map(sig).filter((d) => d.age_days <= 400);
  const macro = inst.asset_class === "FX" || inst.asset_class === "ETF"
    ? s.docs.filter((d) => (d.doc_type === "central_bank" || d.doc_type === "economic_data") && d.published_at).map(sig).filter((d) => d.age_days <= 30) : [];
  const bal = acct ? balances(s, acct) : null;
  const ctx: ag.Ctx = {
    symbol: inst.symbol, asset_class: inst.asset_class, quote_currency: inst.quote_currency, price_decimals: inst.price_decimals,
    lot_size: Number(inst.lot_size), now: nowMs, h1: bars("1h", 300), d1: bars("1d", 250),
    quote: { last: +q.last, bid: +q.bid, ask: +q.ask, market_open: q.market_open, stale: q.stale, tradable: q.tradable, source: q.source },
    docs, macro, account: acct && bal ? { id: acct.id, currency: acct.base_currency, equity: +bal.equity, cash: +bal.cash } : null,
    fx: acct ? fxRate(inst.quote_currency, acct.base_currency) : null, open_positions: 0,
  };
  const agents = agentList(s);
  const enabled = new Set(agents.filter((a) => a.enabled).map((a) => a.name));
  const weights = Object.fromEntries(agents.filter((a) => a.kind === "directional" && a.enabled).map((a) => [a.name, a.weight]));
  if (!Object.keys(weights).length) throw new HttpError(422, "business_rule_violation", "All directional agents are disabled");
  const findings = ag.runAgents(ctx, enabled);
  const d = ag.decide(ctx, findings, weights);
  const id = uuid();
  const run = {
    id, user_id: user.id, account_id: acct?.id ?? null, symbol: inst.symbol, ...d, proposal: null as Record<string, unknown> | null,
    context: { as_of: new Date(nowMs).toISOString(), quote: ctx.quote, bars_1h: ctx.h1.length, bars_1d: ctx.d1.length, research_docs: docs.length, macro_docs: macro.length, account: ctx.account, fx_to_account: ctx.fx, open_positions: 0 },
    findings: ag.ORDER.map((n) => { const { data: _d, ...rest } = findings[n]!; return rest; }),
    started_at: started, finished_at: now(), created_at: now(), latency_ms: Math.round(performance.now() - t0),
  };
  if (d.proposal && acct) run.proposal = { ...d.proposal, id: uuid(), run_id: id, account_id: acct.id, account_currency: acct.base_currency, status: "PENDING_RISK_REVIEW", created_at: now(), dismissed_at: null };
  s.aiRuns.push(run);
  await audit(s, user.id, "ai.run", { type: "ai_run", id, details: { symbol: run.symbol, decision: run.decision, net_score: run.net_score, proposal: run.proposal?.id ?? null } });
  return run;
}

// ---- binary options (mirror of backend app/binary) ---------------------------------------
const BINARY_PAYOUT = 0.8, BINARY_EXPIRIES = [60, 300, 900, 3600, 86400], BINARY_VOID_AFTER_S = 600;
const BINARY_NOTICE = "Paper simulation only. Binary options are banned for retail customers in the UK (FCA, since April 2019) and restricted across the EU/EEA. The payout is below even money, so a forecaster who is right half the time loses money; you need to win more often than the break-even rate just to stand still.";
const binaryConfig = () => ({ paper_only: true, payout_rate: BINARY_PAYOUT, expiries: BINARY_EXPIRIES, break_even_win_rate: 1 / (1 + BINARY_PAYOUT),
  coin_flip_expected_return: 0.5 * BINARY_PAYOUT - 0.5, minimum_stake: MIN_ORDER_VALUE.toFixed(2), void_after_seconds: BINARY_VOID_AFTER_S });
const midOf = (q: { bid: string; ask: string }) => (+q.bid + +q.ask) / 2;
const binaryRead = (b: DBinary) => { const { user_id: _u, ...rest } = b; return { ...rest, potential_return: (+b.stake * (1 + b.payout_rate)).toFixed(2) }; };

function settleBinaries(s: State) {
  const nowMs = Date.now();
  for (const b of (s.binaries ?? []).filter((x) => x.status === "OPEN" && Date.parse(x.expires_at) <= nowMs)) {
    const i = instOf(b.symbol), a = s.accounts.find((x) => x.id === b.account_id)!;
    const at = Date.parse(b.expires_at);
    const q = mkt.isOpen(i.market, at) ? mkt.quote(i, at) : null;     // synthetic prices are a function of time: use the price at expiry
    const stake = toUnits(b.stake);
    let status: DBinary["status"];
    if (!q) status = nowMs - at >= BINARY_VOID_AFTER_S * 1000 ? "VOID" : "OPEN";
    else {
      const px = midOf(q), k = +b.strike;
      status = px === k ? "TIE" : (b.direction === "HIGHER" ? px > k : px < k) ? "WON" : "LOST";
      b.settle_price = String(+px.toFixed(i.price_decimals + 2)); b.settle_price_at = q.as_of;
    }
    if (status === "OPEN") continue;
    const S = fromUnits(stake);
    if (status === "WON") {
      const profit = fromUnits((stake * BigInt(Math.round(b.payout_rate * 1e6))) / 1_000_000n);
      post(s, a, "BINARY_SETTLE", [["CASH", "DEBIT", fromUnits(stake + toUnits(profit))], ["INVESTMENTS", "CREDIT", S], ["REALISED_PNL", "CREDIT", profit]], b.user_id,
        `Binary ${b.direction} ${b.symbol} won`);
      b.returned = fromUnits(stake + toUnits(profit)); b.pnl = profit;
    } else if (status === "LOST") {
      post(s, a, "BINARY_SETTLE", [["REALISED_PNL", "DEBIT", S], ["INVESTMENTS", "CREDIT", S]], b.user_id, `Binary ${b.direction} ${b.symbol} lost`);
      b.returned = "0"; b.pnl = fromUnits(-stake);
    } else {
      post(s, a, "BINARY_SETTLE", [["CASH", "DEBIT", S], ["INVESTMENTS", "CREDIT", S]], b.user_id, `Binary ${b.direction} ${b.symbol} ${status.toLowerCase()}`);
      b.returned = S; b.pnl = "0";
      if (status === "VOID") b.void_reason = "no price was available after expiry";
    }
    b.status = status; b.settled_at = now();
    metrics(s, a, snapshot(s, a, "binary"));
  }
}

function binaryStats(s: State, a: DAccount) {
  const rows = (s.binaries ?? []).filter((b) => b.account_id === a.id);
  const agg = (items: DBinary[]) => {
    const won = items.filter((c) => c.status === "WON").length, lost = items.filter((c) => c.status === "LOST").length;
    const settled = items.filter((c) => c.status !== "OPEN");
    const staked = settled.reduce((t, c) => t + toUnits(c.stake), 0n), net = settled.reduce((t, c) => t + toUnits(c.pnl ?? "0"), 0n);
    return { contracts: items.length, open: items.length - settled.length, won, lost, ties: items.filter((c) => c.status === "TIE").length,
      void: items.filter((c) => c.status === "VOID").length, staked: fromUnits(staked), net_pnl: fromUnits(net),
      win_rate: won + lost ? won / (won + lost) : null, return_on_stake: staked ? Number(net) / Number(staked) : null };
  };
  const group = (key: (b: DBinary) => string, sort?: (x: string, y: string) => number) => {
    const m: Record<string, DBinary[]> = {};
    for (const b of rows) (m[key(b)] ??= []).push(b);
    return Object.fromEntries(Object.keys(m).sort(sort).map((k) => [k, agg(m[k]!)]));
  };
  const overall = agg(rows), cfg = binaryConfig(), wr = overall.win_rate;
  return { account_id: a.id, currency: a.base_currency, ...cfg, ...overall,
    expected_return_at_win_rate: wr == null ? null : wr * cfg.payout_rate - (1 - wr), edge_vs_break_even: wr == null ? null : wr - cfg.break_even_win_rate,
    by_expiry: group((b) => String(b.expiry_seconds), (x, y) => +x - +y), by_symbol: group((b) => b.symbol), by_direction: group((b) => b.direction) };
}

async function openBinary(s: State, user: DUser, a: DAccount, body: Record<string, unknown>): Promise<{ b: DBinary; replay: boolean }> {
  s.binaries ??= [];
  const cid = body.client_id == null ? null : String(body.client_id);
  if (cid != null && !/^[A-Za-z0-9_-]{8,64}$/.test(cid)) throw bad("client_id must be 8-64 characters of A-Z, 0-9, _ or -", "client_id");
  if (cid) { const ex = s.binaries.find((x) => x.account_id === a.id && x.client_id === cid); if (ex) return { b: ex, replay: true }; }
  const dir = body.direction, expiry = Number(body.expiry_seconds), stakeStr = String(body.stake ?? "");
  if (dir !== "HIGHER" && dir !== "LOWER") throw bad("direction must be HIGHER or LOWER", "direction");
  if (!/^\d+(\.\d{1,2})?$/.test(stakeStr) || +stakeStr <= 0) throw bad("stake must be positive with at most 2 decimals", "stake");
  const rule = (m: string) => new HttpError(422, "business_rule_violation", m);
  if (!BINARY_EXPIRIES.includes(expiry)) throw rule(`expiry_seconds must be one of [${BINARY_EXPIRIES.join(", ")}]`);
  const i = findInst(String(body.symbol ?? ""));
  const q = mkt.quote(i);
  if (!q.tradable) throw rule("market is closed");
  const nowMs = Date.now(), expMs = nowMs + expiry * 1000;
  const sess = mkt.sessions(i.market as mkt.MarketKey, nowMs, expMs + 1000);
  if (sess.length !== 1 || sess[0]![0] > nowMs || sess[0]![1] < expMs) throw rule("the market closes before this contract would expire; choose a shorter expiry");
  processOpen(s);
  const p = profile(s, a.id), pf = portfolio(s, a);
  metrics(s, a, pf);
  const stake = +stakeStr;
  const recent = s.orders.filter((x) => x.account_id === a.id && x.source !== "protective" && nowMs - Date.parse(x.created_at) < 60_000).length
    + s.binaries.filter((x) => x.account_id === a.id && nowMs - Date.parse(x.opened_at) < 60_000).length;
  const checks = risk.evaluateBinary({ system_halt: s.systemHalt.halted ? (s.systemHalt.reason ?? "halted") : null, kill_switch: p.kill_switch ? (p.kill_reason ?? "engaged") : null,
    daily_halted: dailyHalted(p), drawdown_halted: p.drawdown_halted, enabled: p.binary_enabled ?? true, equity: +pf.equity, stake, minimum_stake: MIN_ORDER_VALUE,
    open_after: s.binaries.filter((x) => x.account_id === a.id && x.status === "OPEN").length + 1, orders_last_minute: recent }, p);
  let reason = risk.firstFailure(checks);
  if (!reason && stake > +pf.available_cash) {
    reason = `insufficient cash: stake ${stake.toFixed(2)}, available ${(+pf.available_cash).toFixed(2)}`;
    checks.push({ name: "cash", label: "Available cash", passed: false, value: (+pf.available_cash).toFixed(2), limit: stake.toFixed(2), message: reason });
  }
  const rate = checks.find((c) => c.name === "order_rate")!;
  if (!rate.passed && !p.kill_switch) engageKill(s, a, p, rate.message, true);
  const side = dir === "HIGHER" ? "CALL" : "PUT";
  if (reason) {
    s.riskDecisions.push({ id: uuid(), account_id: a.id, order_id: null, binary_id: null, proposal_id: null, source: "binary", symbol: i.symbol, side, approved: false, reason, checks, created_at: now() });
    await audit(s, user.id, "binary.open", { type: "trading_account", id: a.id, details: { symbol: i.symbol, direction: dir, stake: stakeStr, expiry_seconds: expiry, status: "REJECTED", reason: `risk: ${reason}` } });
    save();
    throw new HttpError(422, "risk_rejected", `risk: ${reason}`, { checks });
  }
  const S = Number(stake).toFixed(2);
  post(s, a, "BINARY_OPEN", [["INVESTMENTS", "DEBIT", S], ["CASH", "CREDIT", S]], user.id, `Binary ${dir} ${i.symbol} ${expiry}s, stake ${S}`);
  const b: DBinary = { id: uuid(), account_id: a.id, user_id: user.id, symbol: i.symbol, direction: dir, stake: S, currency: a.base_currency, payout_rate: BINARY_PAYOUT,
    strike: String(+midOf(q).toFixed(i.price_decimals + 2)), expiry_seconds: expiry, opened_at: new Date(nowMs).toISOString(), expires_at: new Date(expMs).toISOString(),
    status: "OPEN", settle_price: null, settle_price_at: null, settled_at: null, returned: null, pnl: null, void_reason: null, client_id: cid };
  s.binaries.push(b);
  s.riskDecisions.push({ id: uuid(), account_id: a.id, order_id: null, binary_id: b.id, proposal_id: null, source: "binary", symbol: i.symbol, side, approved: true, reason: null, checks, created_at: now() });
  snapshot(s, a, "binary");
  await audit(s, user.id, "binary.open", { type: "binary_contract", id: b.id, details: { symbol: b.symbol, direction: dir, stake: S, expiry_seconds: expiry, strike: b.strike, status: "OPEN" } });
  return { b, replay: false };
}

const binaryRoutes: [string, RegExp, Handler][] = [
  ["GET", /^\/binary\/config$/, (c) => { authUser(c); return json(200, { ...binaryConfig(), notice: BINARY_NOTICE }); }],
  ["POST", /^\/binary\/contracts$/, async (c) => {
    const { user } = authUser(c);
    const { a } = ownedAccount(c, String(c.body.account_id ?? ""));
    const { b, replay } = await openBinary(c.s, user, a, c.body);
    return replay ? json(200, binaryRead(b), { "Idempotent-Replay": "true" }) : json(201, binaryRead(b));
  }],
  ["GET", /^\/binary\/contracts$/, (c) => {
    const { user } = authUser(c); const ids = accountIds(c, user); processOpen(c.s); save();
    const st = c.query.get("status");
    return json(200, page(c, (c.s.binaries ?? []).filter((b) => ids.includes(b.account_id) && (!st || b.status === st.toUpperCase())).reverse().map(binaryRead)));
  }],
  ["GET", /^\/binary\/contracts\/([\w-]+)$/, (c) => {
    const { user } = authUser(c); processOpen(c.s); save();
    const b = (c.s.binaries ?? []).find((x) => x.id === c.params[0] && x.user_id === user.id);
    if (!b) throw new HttpError(404, "not_found", "Binary contract not found");
    return json(200, binaryRead(b));
  }],
  ["GET", /^\/binary\/stats$/, (c) => {
    authUser(c); const { a } = ownedAccount(c, c.query.get("account_id") ?? ""); processOpen(c.s); save();
    return json(200, binaryStats(c.s, a));
  }],
];

const tradingRoutes: [string, RegExp, Handler][] = [
  ["POST", /^\/trading\/orders$/, async (c) => {
    const { user } = authUser(c);
    const { a } = ownedAccount(c, String(c.body.account_id ?? ""));
    const { o, replay } = await placeOrder(c.s, user, a, c.body as OrderBody);
    return replay ? json(200, orderDetail(c.s, o), { "Idempotent-Replay": "true" }) : json(201, orderDetail(c.s, o));
  }],
  ["GET", /^\/trading\/orders$/, (c) => {
    const { user } = authUser(c); const ids = accountIds(c, user); processOpen(c.s); save();
    const st = c.query.get("status");
    return json(200, page(c, c.s.orders.filter((o) => ids.includes(o.account_id) && (!st || o.status === st)).reverse().map(orderRead)));
  }],
  ["GET", /^\/trading\/orders\/([\w-]+)$/, (c) => {
    const { user } = authUser(c);
    const o = c.s.orders.find((x) => x.id === c.params[0] && x.user_id === user.id);
    if (!o) throw new HttpError(404, "not_found", "Order not found");
    return json(200, orderDetail(c.s, o));
  }],
  ["POST", /^\/trading\/orders\/([\w-]+)\/cancel$/, async (c) => {
    const { user } = authUser(c);
    const o = c.s.orders.find((x) => x.id === c.params[0] && x.user_id === user.id);
    if (!o) throw new HttpError(404, "not_found", "Order not found");
    if (o.status !== "OPEN") throw new HttpError(422, "business_rule_violation", `Only open orders can be cancelled (status ${o.status})`);
    o.status = "CANCELLED"; ev(o, "CANCELLED", { by: "user" });
    await audit(c.s, user.id, "order.cancel", { type: "order", id: o.id });
    return json(200, orderDetail(c.s, o));
  }],
  ["GET", /^\/trading\/executions$/, (c) => {
    const { user } = authUser(c); const ids = accountIds(c, user);
    return json(200, page(c, c.s.executions.filter((x) => ids.includes(x.account_id)).reverse()));
  }],
  ["GET", /^\/trading\/positions\/closed$/, (c) => {
    authUser(c); const { a } = ownedAccount(c, c.query.get("account_id") ?? "");
    return json(200, c.s.positions.filter((p) => p.account_id === a.id && p.status === "CLOSED").reverse().slice(0, 100)
      .map(({ id, symbol, avg_price, realised_pnl, fees, opened_at, closed_at }) => ({ id, symbol, avg_price, realised_pnl, fees, opened_at, closed_at })));
  }],
  ["POST", /^\/trading\/process$/, (c) => { admin(c); return json(200, processOpen(c.s)); }],
  ["GET", /^\/portfolio\/summary$/, async (c) => {
    authUser(c); const { a } = ownedAccount(c, c.query.get("account_id") ?? "");
    processOpen(c.s);
    await dueAutopilot(c.s, a);
    const last = c.s.snapshots.filter((x) => x.account_id === a.id).at(-1);
    if (!last || Date.now() - Date.parse(last.taken_at) > 3600e3) snapshot(c.s, a, "periodic");
    save();
    return json(200, portfolio(c.s, a));
  }],
  ["GET", /^\/portfolio\/history$/, (c) => {
    authUser(c); const { a } = ownedAccount(c, c.query.get("account_id") ?? "");
    return json(200, c.s.snapshots.filter((x) => x.account_id === a.id).map(({ account_id: _a, ...r }) => r));
  }],
  // ---- risk centre
  ["GET", /^\/risk\/status$/, (c) => { authUser(c); return json(200, c.s.systemHalt); }],
  ["GET", /^\/risk\/accounts\/([\w-]+)$/, async (c) => {
    const { a } = ownedAccount(c, c.params[0]!);
    processOpen(c.s);
    await dueAutopilot(c.s, a);
    save();
    return json(200, riskOverview(c.s, a));
  }],
  ["PUT", /^\/risk\/accounts\/([\w-]+)\/limits$/, async (c) => {
    const { user, a } = ownedAccount(c, c.params[0]!);
    const p = profile(c.s, a.id);
    const diff: Record<string, { from: number | boolean; to: number | boolean }> = {};
    if (typeof c.body.binary_enabled === "boolean" && c.body.binary_enabled !== (p.binary_enabled ?? true)) {
      diff.binary_enabled = { from: p.binary_enabled ?? true, to: c.body.binary_enabled }; p.binary_enabled = c.body.binary_enabled;
    }
    for (const k of Object.keys(risk.DEFAULTS) as (keyof risk.Limits)[]) {
      const v = c.body[k];
      if (v == null) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0 || n > risk.CEILINGS[k] || ((k === "max_open_positions" || k === "max_orders_per_minute" || k === "binary_max_open") && !Number.isInteger(n)))
        throw bad(`${k} must be greater than 0 and at most ${risk.CEILINGS[k]}`, k);
      if (p[k] !== n) { diff[k] = { from: p[k], to: n }; p[k] = n; }
    }
    if (Object.keys(diff).length) {
      const loosened = Object.entries(diff).filter(([, d]) => d.to > d.from).map(([k]) => k);
      riskEvent(c.s, a.id, "LIMITS_CHANGED", "Risk limits changed" + (loosened.length ? ` (loosened: ${loosened.join(", ")})` : ""), { changes: diff });
      await audit(c.s, user.id, "risk.limits.update", { type: "trading_account", id: a.id, details: diff });
    }
    return json(200, riskOverview(c.s, a));
  }],
  ["POST", /^\/risk\/accounts\/([\w-]+)\/kill-switch$/, async (c) => {
    const { user, a } = ownedAccount(c, c.params[0]!);
    const p = profile(c.s, a.id);
    const rule = (m: string) => new HttpError(422, "business_rule_violation", m);
    if (c.body.engaged) {
      if (p.kill_switch) throw rule("Kill switch is already engaged");
      engageKill(c.s, a, p, String(c.body.reason || "engaged manually"));
    } else {
      if (!p.kill_switch) throw rule("Kill switch is not engaged");
      p.kill_switch = false; p.kill_reason = null; p.kill_engaged_at = null;
      riskEvent(c.s, a.id, "KILL_SWITCH_OFF", "Kill switch released");
    }
    await audit(c.s, user.id, `risk.kill_switch.${c.body.engaged ? "engage" : "release"}`, { type: "trading_account", id: a.id, details: { reason: c.body.reason ?? null } });
    return json(200, riskOverview(c.s, a));
  }],
  ["POST", /^\/risk\/accounts\/([\w-]+)\/breakers\/drawdown\/reset$/, async (c) => {
    const { user, a } = ownedAccount(c, c.params[0]!);
    const p = profile(c.s, a.id);
    if (!p.drawdown_halted) throw new HttpError(422, "business_rule_violation", "Drawdown breaker is not tripped");
    p.drawdown_halted = false; p.drawdown_halted_at = null; p.peak_pnl_equity = null;
    metrics(c.s, a);
    riskEvent(c.s, a.id, "BREAKER_RESET", "Drawdown breaker reset; peak re-based to current equity");
    await audit(c.s, user.id, "risk.breaker.reset", { type: "trading_account", id: a.id });
    return json(200, riskOverview(c.s, a));
  }],
  ["POST", /^\/risk\/accounts\/([\w-]+)\/autopilot$/, async (c) => {
    const { user, a } = ownedAccount(c, c.params[0]!);
    const p = profile(c.s, a.id);
    const action = String(c.body.action);
    if (!["start", "pause", "stop"].includes(action)) throw bad("action must be start, pause or stop", "action");
    if (Array.isArray(c.body.symbols)) {
      if (c.body.symbols.length < 1 || c.body.symbols.length > 5) throw bad("Choose 1 to 5 instruments", "symbols");
      p.autopilot_symbols = [...new Set((c.body.symbols as string[]).map((x) => findInst(x).symbol))];
    }
    if (action === "start") {
      const block = blockReason(c.s, p);
      if (block) throw new HttpError(422, "business_rule_violation", `Autopilot cannot start: ${block}`);
    }
    p.autopilot_status = action === "start" ? "RUNNING" : action === "pause" ? "PAUSED" : "STOPPED";
    riskEvent(c.s, a.id, `AUTOPILOT_${action.toUpperCase()}`, action === "stop" ? "Autopilot stopped" : `Autopilot ${action}ed`, { symbols: p.autopilot_symbols });
    await audit(c.s, user.id, `risk.autopilot.${action}`, { type: "trading_account", id: a.id, details: { symbols: p.autopilot_symbols } });
    return json(200, riskOverview(c.s, a));
  }],
  ["POST", /^\/risk\/accounts\/([\w-]+)\/autopilot\/run$/, async (c) => {
    const { user, a } = ownedAccount(c, c.params[0]!);
    if (profile(c.s, a.id).autopilot_status !== "RUNNING") throw new HttpError(422, "business_rule_violation", "Start the autopilot first");
    processOpen(c.s);
    const out = await autopilotCycle(c.s, a);
    await audit(c.s, user.id, "risk.autopilot.cycle", { type: "trading_account", id: a.id, details: { results: out.results.map((r) => ({ symbol: r.symbol, outcome: r.outcome })), skipped: out.skipped ?? null } });
    return json(200, out);
  }],
  ["POST", /^\/risk\/accounts\/([\w-]+)\/emergency-stop$/, async (c) => {
    const { user, a } = ownedAccount(c, c.params[0]!);
    const p = profile(c.s, a.id);
    const reason = String(c.body.reason || "emergency stop");
    p.autopilot_status = "STOPPED";
    if (!p.kill_switch) engageKill(c.s, a, p, reason);
    let cancelled = cancelOpen(c.s, a.id, "emergency stop", (o) => o.side === "BUY" || o.source !== "protective");
    const flattened: Record<string, unknown>[] = [];
    if (c.body.flatten) {
      cancelled += cancelOpen(c.s, a.id, "emergency stop: flattening", () => true);
      for (const pos of c.s.positions.filter((x) => x.account_id === a.id && x.status === "OPEN")) {
        const { o } = await placeOrder(c.s, user, a, { symbol: pos.symbol, side: "SELL", type: "MARKET", quantity: pos.quantity }, "emergency");
        flattened.push({ symbol: pos.symbol, status: o.status, reason: o.reject_reason });
      }
    }
    riskEvent(c.s, a.id, "EMERGENCY_STOP", `Emergency stop: ${reason}`, { cancelled_orders: cancelled, flatten: !!c.body.flatten, flattened });
    await audit(c.s, user.id, "risk.emergency_stop", { type: "trading_account", id: a.id, details: { flatten: !!c.body.flatten, cancelled, flattened } });
    return json(200, riskOverview(c.s, a));
  }],
  ["GET", /^\/risk\/decisions$/, (c) => {
    authUser(c); const { a } = ownedAccount(c, c.query.get("account_id") ?? "");
    const ap = c.query.get("approved");
    return json(200, page(c, c.s.riskDecisions.filter((d) => d.account_id === a.id && (ap == null || String(d.approved) === ap)).reverse().map(({ account_id: _a, ...d }) => d)));
  }],
  ["GET", /^\/risk\/events$/, (c) => {
    authUser(c); const { a } = ownedAccount(c, c.query.get("account_id") ?? "");
    return json(200, page(c, c.s.riskEvents.filter((e) => e.account_id === a.id || e.account_id == null).reverse()));
  }],
  ["POST", /^\/admin\/risk\/halt$/, async (c) => {
    const { user } = admin(c);
    const halted = !!c.body.halted;
    if (halted && !c.body.reason) throw new HttpError(422, "business_rule_violation", "A reason is required to halt trading");
    c.s.systemHalt = { halted, reason: halted ? String(c.body.reason) : null, since: halted ? now() : null };
    riskEvent(c.s, null, halted ? "SYSTEM_HALT" : "SYSTEM_RESUME", `Platform trading ${halted ? "halted" : "resumed"}${halted ? `: ${c.body.reason}` : ""}`);
    if (halted) {
      cancelOpen(c.s, null, "risk: platform trading halted");
      for (const p of Object.values(c.s.riskProfiles)) if (p.autopilot_status === "RUNNING") p.autopilot_status = "PAUSED";
    }
    await audit(c.s, user.id, `risk.system.${halted ? "halt" : "resume"}`, { details: { reason: c.body.reason ?? null } });
    return json(200, c.s.systemHalt);
  }],
  ["POST", /^\/ai\/proposals\/([\w-]+)\/execute$/, async (c) => {
    const { user } = authUser(c);
    const run = c.s.aiRuns.find((x) => x.user_id === user.id && x.proposal?.id === c.params[0]);
    if (!run) throw new HttpError(404, "not_found", "Proposal not found");
    const { p, o } = await executeProposal(c.s, user, run);
    await audit(c.s, user.id, "ai.proposal.execute", { type: "trade_proposal", id: p.id, details: { status: p.status, order_id: o.id, reason: p.decision_reason } });
    return json(200, { proposal: withEffective(p), order_id: o.id, order_status: o.status, reason: p.decision_reason });
  }],
];

// ---- analytics (mirror of backend app/analytics) ------------------------------------------
const PERIOD_DAYS: Record<string, number | null> = { "7d": 7, "30d": 30, "90d": 90, "365d": 365, all: null };
function periodStart(period: string, created: string) {
  if (!(period in PERIOD_DAYS)) throw bad("period must be one of 7d, 30d, 90d, 365d, all", "period");
  const d = PERIOD_DAYS[period];
  const start = d ? new Date(Date.now() - d * 864e5).toISOString() : created;
  return start > created ? start : created;
}
const cashLeg = (t: DTxn) => +(t.entries.find((e) => e.ledger_code === "CASH")?.amount ?? 0);
function anPerformance(s: State, a: DAccount, period: string, bench: string | null) {
  const since = periodStart(period, a.created_at);
  const flows: Record<string, number> = {};
  let opening = 0;
  for (const t of s.txns.filter((x) => x.account_id === a.id)) {
    if (t.type === "INITIAL_FUNDING") opening += cashLeg(t);
    else if (t.type === "VIRTUAL_DEPOSIT" || t.type === "VIRTUAL_WITHDRAWAL") {
      const d = t.created_at.slice(0, 10);
      flows[d] = (flows[d] ?? 0) + (t.type === "VIRTUAL_DEPOSIT" ? 1 : -1) * cashLeg(t);
    }
  }
  const points: [string, number][] = [[a.created_at, opening], ...s.snapshots.filter((x) => x.account_id === a.id).map((x) => [x.taken_at, +x.equity] as [string, number]), [now(), +portfolio(s, a).equity]];
  const rets = an.dailyReturns(an.dailyPoints(points), flows).filter(([d]) => d > since.slice(0, 10));
  const perf = an.performance(rets.map(([, r]) => r));
  let g = 1;
  const daily = rets.map(([d, r]) => { g *= 1 + r; return { date: d, return: r, growth: g, flow: flows[d] ?? 0, drawdown: 0 }; });
  an.drawdowns([1, ...daily.map((x) => x.growth)]).slice(1).forEach((v, i) => { daily[i]!.drawdown = v; });
  const notes = [];
  if (perf.periods < an.MIN_PERIODS) notes.push(`Only ${perf.periods} daily returns in this period: Sharpe, Sortino, volatility and CAGR need at least ${an.MIN_PERIODS}.`);
  notes.push("Returns are time-weighted and exclude virtual deposits and withdrawals. Days without a valuation carry the last known equity.");
  let benchmark = null;
  if (bench) {
    const inst = findInst(bench);
    const days = Math.max(2, Math.min(1000, Math.ceil((Date.now() - Date.parse(since)) / 864e5) + 3));
    const rows = mkt.candles(inst, "1d", days).filter((c) => c.open_time.slice(0, 10) >= since.slice(0, 10)).map((c) => [c.open_time.slice(0, 10), +c.close] as [string, number]);
    benchmark = rows.length < 2 ? { symbol: inst.symbol, available: false }
      : { symbol: inst.symbol, available: true, return: rows.at(-1)![1] / rows[0]![1] - 1, curve: rows.map(([d, v]) => ({ date: d, growth: v / rows[0]![1] })) };
  }
  return { period, since, currency: a.base_currency, metrics: perf, curve: points.filter(([t]) => t >= since).map(([t, e]) => ({ t, equity: e })), daily, benchmark, notes };
}
function anRoundTrips(s: State, a: DAccount, since: string) {
  return s.positions.filter((p) => p.account_id === a.id && p.status === "CLOSED" && p.closed_at! >= since).sort((x, y) => x.closed_at!.localeCompare(y.closed_at!)).map((p) => {
    const lo = Date.parse(p.opened_at) - 1000, hi = Date.parse(p.closed_at!) + 1000;
    const exes = s.executions.filter((x) => x.account_id === a.id && x.symbol === p.symbol && Date.parse(x.executed_at) >= lo && Date.parse(x.executed_at) <= hi);
    const buys = exes.filter((x) => x.side === "BUY"), sells = exes.filter((x) => x.side === "SELL");
    const entry = buys[0] ? s.orders.find((o) => o.id === buys[0]!.order_id) : undefined;
    const ex = sells.length ? s.orders.find((o) => o.id === sells.at(-1)!.order_id) : undefined;
    const how = !ex ? "manual" : ex.source === "protective" ? ({ STOP: "stop", LIMIT: "target" } as Record<string, string>)[ex.type] ?? "protective" : ex.source;
    return { symbol: p.symbol, asset_class: instOf(p.symbol).asset_class, source: entry?.source ?? "manual", exit: how, opened_at: p.opened_at, closed_at: p.closed_at!,
      pnl: +p.realised_pnl - +p.fees, gross_pnl: +p.realised_pnl, fees: +p.fees,
      cost: buys.reduce((acc, x) => acc + +x.quantity * +x.price * +x.fx_rate, 0), proposal_id: entry?.proposal_id ?? null };
  });
}
function anTrades(s: State, a: DAccount, period: string) {
  const since = periodStart(period, a.created_at);
  const rows = anRoundTrips(s, a, since);
  const pf = portfolio(s, a);
  return { period, since, currency: a.base_currency, stats: an.tradeStats(rows),
    by_symbol: an.groupStats(rows, "symbol"), by_asset_class: an.groupStats(rows, "asset_class"), by_source: an.groupStats(rows, "source"), by_exit: an.groupStats(rows, "exit"),
    trades: [...rows].reverse().map(({ proposal_id: _p, ...r }) => ({ ...r, hold_hours: (Date.parse(r.closed_at) - Date.parse(r.opened_at)) / 3600e3 })),
    open: { positions: pf.positions.length, unrealised_pnl: pf.positions.reduce((acc, p) => acc + +p.unrealised_pnl, 0) } };
}
const BUSINESS_REASONS: [string, string][] = [["insufficient cash", "Insufficient cash"], ["insufficient position", "No position / short"], ["market is closed", "Market closed"],
  ["stale", "Stale quote"], ["no market data", "No market data"], ["FX", "No FX rate"], ["stop_loss", "Invalid bracket"], ["take_profit", "Invalid bracket"]];
function anExecution(s: State, a: DAccount, period: string) {
  const since = periodStart(period, a.created_at);
  const blank = () => ({ fills: 0, notional: 0, fees: 0, spread: 0, slippage: 0 });
  const total = blank(), groups: Record<string, ReturnType<typeof blank>> = {};
  for (const x of s.executions.filter((e) => e.account_id === a.id && e.executed_at >= since)) {
    const n = +x.quantity * +x.price * +x.fx_rate;
    for (const g of [total, (groups[instOf(x.symbol).asset_class] ??= blank())]) { g.fills++; g.notional += n; g.fees += +x.fee; g.spread += +x.spread_cost; g.slippage += +x.slippage_cost; }
  }
  const bps = (g: ReturnType<typeof blank>) => { const c = g.fees + g.spread + g.slippage, n = g.notional;
    return { ...g, total_cost: c, cost_bps: n ? (c / n) * 1e4 : null, fee_bps: n ? (g.fees / n) * 1e4 : null, spread_bps: n ? (g.spread / n) * 1e4 : null, slippage_bps: n ? (g.slippage / n) * 1e4 : null }; };
  const orders = s.orders.filter((o) => o.account_id === a.id && o.created_at >= since);
  const outcomes: Record<string, Record<string, number>> = {};
  for (const o of orders) { const r = (outcomes[o.source] ??= {}); r[o.status] = (r[o.status] ?? 0) + 1; }
  const reasons: Record<string, number> = {};
  for (const o of orders.filter((x) => x.status === "REJECTED")) {
    const label = (o.reject_reason ?? "").startsWith("risk:")
      ? `Risk: ${s.riskDecisions.find((d) => d.order_id === o.id)?.checks.find((c) => !c.passed)?.label ?? "gate"}`
      : BUSINESS_REASONS.find(([k]) => (o.reject_reason ?? "").includes(k))?.[1] ?? "Other";
    reasons[label] = (reasons[label] ?? 0) + 1;
  }
  const decided = orders.filter((o) => ["FILLED", "REJECTED", "CANCELLED", "EXPIRED"].includes(o.status));
  return { period, since, currency: a.base_currency, total: bps(total), by_asset_class: Object.entries(groups).sort().map(([k, v]) => ({ key: k, ...bps(v) })),
    orders: { total: orders.length, fill_rate: decided.length ? decided.filter((o) => o.status === "FILLED").length / decided.length : null,
      by_source: Object.entries(outcomes).sort().map(([k, v]) => ({ source: k, ...v })) },
    rejections: Object.entries(reasons).map(([reason, count]) => ({ reason, count })).sort((x, y) => y.count - x.count),
    notes: ["Spread cost is the distance from mid to the bid/ask paid; slippage is the extra beyond the bid/ask. Both use the cost model shared with the backtester."] };
}
function anRisk(s: State, a: DAccount, period: string) {
  const since = periodStart(period, a.created_at);
  const ds = s.riskDecisions.filter((d) => d.account_id === a.id && d.created_at >= since);
  const failing: Record<string, number> = {}, bySource: Record<string, { approved: number; rejected: number }> = {};
  for (const d of ds) {
    const r = (bySource[d.source] ??= { approved: 0, rejected: 0 }); r[d.approved ? "approved" : "rejected"]++;
    for (const c of d.checks) if (!c.passed) failing[c.label] = (failing[c.label] ?? 0) + 1;
  }
  const evs = s.riskEvents.filter((e) => e.account_id === a.id && e.created_at >= since);
  const counts: Record<string, number> = {};
  for (const e of evs) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return { period, since, decisions: ds.length, approved: ds.filter((d) => d.approved).length, rejected: ds.filter((d) => !d.approved).length,
    by_source: Object.entries(bySource).sort().map(([k, v]) => ({ source: k, ...v })),
    failed_checks: Object.entries(failing).map(([check, count]) => ({ check, count })).sort((x, y) => y.count - x.count), events: counts,
    breaker_trips: evs.filter((e) => (e.type.startsWith("BREAKER_") && e.type !== "BREAKER_RESET") || e.type === "ABNORMAL_ACTIVITY" || e.type === "EMERGENCY_STOP")
      .map((e) => ({ type: e.type, message: e.message, at: e.created_at })) };
}
function anAI(s: State, a: DAccount, period: string, horizon: number) {
  if (!(horizon >= 1 && horizon <= 168)) throw bad("horizon_hours must be between 1 and 168", "horizon_hours");
  const since = periodStart(period, a.created_at);
  const runs = s.aiRuns.filter((r) => r.account_id === a.id && r.created_at >= since);
  const props = runs.filter((r) => r.proposal).map((r) => r.proposal);
  const status: Record<string, number> = {};
  for (const p of props) { const k = p.status === "PENDING_RISK_REVIEW" && Date.parse(p.expires_at) <= Date.now() ? "EXPIRED" : p.status; status[k] = (status[k] ?? 0) + 1; }
  const conf = new Map<string, number>(props.map((p) => [p.id, p.confidence]));
  const trips = anRoundTrips(s, a, since).filter((t) => t.proposal_id && conf.has(t.proposal_id));
  const h = horizon * 3600e3;
  const ev: Record<string, [number, number][]> = { BUY: [], NO_TRADE: [] };
  let pending = 0;
  const closes = new Map<string, { t: number[]; c: number[] }>();
  for (const r of runs) {
    const last = r.context?.quote?.last;
    if (!last) continue;
    if (Date.parse(r.created_at) + h > Date.now()) { pending++; continue; }
    if (!closes.has(r.symbol)) { const cs = mkt.candles(instOf(r.symbol), "1h", 1000); closes.set(r.symbol, { t: cs.map((x) => Date.parse(x.open_time)), c: cs.map((x) => +x.close) }); }
    const { t, c } = closes.get(r.symbol)!;
    const target = Date.parse(r.created_at) + h;
    let i = -1; for (let k = 0; k < t.length && t[k]! <= target; k++) i = k;
    if (i < 0 || t[i]! < Date.parse(r.created_at)) continue;
    (ev[r.decision] ??= []).push([r.confidence, c[i]! / last - 1]);
  }
  const sum = (rows: [number, number][]) => ({ n: rows.length, avg_forward_return: rows.length ? rows.reduce((acc, [, x]) => acc + x, 0) / rows.length : null,
    hit_rate: rows.length ? rows.filter(([, x]) => x > 0).length / rows.length : null });
  const buy = sum(ev.BUY!), flat = sum(ev.NO_TRADE!);
  const models = s.mlVersions.filter((v) => v.status === "champion").map((v) => {
    const d = [...s.mlEvals].reverse().find((e) => e.version_id === v.id && e.kind === "drift_check");
    return { symbol: v.symbol, version: v.version, eligible: v.eligible, note: v.eligibility_note, last_drift_check: d?.created_at ?? null, drift_status: d?.status ?? null,
      max_psi: (d?.metrics as { max_psi?: number } | undefined)?.max_psi ?? null };
  });
  return { period, since, horizon_hours: horizon,
    proposals: { total: props.length, by_status: status, execution_rate: props.length ? (status.EXECUTED ?? 0) / props.length : null },
    realised: { closed_trades: trips.length, net_pnl: trips.reduce((acc, t) => acc + t.pnl, 0), calibration: an.calibration(trips.map((t) => [conf.get(t.proposal_id!)!, t.pnl > 0])) },
    signals: { runs: runs.length, pending, buy, no_trade: flat, edge: buy.n && flat.n ? buy.avg_forward_return! - flat.avg_forward_return! : null,
      buy_calibration: an.calibration(ev.BUY!.map(([c, x]) => [c, x > 0])) },
    models,
    notes: [`Forward returns compare the price ${horizon}h after each run with the price the agents saw. Agent confidence is a heuristic score, not a calibrated probability: these tables show how far it is from one.`] };
}
async function anReport(s: State, a: DAccount, period: string, email: string) {
  const pf = portfolio(s, a), b = balances(s, a);
  const { curve: _c, ...perf } = anPerformance(s, a, period, "SPY");
  const body = {
    report: "AUREX paper trading report", version: 1, generated_at: now(),
    account: { id: a.id, name: a.name, currency: a.base_currency, mode: a.mode, created_at: a.created_at, owner: email }, period,
    snapshot: { cash: +pf.cash, market_value: +pf.market_value, equity: +pf.equity, unrealised_pnl: +pf.unrealised_pnl, realised_pnl: +pf.realised_pnl, fees: +pf.fees, exposure: pf.exposure, open_positions: pf.open_positions },
    integrity: { ledger_balanced: b.balanced, ledger_lines: Object.fromEntries(b.lines.map((l) => [l.code, l.balance])) },
    performance: perf, trades: anTrades(s, a, period), execution: anExecution(s, a, period), risk: anRisk(s, a, period), ai: anAI(s, a, period, 24),
    disclaimer: "Simulated paper trading with virtual capital. Past simulated performance does not predict future results.",
  };
  return { ...body, sha256: await sha256(canonical(body)) };
}
const csvCell = (v: unknown) => {
  let x = v == null ? "" : String(v);
  if (/^[=+\-@]/.test(x) && Number.isNaN(Number(x))) x = `'${x}`;
  return /[",\n]/.test(x) ? `"${x.replaceAll('"', '""')}"` : x;
};
const toCsv = (header: string[], rows: unknown[][]) => [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
function anExport(s: State, a: DAccount, kind: string, period: string): [string[], unknown[][]] {
  const since = periodStart(period, a.created_at);
  switch (kind) {
    case "executions": return [["executed_at", "order_id", "symbol", "side", "quantity", "price", "reference_price", "fx_rate", "fee", "spread_cost", "slippage_cost", "realised_pnl", "ledger_transaction_id"],
      s.executions.filter((x) => x.account_id === a.id && x.executed_at >= since).map((x) => [x.executed_at, x.order_id, x.symbol, x.side, x.quantity, x.price, x.reference_price, x.fx_rate, x.fee, x.spread_cost, x.slippage_cost, x.realised_pnl, x.ledger_transaction_id])];
    case "orders": return [["created_at", "id", "source", "symbol", "side", "type", "quantity", "limit_price", "stop_price", "stop_loss", "take_profit", "status", "avg_fill_price", "reject_reason", "parent_order_id", "proposal_id"],
      s.orders.filter((o) => o.account_id === a.id && o.created_at >= since).map((o) => [o.created_at, o.id, o.source, o.symbol, o.side, o.type, o.quantity, o.limit_price, o.stop_price, o.stop_loss, o.take_profit, o.status, o.avg_fill_price, o.reject_reason, o.parent_order_id, o.proposal_id])];
    case "ledger": return [["created_at", "transaction_id", "type", "description", "ledger_account", "direction", "amount", "currency"],
      s.txns.filter((t) => t.account_id === a.id && t.created_at >= since).flatMap((t) => txnRead(t).entries.map((e) => [t.created_at, t.id, t.type, t.description, e.ledger_code, e.direction, e.amount, e.currency]))];
    case "trades": return [["opened_at", "closed_at", "symbol", "asset_class", "opened_by", "exit", "cost", "gross_pnl", "fees", "net_pnl"],
      anRoundTrips(s, a, since).map((t) => [t.opened_at, t.closed_at, t.symbol, t.asset_class, t.source, t.exit, t.cost.toFixed(8), t.gross_pnl.toFixed(8), t.fees.toFixed(8), t.pnl.toFixed(8)])];
    case "decisions": return [["created_at", "order_id", "proposal_id", "source", "symbol", "side", "approved", "reason", "failed_checks"],
      s.riskDecisions.filter((d) => d.account_id === a.id && d.created_at >= since).map((d) => [d.created_at, d.order_id, d.proposal_id, d.source, d.symbol, d.side, d.approved, d.reason, d.checks.filter((c) => !c.passed).map((c) => c.name).join(";")])];
    case "equity": return [["taken_at", "cash", "market_value", "equity", "reason"],
      s.snapshots.filter((x) => x.account_id === a.id && x.taken_at >= since).map((x) => [x.taken_at, x.cash, x.market_value, x.equity, x.reason])];
    default: throw new HttpError(404, "not_found", `Unknown export ${kind}`);
  }
}
const analyticsRoutes: [string, RegExp, Handler][] = [
  ["GET", /^\/analytics\/accounts\/([\w-]+)\/performance$/, (c) => { const { a } = ownedAccount(c, c.params[0]!); processOpen(c.s); return json(200, anPerformance(c.s, a, c.query.get("period") ?? "30d", c.query.get("benchmark") || null)); }],
  ["GET", /^\/analytics\/accounts\/([\w-]+)\/trades$/, (c) => { const { a } = ownedAccount(c, c.params[0]!); return json(200, anTrades(c.s, a, c.query.get("period") ?? "30d")); }],
  ["GET", /^\/analytics\/accounts\/([\w-]+)\/execution$/, (c) => { const { a } = ownedAccount(c, c.params[0]!); return json(200, anExecution(c.s, a, c.query.get("period") ?? "30d")); }],
  ["GET", /^\/analytics\/accounts\/([\w-]+)\/risk$/, (c) => { const { a } = ownedAccount(c, c.params[0]!); return json(200, anRisk(c.s, a, c.query.get("period") ?? "30d")); }],
  ["GET", /^\/analytics\/accounts\/([\w-]+)\/ai$/, (c) => { const { a } = ownedAccount(c, c.params[0]!); return json(200, anAI(c.s, a, c.query.get("period") ?? "30d", Number(c.query.get("horizon_hours") ?? 24))); }],
  ["GET", /^\/analytics\/accounts\/([\w-]+)\/report$/, async (c) => {
    const { user, a } = ownedAccount(c, c.params[0]!);
    const period = c.query.get("period") ?? "30d";
    const out = await anReport(c.s, a, period, user.email);
    await audit(c.s, user.id, "analytics.report", { type: "trading_account", id: a.id, details: { period, sha256: out.sha256 } });
    save();
    if (c.query.get("download") !== "true") return json(200, out);
    return new Response(JSON.stringify(out, null, 2), { status: 200, headers: { "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="aurex-report-${a.name.replaceAll(" ", "_").slice(0, 30)}-${period}-${today().replaceAll("-", "")}.json"` } });
  }],
  ["GET", /^\/analytics\/accounts\/([\w-]+)\/export\/(\w+)\.csv$/, async (c) => {
    const { user, a } = ownedAccount(c, c.params[0]!);
    const period = c.query.get("period") ?? "30d", kind = c.params[1]!;
    const [header, rows] = anExport(c.s, a, kind, period);
    await audit(c.s, user.id, "analytics.export", { type: "trading_account", id: a.id, details: { kind, period, rows: rows.length } });
    save();
    return new Response(toCsv(header, rows), { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="aurex-${kind}-${period}-${today().replaceAll("-", "")}.csv"` } });
  }],
];


// ---- operations (mirror of backend app/ops; simulated in the browser) ---------------------
async function verifyChain(s: State) {
  let prev = "0".repeat(64);
  for (const [i, a] of s.audit.entries()) {
    if (a.prev_hash !== prev) return { valid: false, records_checked: i + 1, first_invalid_id: a.id, reason: "prev_hash does not link" };
    if ((await sha256(prev + canonical(auditRecord(a)))) !== a.hash) return { valid: false, records_checked: i + 1, first_invalid_id: a.id, reason: "record hash mismatch" };
    prev = a.hash;
  }
  return { valid: true, records_checked: s.audit.length };
}
const ATTESTABLE: Record<string, string> = {
  pentest: "External penetration test completed and findings resolved",
  solicitor: "UK solicitor has reviewed the regulatory perimeter",
  dpia: "GDPR DPIA approved and residual actions closed",
  privacy_policy: "Privacy policy approved and published",
  broker_sandbox: "Broker sandbox integration certified end to end",
};
const opsRoutes: [string, RegExp, Handler][] = [
  ["GET", /^\/admin\/ops\/status$/, async (c) => {
    admin(c);
    const chain = await verifyChain(c.s);
    const anchors = c.s.opsAnchors ?? [], last = anchors.at(-1);
    const att = c.s.opsAttestations ?? {};
    const lastAge = last ? (Date.now() - Date.parse(last.at)) / 3600e3 : null;
    const admins = c.s.users.filter((u) => u.role === "admin" && u.is_active);
    const noMfa = admins.filter((u) => !u.mfa_enabled).map((u) => u.email);
    const g = (key: string, label: string, ok: boolean, detail: string) => ({ key, label, ok, detail });
    const gates = [
      g("environment", "Running with production settings", false, "environment = demo (static, in your browser)"),
      g("admin_mfa", "Two-factor authentication enforced for every administrator", false, `not enforced in the demo${noMfa.length ? `; without 2FA: ${noMfa.join(", ")}` : ""}`),
      g("backups", "Database backup within 26 h", false, "not applicable: the demo stores data in this browser"),
      g("offsite_backups", "Verified off-site backup within 30 h", false, "not applicable in the demo"),
      g("offsite_anchors", "Verified off-site audit anchor within 30 h", false, "not applicable in the demo"),
      g("restore_drill", "Restore drill passed within 30 days", false, "not applicable in the demo"),
      g("anchoring", "Audit head anchored externally within 2 h", lastAge != null && lastAge <= 2, last ? `sink: browser (simulated); last anchor ${lastAge!.toFixed(2)} h ago` : "sink: browser (simulated); never anchored"),
      g("monitoring", "Metrics endpoint enabled for monitoring", false, "no metrics in the demo"),
      g("shared_limits", "Rate limits shared across replicas (Redis)", false, "redis: not configured"),
      g("audit_chain", "Audit chain intact", chain.valid, `${chain.records_checked} records verified`),
      ...Object.entries(ATTESTABLE).map(([k, label]) => g(k, label, !!att[k], att[k] ? `attested ${att[k].at.slice(0, 10)} · ${att[k].reference}` : "not attested")),
    ];
    return json(200, {
      version: "demo", environment: "demo", ready: true,
      checks: { database: "browser storage", schema: "ok", redis: "not configured", worker: "simulated" },
      worker: { leader_instance: "this browser tab", heartbeat_age_seconds: 0, passes: null, last_error: null, this_process: "browser", this_process_is_leader: true },
      backup: { age_hours: null }, restore_drill: { age_hours: null },
      anchoring: { sinks: ["browser"], last: last ? { ...last, sinks: [{ sink: "browser", ok: true }], age_hours: lastAge } : null },
      gates, gates_met: gates.filter((x) => x.ok).length, gates_total: gates.length, live_trading_enabled: false,
      users: { total: c.s.users.length, admins: admins.length },
    });
  }],
  ["POST", /^\/admin\/ops\/anchor$/, async (c) => {
    const { user } = admin(c);
    await audit(c.s, user.id, "ops.audit.anchor", { details: { sinks: ["browser"] } });
    const head = c.s.audit.at(-1)!;
    const a = { at: now(), last_record_id: head.id, head_hash: head.hash, records: c.s.audit.length };
    (c.s.opsAnchors ??= []).push(a);
    return json(200, { ...a, sinks: [{ sink: "browser", ok: true }] });
  }],
  ["POST", /^\/admin\/ops\/integrity-check$/, async (c) => {
    const { user } = admin(c);
    const chain = await verifyChain(c.s);
    const unbalanced = c.s.accounts.filter((a) => !balances(c.s, a).balanced).length;
    const anchorsOk = (c.s.opsAnchors ?? []).every((a) => c.s.audit.find((r) => r.id === a.last_record_id)?.hash === a.head_hash);
    const checks = [
      { name: "audit_chain", ok: chain.valid, detail: `${chain.records_checked} records` },
      { name: "ledger_accounts_balanced", ok: unbalanced === 0, detail: `${c.s.accounts.length} accounts${unbalanced ? `, ${unbalanced} unbalanced` : ""}` },
      { name: "anchors_match_chain", ok: anchorsOk, detail: `${(c.s.opsAnchors ?? []).length} anchors` },
    ];
    const ok = checks.every((x) => x.ok);
    await audit(c.s, user.id, "ops.integrity_check", { outcome: ok ? "success" : "failure", details: { failed: checks.filter((x) => !x.ok).map((x) => x.name) } });
    return json(200, { ok, checks });
  }],
  ["POST", /^\/admin\/ops\/attestations$/, async (c) => {
    const { user } = admin(c);
    const gate = String(c.body.gate ?? ""), reference = String(c.body.reference ?? "").trim();
    const sha = String(c.body.evidence_sha256 ?? "").trim(), reviewed = String(c.body.reviewed_at ?? "").trim();
    if (!(gate in ATTESTABLE)) throw bad("gate must be an attestable go-live item", "gate");
    if (reference.length < 3) throw bad("reference is required", "reference");
    if (!/^[0-9a-f]{64}$/.test(sha)) throw bad("evidence_sha256 must be a 64-character hex digest", "evidence_sha256");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewed)) throw bad("reviewed_at must be an ISO date", "reviewed_at");
    const value = { at: now(), by: user.email, reference, evidence_sha256: sha, reviewed_at: reviewed, label: ATTESTABLE[gate]! };
    (c.s.opsAttestations ??= {})[gate] = value;
    await audit(c.s, user.id, "ops.attestation", { type: "gate", id: gate, details: value });
    return json(200, value);
  }],
];

const routes: [string, RegExp, Handler][] = [
  ...tradingRoutes,
  ...binaryRoutes,
  ...opsRoutes,
  ...analyticsRoutes,
  ["GET", /^\/system\/health$/, () => json(200, { status: "ok", database: "ok" })],
  ["GET", /^\/system\/info$/, () => json(200, { name: "AUREX AI", version: "0.2.0-demo", environment: "demo", trading_mode: "PAPER", live_trading_enabled: false, registration_open: true, supported_currencies: CURRENCIES })],
  ["GET", /^\/system\/status$/, () => json(200, {
    name: "AUREX AI", version: "0.2.0-demo", environment: "demo", phase: "soft_launch", status: "operational",
    trading_mode: "PAPER", live_trading_enabled: false,
    checks: { database: "browser storage", schema: "ok", redis: "not configured", worker: "simulated" },
    announcements: [
      "Paper trading only — all balances are virtual and no real orders are placed.",
      "Market data may be delayed or simulated; never use AUREX for investment decisions.",
      "Send feedback from the Feedback page; it is reviewed during the soft launch.",
    ],
    feedback_enabled: true, legal_review_required_for: ["marketing", "data-provider", "privacy-disclosure"],
  })],
  ["POST", /^\/feedback$/, async (c) => {
    const category = String(c.body.category ?? "");
    const message = String(c.body.message ?? "").trim();
    const email = c.body.reply_email == null ? null : String(c.body.reply_email).trim();
    if (!["bug", "idea", "data_issue", "other"].includes(category)) throw bad("invalid category", "category");
    if (message.length < 10 || message.length > 2000) throw bad("message must be 10-2000 characters", "message");
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad("invalid email", "reply_email");
    const list = (c.s.feedback ??= []);
    const row = { id: list.length + 1, created_at: now(), category, message, reply_email: email, status: "new" };
    list.push(row);
    await audit(c.s, null, "feedback.submitted", { type: "feedback", id: String(row.id), details: { category } });
    return json(201, row);
  }],
  ["GET", /^\/admin\/feedback$/, async (c) => {
    admin(c);
    const items = [...(c.s.feedback ?? [])].reverse();
    return json(200, { items, total: items.length, limit: 50, offset: 0 });
  }],

  ["POST", /^\/auth\/register$/, async ({ s, body }) => {
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad("value is not a valid email address", "email");
    const name = String(body.full_name ?? "").trim();
    if (!name) throw bad("Name is required", "full_name");
    validatePassword(body.password);
    if (s.users.some((u) => u.email === email)) throw new HttpError(409, "conflict", "An account with this email already exists");
    const salt = token().slice(0, 16);
    // First account in this browser becomes the administrator so every screen can be explored.
    const user: DUser = { id: uuid(), email, full_name: name, pw: await sha256(salt + body.password), salt, role: s.users.length === 0 ? "admin" : "user", is_active: true, created_at: now(), last_login_at: null };
    s.users.push(user);
    await audit(s, user.id, "auth.register", { type: "user", id: user.id });
    return json(201, userRead(user));
  }],
  ["POST", /^\/auth\/login$/, async ({ s, body }) => {
    const email = String(body.email ?? "").toLowerCase();
    const u = s.users.find((x) => x.email === email);
    if (!u || (await sha256(u.salt + String(body.password ?? ""))) !== u.pw) {
      await audit(s, null, "auth.login", { outcome: "failure", type: "user", id: u?.id, details: { email, reason: "invalid_credentials" } });
      save();
      throw new HttpError(401, "unauthorized", "Invalid email or password");
    }
    if (!u.is_active) throw new HttpError(403, "forbidden", "This account has been disabled");
    if (u.mfa_enabled) {
      const t = token();
      mfaChallenges.set(t, { user: u.id, exp: Date.now() + 300_000 });
      await audit(s, u.id, "auth.mfa.challenge", { type: "user", id: u.id });
      return json(200, { mfa_required: true, mfa_token: t, expires_in: 300 });
    }
    u.last_login_at = now();
    const res = issue(s, u);
    await audit(s, u.id, "auth.login", { type: "user", id: u.id, details: { method: "password" } });
    return json(200, res);
  }],
  ["POST", /^\/auth\/mfa\/verify$/, async ({ s, body }) => {
    const ch = mfaChallenges.get(String(body.mfa_token ?? ""));
    const u = ch && ch.exp > Date.now() ? s.users.find((x) => x.id === ch.user) : undefined;
    if (!u || !u.mfa_enabled) throw new HttpError(401, "unauthorized", "Sign-in step expired. Enter your password again.");
    const method = await secondFactor(u, String(body.code ?? ""));
    if (!method) { await audit(s, u.id, "auth.mfa.verify", { outcome: "failure", type: "user", id: u.id }); save(); throw new HttpError(401, "unauthorized", "Invalid authentication code"); }
    mfaChallenges.delete(String(body.mfa_token));
    u.last_login_at = now();
    const res = issue(s, u);
    await audit(s, u.id, "auth.login", { type: "user", id: u.id, details: { method: `password+${method}` } });
    return json(200, res);
  }],
  ["POST", /^\/auth\/mfa\/setup$/, async (c) => {
    const { user } = authUser(c);
    if (!(await passwordOk(user, c.body.password))) throw new HttpError(401, "unauthorized", "Password is incorrect");
    if (user.mfa_enabled) throw new HttpError(422, "business_rule_violation", "Two-factor authentication is already enabled");
    user.mfa_pending = totp.newSecret();
    await audit(c.s, user.id, "auth.mfa.setup", { type: "user", id: user.id });
    return json(200, { secret: user.mfa_pending, otpauth_uri: totp.otpauthUri(user.mfa_pending, user.email) });
  }],
  ["POST", /^\/auth\/mfa\/enable$/, async (c) => {
    const { user, session } = authUser(c);
    if (!user.mfa_pending) throw new HttpError(422, "business_rule_violation", "Start the setup first");
    const step = await totp.verify(user.mfa_pending, String(c.body.code ?? ""), null);
    if (step == null) throw new HttpError(422, "business_rule_violation", "That code is not valid. Check the time on your device and try again.");
    const codes = totp.newRecoveryCodes();
    Object.assign(user, { mfa_enabled: true, mfa_secret: user.mfa_pending, mfa_pending: null, mfa_last_step: step,
      mfa_recovery: await Promise.all(codes.map((x) => sha256(x))) });
    for (const x of c.s.sessions) if (x.user_id === user.id && !x.revoked && x.family !== session.family) { x.revoked = now(); x.reason = "mfa_enabled"; }
    await audit(c.s, user.id, "auth.mfa.enable", { type: "user", id: user.id });
    return json(200, { recovery_codes: codes });
  }],
  ["POST", /^\/auth\/mfa\/(disable|recovery-codes)$/, async (c) => {
    const { user } = authUser(c);
    if (!user.mfa_enabled) throw new HttpError(422, "business_rule_violation", "Two-factor authentication is not enabled");
    if (!(await passwordOk(user, c.body.password)) || !(await secondFactor(user, String(c.body.code ?? "")))) throw new HttpError(401, "unauthorized", "Password or authentication code is incorrect");
    if (c.params[0] === "disable") {
      Object.assign(user, { mfa_enabled: false, mfa_secret: null, mfa_pending: null, mfa_last_step: null, mfa_recovery: null });
      await audit(c.s, user.id, "auth.mfa.disable", { type: "user", id: user.id });
      return json(204, null);
    }
    const codes = totp.newRecoveryCodes();
    user.mfa_recovery = await Promise.all(codes.map((x) => sha256(x)));
    await audit(c.s, user.id, "auth.mfa.recovery_regenerate", { type: "user", id: user.id });
    return json(200, { recovery_codes: codes });
  }],
  ["POST", /^\/auth\/refresh$/, ({ s }) => {
    const rt = refreshStore.get();
    const sess = s.sessions.find((x) => x.refresh === rt);
    if (!sess || sess.revoked) throw new HttpError(401, "unauthorized", "Invalid refresh token");
    const user = s.users.find((u) => u.id === sess.user_id);
    if (!user?.is_active) throw new HttpError(401, "unauthorized", "Account unavailable");
    sess.revoked = now(); sess.reason = "rotated";
    return json(200, issue(s, user, sess.family));
  }],
  ["POST", /^\/auth\/logout$/, async ({ s }) => {
    const sess = s.sessions.find((x) => x.refresh === refreshStore.get());
    if (sess && !sess.revoked) { sess.revoked = now(); sess.reason = "logout"; await audit(s, sess.user_id, "auth.logout", { type: "user_session", id: sess.id }); }
    refreshStore.set(null);
    return json(204, null);
  }],
  ["GET", /^\/auth\/me$/, (c) => json(200, userRead(authUser(c).user))],
  ["POST", /^\/auth\/password$/, async (c) => {
    const { user, session } = authUser(c);
    validatePassword(c.body.new_password, "new_password");
    if ((await sha256(user.salt + String(c.body.current_password ?? ""))) !== user.pw) throw new HttpError(401, "unauthorized", "Current password is incorrect");
    user.pw = await sha256(user.salt + c.body.new_password);
    for (const x of c.s.sessions) if (x.user_id === user.id && x.id !== session.id && !x.revoked) { x.revoked = now(); x.reason = "password_changed"; }
    await audit(c.s, user.id, "auth.password_change", { type: "user", id: user.id });
    return json(204, null);
  }],

  ["GET", /^\/users\/me\/settings$/, (c) => {
    const { user } = authUser(c);
    c.s.settings[user.id] ??= { timezone: "Europe/London", base_currency: "USD", theme: "dark", updated_at: now() };
    return json(200, c.s.settings[user.id]);
  }],
  ["PATCH", /^\/users\/me\/settings$/, async (c) => {
    const { user } = authUser(c);
    const cur = (c.s.settings[user.id] ??= { timezone: "Europe/London", base_currency: "USD", theme: "dark", updated_at: now() });
    const changes: Record<string, string> = {};
    if (c.body.timezone) {
      try { new Intl.DateTimeFormat("en", { timeZone: String(c.body.timezone) }); } catch { throw bad("Unknown IANA timezone", "timezone"); }
      changes.timezone = String(c.body.timezone);
    }
    if (c.body.base_currency) { if (!CURRENCIES.includes(String(c.body.base_currency))) throw bad("Unsupported currency", "base_currency"); changes.base_currency = String(c.body.base_currency); }
    Object.assign(cur, changes, { updated_at: now() });
    if (Object.keys(changes).length) await audit(c.s, user.id, "user.settings.update", { type: "user", id: user.id, details: changes });
    return json(200, cur);
  }],
  ["GET", /^\/users\/me\/activity$/, (c) => {
    const { user } = authUser(c);
    return json(200, c.s.audit.filter((a) => a.actor_user_id === user.id).slice(-Number(c.query.get("limit") ?? 20)).reverse());
  }],

  ["GET", /^\/accounts$/, (c) => { const { user } = authUser(c); return json(200, c.s.accounts.filter((a) => a.owner_id === user.id).map((a) => accountRead(c.s, a))); }],
  ["POST", /^\/accounts$/, async (c) => {
    const { user } = authUser(c);
    const name = String(c.body.name ?? "").trim();
    if (!name) throw bad("Name is required", "name");
    const ccy = String(c.body.base_currency ?? "USD").toUpperCase();
    if (!CURRENCIES.includes(ccy)) throw new HttpError(422, "business_rule_violation", `Unsupported currency. Supported: ${CURRENCIES.join(", ")}`);
    const start = c.body.starting_balance == null ? "100000" : money(c.body.starting_balance);
    if (toUnits(start) > MAX_BALANCE) throw new HttpError(422, "business_rule_violation", "Starting balance exceeds the virtual maximum of 10000000");
    if (c.s.accounts.filter((a) => a.owner_id === user.id).length >= 10) throw new HttpError(422, "business_rule_violation", "Maximum number of paper accounts reached");
    const a: DAccount = { id: uuid(), owner_id: user.id, name, mode: "PAPER", base_currency: ccy, status: "ACTIVE", created_at: now() };
    c.s.accounts.push(a);
    const t = post(c.s, a, "INITIAL_FUNDING", [["CASH", "DEBIT", start], ["OPENING_EQUITY", "CREDIT", start]], user.id, "Initial virtual funding");
    await audit(c.s, user.id, "account.paper.create", { type: "trading_account", id: a.id, details: { name, currency: ccy, starting_balance: start, ledger_transaction_id: t.id } });
    return json(201, accountRead(c.s, a));
  }],
  ["GET", /^\/accounts\/([\w-]+)$/, (c) => json(200, accountRead(c.s, ownedAccount(c, c.params[0]!).a))],
  ["GET", /^\/accounts\/([\w-]+)\/balances$/, (c) => {
    const { a } = ownedAccount(c, c.params[0]!);
    const b = balances(c.s, a);
    return json(200, { trading_account_id: a.id, currency: a.base_currency, cash: b.cash, investments: b.investments, equity: b.equity, ledger_balanced: b.balanced, lines: b.lines.map(({ _net, ...l }) => l) });
  }],
  ["GET", /^\/accounts\/([\w-]+)\/ledger$/, (c) => {
    const { a } = ownedAccount(c, c.params[0]!);
    const limit = Number(c.query.get("limit") ?? 50); const offset = Number(c.query.get("offset") ?? 0);
    const all = c.s.txns.filter((t) => t.account_id === a.id).reverse();
    return json(200, { items: all.slice(offset, offset + limit).map(txnRead), total: all.length, limit, offset });
  }],
  ["POST", /^\/accounts\/([\w-]+)\/deposits$/, (c) => movement(c, "VIRTUAL_DEPOSIT")],
  ["POST", /^\/accounts\/([\w-]+)\/withdrawals$/, (c) => movement(c, "VIRTUAL_WITHDRAWAL")],

  ["GET", /^\/admin\/users$/, (c) => { admin(c); return json(200, { items: c.s.users.map(userRead), total: c.s.users.length, limit: 200, offset: 0 }); }],
  ["PATCH", /^\/admin\/users\/([\w-]+)$/, async (c) => {
    const { user: me } = admin(c);
    const t = c.s.users.find((u) => u.id === c.params[0]);
    if (!t) throw new HttpError(404, "not_found", "User not found");
    if (t.id === me.id && (c.body.role === "user" || c.body.is_active === false || c.body.reset_mfa)) throw new HttpError(422, "business_rule_violation", "Administrators cannot demote, disable or reset two-factor authentication for themselves");
    const changes: Record<string, unknown> = {};
    if (c.body.role && c.body.role !== t.role) { t.role = c.body.role as DUser["role"]; changes.role = t.role; }
    if (typeof c.body.is_active === "boolean" && c.body.is_active !== t.is_active) { t.is_active = c.body.is_active; changes.is_active = t.is_active; }
    if (c.body.reset_mfa && t.mfa_enabled) { Object.assign(t, { mfa_enabled: false, mfa_secret: null, mfa_pending: null, mfa_last_step: null, mfa_recovery: null }); changes.mfa_reset = true; }
    if (Object.keys(changes).length) {
      for (const x of c.s.sessions) if (x.user_id === t.id && !x.revoked) { x.revoked = now(); x.reason = "admin_update"; }
      await audit(c.s, me.id, "admin.user.update", { type: "user", id: t.id, details: changes });
    }
    return json(200, userRead(t));
  }],
  ["GET", /^\/admin\/audit$/, (c) => {
    admin(c);
    const action = c.query.get("action");
    const rows = c.s.audit.filter((a) => !action || a.action === action).slice().reverse();
    const limit = Number(c.query.get("limit") ?? 50);
    return json(200, { items: rows.slice(0, limit), total: rows.length, limit, offset: 0 });
  }],
  ["GET", /^\/auth\/sessions$/, (c) => {
    const { user, session } = authUser(c);
    const live = c.s.sessions.filter((x) => x.user_id === user.id && !x.revoked);
    return json(200, live.map((x) => {
      const first = c.s.sessions.filter((y) => y.family === x.family).map((y) => y.created_at ?? now()).sort()[0]!;
      return { id: x.family, signed_in_at: first, last_active_at: x.created_at ?? now(), expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
        ip_address: "browser", user_agent: x.user_agent ?? null, current: x.family === session.family };
    }).reverse());
  }],
  ["POST", /^\/auth\/sessions\/revoke-others$/, async (c) => {
    const { user, session } = authUser(c);
    for (const x of c.s.sessions) if (x.user_id === user.id && !x.revoked && x.family !== session.family) { x.revoked = now(); x.reason = "revoked_by_user"; }
    await audit(c.s, user.id, "auth.session.revoke_others", { type: "user", id: user.id });
    return json(204, null);
  }],
  ["POST", /^\/auth\/sessions\/([\w-]+)\/revoke$/, async (c) => {
    const { user } = authUser(c);
    const fam = c.s.sessions.filter((x) => x.user_id === user.id && x.family === c.params[0]);
    if (!fam.length) throw new HttpError(404, "not_found", "Session not found");
    for (const x of fam) if (!x.revoked) { x.revoked = now(); x.reason = "revoked_by_user"; }
    await audit(c.s, user.id, "auth.session.revoke", { type: "user_session", id: c.params[0] });
    return json(204, null);
  }],
  ["GET", /^\/admin\/audit\/export$/, async (c) => {
    const { user } = admin(c);
    await audit(c.s, user.id, "admin.audit.export", { details: { from_id: 1 } });
    const lines = [JSON.stringify({ format: "aurex-audit-export/1", exported_at: now(), from_id: 1, records: c.s.audit.length, anchor_prev_hash: "0".repeat(64) }),
      ...c.s.audit.map((a) => JSON.stringify({ id: a.id, ...auditRecord(a), prev_hash: a.prev_hash, hash: a.hash }))];
    return new Response(lines.join("\n") + "\n", { status: 200, headers: { "Content-Type": "application/x-ndjson",
      "Content-Disposition": `attachment; filename="aurex-audit-${now().replace(/[-:]/g, "").slice(0, 15)}Z.jsonl"` } });
  }],
  ["GET", /^\/admin\/audit\/verify$/, async (c) => {
    admin(c);
    let prev = "0".repeat(64);
    for (const [i, a] of c.s.audit.entries()) {
      if (a.prev_hash !== prev) return json(200, { valid: false, records_checked: i + 1, first_invalid_id: a.id, reason: "prev_hash does not link" });
      if ((await sha256(prev + canonical(auditRecord(a)))) !== a.hash) return json(200, { valid: false, records_checked: i + 1, first_invalid_id: a.id, reason: "record hash mismatch" });
      prev = a.hash;
    }
    return json(200, { valid: true, records_checked: c.s.audit.length });
  }],

  ["GET", /^\/markets\/status$/, (c) => { authUser(c); return json(200, marketStatuses()); }],
  ["GET", /^\/markets\/overview$/, (c) => {
    authUser(c);
    const groups: Record<string, unknown[]> = { CRYPTO: [], FX: [], STOCK: [], ETF: [] };
    for (const i of [...INSTRUMENTS].sort((a, b) => a.symbol.localeCompare(b.symbol))) groups[i.asset_class]!.push(withQuote(i));
    return json(200, { markets: marketStatuses(), groups, data_mode: "synthetic" });
  }],
  ["GET", /^\/markets\/instruments$/, (c) => {
    authUser(c);
    const cls = c.query.get("asset_class"); const q = c.query.get("q")?.toLowerCase();
    return json(200, INSTRUMENTS.filter((i) => (!cls || i.asset_class === cls) && (!q || `${i.symbol} ${i.display_name}`.toLowerCase().includes(q))).map(instRead));
  }],
  ["GET", /^\/markets\/instruments\/([^/]+)$/, (c) => { authUser(c); return json(200, withQuote(findInst(c.params[0]!))); }],
  ["GET", /^\/markets\/instruments\/([^/]+)\/quote$/, (c) => { authUser(c); return json(200, mkt.quote(findInst(c.params[0]!))); }],
  ["GET", /^\/markets\/instruments\/([^/]+)\/candles$/, (c) => {
    authUser(c);
    const i = findInst(c.params[0]!);
    const tf = c.query.get("timeframe") ?? "1h";
    if (!mkt.TIMEFRAMES[tf]) throw new HttpError(422, "business_rule_violation", "Unsupported timeframe");
    const limit = Math.min(Number(c.query.get("limit") ?? 200), 1000);
    const rows = mkt.candles(i, tf, limit);
    const names = (c.query.get("indicators") ?? "").split(",").filter(Boolean);
    return json(200, { symbol: i.symbol, timeframe: tf, source: "synthetic", candles: rows, indicators: mkt.indicators(names, rows.map((r) => +r.close)) });
  }],
  ["GET", /^\/markets\/watchlist$/, (c) => json(200, watchlist(c.s, authUser(c).user.id))],
  ["POST", /^\/markets\/watchlist\/items$/, (c) => {
    const { user } = authUser(c);
    const i = findInst(String(c.body.symbol ?? ""));
    const wl = watchlist(c.s, user.id);
    if (wl.items.some((x) => x.instrument.symbol === i.symbol)) throw new HttpError(409, "conflict", `${i.symbol} is already on the watchlist`);
    c.s.watchlists[user.id]!.push(i.symbol);
    return json(201, watchlist(c.s, user.id));
  }],
  ["DELETE", /^\/markets\/watchlist\/items\/([^/]+)$/, (c) => {
    const { user } = authUser(c);
    const i = findInst(c.params[0]!);
    watchlist(c.s, user.id);
    const list = c.s.watchlists[user.id]!;
    if (!list.includes(i.symbol)) throw new HttpError(404, "not_found", `${i.symbol} is not on the watchlist`);
    c.s.watchlists[user.id] = list.filter((x) => x !== i.symbol);
    return json(200, watchlist(c.s, user.id));
  }],

  ["GET", /^\/research\/status$/, (c) => { authUser(c); return json(200, { engine: "extractive", model: null, embedding_model: "hashing-v1-384 (browser)", documents: c.s.docs.length, chunks: c.s.chunks.length, url_ingestion_enabled: false }); }],
  ["GET", /^\/research\/documents$/, (c) => {
    authUser(c);
    const q = c.query.get("q")?.toLowerCase(), type = c.query.get("doc_type"), sym = c.query.get("symbol");
    const rows = c.s.docs.filter((d) => (!q || d.title.toLowerCase().includes(q)) && (!type || d.doc_type === type) && (!sym || d.symbols.includes(sym)))
      .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));
    return json(200, { items: rows.map(docRead), total: rows.length, limit: 200, offset: 0 });
  }],
  ["GET", /^\/research\/documents\/([\w-]+)$/, (c) => {
    authUser(c);
    const d = c.s.docs.find((x) => x.id === c.params[0]);
    if (!d) throw new HttpError(404, "not_found", "Research document not found");
    const chunks = c.s.chunks.filter((x) => x.document_id === d.id).sort((a, b) => a.ordinal - b.ordinal).map(({ embedding: _e, document_id: _d, ...rest }) => rest);
    return json(200, { ...docRead(d), chunks });
  }],
  ["POST", /^\/research\/documents$/, async (c) => {
    const { user } = admin(c);
    if (!c.body.text) throw new HttpError(422, "business_rule_violation", "Provide `text` (HTML ingestion of pasted markup requires the backend)");
    const r = await ingest(c.s, { title: String(c.body.title ?? ""), text: String(c.body.text), source_name: String(c.body.source_name ?? "Manual"), source_url: (c.body.source_url as string) ?? null, published_at: (c.body.published_at as string) ?? null, doc_type: (c.body.doc_type as string) ?? null, content_type: "text/plain" });
    return finishIngest(c.s, user, [r], "manual");
  }],
  ["POST", /^\/research\/documents\/upload$/, async (c) => {
    const { user } = admin(c);
    const file = c.form?.get("file");
    if (!(file instanceof File)) throw bad("file is required", "file");
    if (file.size > 10 * 1024 * 1024) throw new HttpError(422, "business_rule_violation", "Document exceeds the 10 MB limit");
    const name = file.name.toLowerCase();
    if (name.endsWith(".pdf") || file.type === "application/pdf") throw new HttpError(422, "business_rule_violation", "PDF extraction runs on the AUREX backend and is not available in the browser demo");
    const raw = await file.text();
    const html = name.endsWith(".html") || name.endsWith(".htm") || /^\s*<(!doctype|html)/i.test(raw);
    const { title, text } = html ? rs.htmlToText(raw) : { title: "", text: raw };
    const r = await ingest(c.s, { title: title || file.name, text, source_name: String(c.form?.get("source_name") ?? "Upload"), published_at: (c.form?.get("published_at") as string) || null, content_type: html ? "text/html" : "text/plain" });
    return finishIngest(c.s, user, [r], "upload");
  }],
  ["POST", /^\/research\/documents\/fetch$/, (c) => { admin(c); throw new HttpError(403, "forbidden", "URL ingestion requires the AUREX backend"); }],
  ["DELETE", /^\/research\/documents\/([\w-]+)$/, async (c) => {
    const { user } = admin(c);
    const d = c.s.docs.find((x) => x.id === c.params[0]);
    if (!d) throw new HttpError(404, "not_found", "Research document not found");
    c.s.docs = c.s.docs.filter((x) => x.id !== d.id);
    c.s.chunks = c.s.chunks.filter((x) => x.document_id !== d.id);
    await audit(c.s, user.id, "research.document.delete", { type: "research_document", id: d.id, details: { title: d.title } });
    return json(204, null);
  }],
  ["POST", /^\/research\/samples$/, async (c) => {
    const { user } = admin(c);
    const created = await loadSamples(c.s);
    if (created) await audit(c.s, user.id, "research.samples.load", { details: { documents: created } });
    const samples = c.s.docs.filter((d) => d.is_sample);
    return json(200, { created, duplicates: samples.length - created, documents: samples.map(docRead) });
  }],
  ["GET", /^\/research\/search$/, (c) => {
    authUser(c);
    const q = c.query.get("q") ?? "";
    const syms = (c.query.get("symbols") ?? "").split(",").filter(Boolean);
    const hits = rs.search(c.s.docs, c.s.chunks, q, Number(c.query.get("k") ?? 8), syms);
    return json(200, hits.map((h) => ({ chunk_id: h.chunk.id, document: docRead(h.doc), text: h.chunk.text, page: h.chunk.page, paragraph: h.chunk.paragraph, score: h.score, stale: false })));
  }],
  ["POST", /^\/research\/ask$/, async (c) => {
    const { user } = authUser(c);
    const question = String(c.body.question ?? "").trim();
    if (question.length < 3) throw bad("Question is too short", "question");
    const t0 = performance.now();
    const symbols = Array.isArray(c.body.symbols) ? (c.body.symbols as string[]) : [];
    const ev = rs.search(c.s.docs, c.s.chunks, question, 8, symbols, (c.body.max_age_days as number) || undefined);
    const body = rs.report(question, ev);
    const r = { id: uuid(), user_id: user.id, question, symbols, engine: body.engine, confidence: body.confidence.score, insufficient_evidence: body.insufficient_evidence, created_at: now(), latency_ms: Math.round(performance.now() - t0), body };
    c.s.reports.push(r);
    await audit(c.s, user.id, "research.ask", { type: "research_report", id: r.id, details: { engine: r.engine, sources: ev.length, facts: body.facts.length } });
    return json(201, r);
  }],
  ["GET", /^\/research\/reports$/, (c) => {
    const { user } = authUser(c);
    const mine = c.s.reports.filter((r) => r.user_id === user.id).reverse();
    return json(200, { items: mine.slice(0, 30).map(reportSummary), total: mine.length, limit: 30, offset: 0 });
  }],
  ["GET", /^\/ai\/agents$/, (c) => { authUser(c); return json(200, agentList(c.s)); }],
  ["PATCH", /^\/ai\/agents\/(\w+)$/, async (c) => {
    const { user } = admin(c);
    const meta = agentList(c.s).find((a) => a.name === c.params[0]);
    if (!meta) throw new HttpError(404, "not_found", "Agent not found");
    if (meta.kind === "gate" && (c.body.enabled === false || (c.body.weight != null && c.body.weight !== 0))) throw new HttpError(422, "business_rule_violation", "Gate agents (regime, portfolio, risk) cannot be disabled or weighted");
    const w = c.body.weight as number | undefined;
    if (w != null && (typeof w !== "number" || w < 0 || w > 1)) throw bad("weight must be between 0 and 1", "weight");
    c.s.aiAgents[meta.name] = { enabled: (c.body.enabled as boolean | undefined) ?? meta.enabled, weight: w ?? meta.weight };
    await audit(c.s, user.id, "ai.agent.update", { type: "ai_agent", id: meta.name, details: c.body });
    return json(200, agentList(c.s).find((a) => a.name === meta.name));
  }],
  ["POST", /^\/ai\/run$/, async (c) => {
    const { user } = authUser(c);
    const run = await runAnalysis(c.s, user, String(c.body.symbol ?? ""), c.body.account_id ? String(c.body.account_id) : null);
    const { user_id: _u, ...out } = run;
    return json(201, { ...out, proposal: withEffective(run.proposal) });
  }],
  ["GET", /^\/ai\/runs$/, (c) => {
    const { user } = authUser(c);
    const mine = c.s.aiRuns.filter((r) => r.user_id === user.id).reverse();
    return json(200, { items: mine.slice(0, 30).map(runSummary), total: mine.length, limit: 30, offset: 0 });
  }],
  ["GET", /^\/ai\/runs\/([\w-]+)$/, (c) => {
    const { user } = authUser(c);
    const r = c.s.aiRuns.find((x) => x.id === c.params[0] && x.user_id === user.id);
    if (!r) throw new HttpError(404, "not_found", "Run not found");
    const { user_id: _u, ...out } = r;
    return json(200, { ...out, proposal: withEffective(r.proposal) });
  }],
  ["GET", /^\/ai\/proposals$/, (c) => {
    const { user } = authUser(c);
    const ps = c.s.aiRuns.filter((r) => r.user_id === user.id && r.proposal).map((r) => withEffective(r.proposal)).reverse();
    return json(200, { items: ps.slice(0, 30), total: ps.length, limit: 30, offset: 0 });
  }],
  ["POST", /^\/ai\/proposals\/([\w-]+)\/dismiss$/, async (c) => {
    const { user } = authUser(c);
    const r = c.s.aiRuns.find((x) => x.user_id === user.id && x.proposal?.id === c.params[0]);
    if (!r) throw new HttpError(404, "not_found", "Proposal not found");
    if (r.proposal.status !== "PENDING_RISK_REVIEW") throw new HttpError(422, "business_rule_violation", "Only pending proposals can be dismissed");
    r.proposal.status = "DISMISSED"; r.proposal.dismissed_at = now();
    await audit(c.s, user.id, "ai.proposal.dismiss", { type: "trade_proposal", id: r.proposal.id });
    return json(200, withEffective(r.proposal));
  }],
  ["GET", /^\/ml\/algorithms$/, (c) => { authUser(c); return json(200, ML_ALGOS); }],
  ["GET", /^\/ml\/models$/, (c) => {
    authUser(c);
    return json(200, c.s.mlModels.map((m) => ({ ...m, versions: c.s.mlVersions.filter((v) => v.model_id === m.id).sort((a, b) => b.version - a.version).map(mlSummaryRead) })));
  }],
  ["POST", /^\/ml\/train$/, async (c) => {
    const { user } = admin(c);
    const algo = String(c.body.algorithm ?? "logistic");
    if (algo !== "logistic") throw new HttpError(422, "business_rule_violation", "Random forest and LightGBM run on the AUREX backend; the browser demo supports logistic regression");
    const inst = findInst(String(c.body.symbol ?? ""));
    const horizon = Number(c.body.horizon ?? 4), days = Math.min(365, Math.max(60, Number(c.body.days ?? 180)));
    const ds = ml.buildDataset(hourBars(inst, days * 24), horizon);
    let wf;
    try { wf = ml.walkForward(ds, inst.asset_class, "synthetic"); } catch (e) { throw new HttpError(422, "business_rule_violation", (e as Error).message); }
    const final = ml.fitLogit(ds.X, ds.y);
    const total = final.w.reduce((a, w) => a + Math.abs(w), 0) || 1;
    const importance = Object.fromEntries(ml.FEATURES.map((f, j) => [f, +(Math.abs(final.w[j]!) / total).toFixed(4)]).sort((a, b) => (b[1] as number) - (a[1] as number)));
    let spec = c.s.mlModels.find((m) => m.symbol === inst.symbol && m.horizon === horizon && m.algorithm === algo);
    if (!spec) { spec = { id: uuid(), name: `${inst.symbol} · Logistic regression · ${horizon}h`, symbol: inst.symbol, timeframe: "1h", horizon, algorithm: algo, created_at: now() }; c.s.mlModels.push(spec); }
    const version = Math.max(0, ...c.s.mlVersions.filter((v) => v.model_id === spec!.id).map((v) => v.version)) + 1;
    const failed = wf.gates.filter((g) => !g.passed).map((g) => g.name);
    const v = {
      id: uuid(), model_id: spec.id, symbol: inst.symbol, version, status: "candidate", eligible: wf.eligible,
      eligibility_note: wf.eligible ? "All validation gates passed" : `Failed: ${failed.join("; ")}`, data_source: "synthetic",
      trained_at: now(), promoted_at: null, retired_at: null, n_samples: ds.y.length, gates: wf.gates,
      metrics: { oos: wf.oos, baselines: wf.baselines, folds: wf.folds, calibration: wf.calibration, curves: wf.curves, horizon },
      feature_importance: importance, train_from: ds.times[0], train_to: ds.times.at(-1), weights: final, reference: ml.reference(ds.X),
      artifact_sha256: await sha256(JSON.stringify(final)),
    };
    c.s.mlVersions.push(v);
    c.s.mlEvals.push({ id: uuid(), version_id: v.id, kind: "walk_forward", status: wf.eligible ? "eligible" : "ineligible", metrics: { oos: wf.oos, gates: wf.gates }, created_at: now() });
    await audit(c.s, user.id, "ml.train", { type: "model_version", id: v.id, details: { symbol: v.symbol, algorithm: algo, version, eligible: v.eligible, data_source: "synthetic" } });
    return json(201, mlDetail(c.s, v));
  }],
  ["GET", /^\/ml\/versions\/([\w-]+)$/, (c) => {
    authUser(c);
    const v = c.s.mlVersions.find((x) => x.id === c.params[0]);
    if (!v) throw new HttpError(404, "not_found", "Model version not found");
    return json(200, mlDetail(c.s, v));
  }],
  ["POST", /^\/ml\/versions\/([\w-]+)\/promote$/, async (c) => {
    const { user } = admin(c);
    const v = c.s.mlVersions.find((x) => x.id === c.params[0]);
    if (!v) throw new HttpError(404, "not_found", "Model version not found");
    if (v.status !== "candidate") throw new HttpError(422, "business_rule_violation", "Only candidate versions can be promoted");
    // Every static-demo candidate is trained on labelled synthetic data. Even a stale
    // eligible flag must never create a champion here; RF/LightGBM are backend-only.
    if (v.data_source === "synthetic" || !v.eligible) {
      await audit(c.s, user.id, "ml.promote", { type: "model_version", id: v.id, outcome: "failure",
        details: { reason: "synthetic_only", version: v.version } });
      throw new HttpError(422, "business_rule_violation",
        "Synthetic demo models cannot be promoted. Train on real data in the AUREX backend.",
        v.gates.filter((g: { passed: boolean }) => !g.passed));
    }
    throw new HttpError(422, "business_rule_violation", `Version is not eligible for promotion. ${v.eligibility_note}`,
      v.gates.filter((g: { passed: boolean }) => !g.passed));
  }],
  ["POST", /^\/ml\/versions\/([\w-]+)\/retire$/, async (c) => {
    const { user } = admin(c);
    const v = c.s.mlVersions.find((x) => x.id === c.params[0]);
    if (!v) throw new HttpError(404, "not_found", "Model version not found");
    if (v.status === "retired") throw new HttpError(422, "business_rule_violation", "Version is already retired");
    v.status = "retired"; v.retired_at = now();
    await audit(c.s, user.id, "ml.retire", { type: "model_version", id: v.id });
    return json(200, mlDetail(c.s, v));
  }],
  ["POST", /^\/ml\/versions\/([\w-]+)\/drift-check$/, async (c) => {
    const { user } = admin(c);
    const v = c.s.mlVersions.find((x) => x.id === c.params[0]);
    if (!v) throw new HttpError(404, "not_found", "Model version not found");
    const ds = ml.buildDataset(hourBars(findInst(v.symbol), 30 * 24), v.metrics.horizon);
    const p = ds.X.map((r) => ml.predict(v.weights, r));
    const recent = p.reduce((s, x, i) => s + (x - ds.y[i]!) ** 2, 0) / p.length;
    const result = { ...ml.drift(v.reference, ds.X, recent, v.metrics.oos.brier), window_days: 30, samples: ds.y.length };
    const ev = { id: uuid(), version_id: v.id, kind: "drift_check", status: result.status, metrics: result, created_at: now() };
    c.s.mlEvals.push(ev);
    if (result.status === "drift" && v.eligible) { v.eligible = false; v.eligibility_note = `Drift detected: ${result.reasons.join("; ")}`; }
    await audit(c.s, user.id, "ml.drift_check", { type: "model_version", id: v.id, details: { status: result.status, eligible_after: v.eligible } });
    return json(201, ev);
  }],
  ["GET", /^\/ml\/champion$/, (c) => { authUser(c); throw new HttpError(404, "not_found", `No champion model for ${c.query.get("symbol")}`); }],
  ["GET", /^\/backtests\/strategies$/, (c) => { authUser(c); return json(200, bt.STRATEGIES.map(({ grid, ...s }) => ({ ...s, grid_size: grid.length }))); }],
  ["POST", /^\/backtests$/, async (c) => {
    const { user } = authUser(c);
    const key = String(c.body.strategy ?? "");
    const params = c.body.params as Record<string, number> | undefined;
    try { bt.validateParams(key, params); } catch (e) { throw new HttpError(422, "business_rule_violation", (e as Error).message); }
    const inst = findInst(String(c.body.symbol ?? ""));
    const days = Number(c.body.days ?? 180);
    if (days < 30 || days > 365) throw bad("days must be between 30 and 365", "days");
    const raw = mkt.candles(inst, "1h", days * 24);
    const bars = { t: raw.map((x) => x.open_time), o: raw.map((x) => +x.open), h: raw.map((x) => +x.high), l: raw.map((x) => +x.low), c: raw.map((x) => +x.close) };
    if (bars.c.length < 300) throw new HttpError(422, "business_rule_violation", "Not enough history for a backtest (need at least 300 hourly bars)");
    const costs = { ...bt.DEFAULT_COSTS[inst.asset_class]!, ...Object.fromEntries(Object.entries((c.body.costs as Record<string, number>) ?? {}).filter(([, v]) => v != null)) };
    const capital = Number(c.body.capital ?? 100_000), optimise = c.body.optimise !== false;
    const t0 = performance.now();
    let result;
    try { result = bt.evaluate(bars, key, params, inst.asset_class, costs, capital, optimise, Number(inst.lot_size)); } catch (e) { throw new HttpError(422, "business_rule_violation", (e as Error).message); }
    result.warnings.unshift("Backtested on synthetic data: the generator is built from smooth cycles, so results describe the simulator, not a real market.");
    const run = { id: uuid(), user_id: user.id, strategy_key: key, symbol: inst.symbol, timeframe: "1h", days, params: result.params, data_source: "synthetic",
      config: { costs, risk: bt.RISK, capital, optimise, asset_class: inst.asset_class }, period_from: bars.t[0], period_to: bars.t.at(-1),
      oos_sharpe: result.out_of_sample.strategy.sharpe, oos_return: result.out_of_sample.strategy.total_return, result, created_at: now(), latency_ms: Math.round(performance.now() - t0) };
    c.s.backtests.push(run);
    if (c.s.backtests.length > 20) c.s.backtests.splice(0, c.s.backtests.length - 20);   // keep localStorage small
    await audit(c.s, user.id, "backtest.run", { type: "backtest", id: run.id, details: { strategy: key, symbol: inst.symbol, oos_sharpe: run.oos_sharpe, optimised: optimise } });
    const { user_id: _u, ...out } = run;
    return json(201, out);
  }],
  ["GET", /^\/backtests$/, (c) => {
    const { user } = authUser(c);
    const mine = c.s.backtests.filter((r) => r.user_id === user.id).reverse().map(({ result: _r, config: _c, user_id: _u, ...rest }) => rest);
    return json(200, { items: mine, total: mine.length, limit: 30, offset: 0 });
  }],
  ["GET", /^\/backtests\/([\w-]+)$/, (c) => {
    const { user } = authUser(c);
    const r = c.s.backtests.find((x) => x.id === c.params[0] && x.user_id === user.id);
    if (!r) throw new HttpError(404, "not_found", "Backtest not found");
    const { user_id: _u, ...out } = r;
    return json(200, out);
  }],
  ["GET", /^\/research\/reports\/([\w-]+)$/, (c) => {
    const { user } = authUser(c);
    const r = c.s.reports.find((x) => x.id === c.params[0] && x.user_id === user.id);
    if (!r) throw new HttpError(404, "not_found", "Report not found");
    return json(200, r);
  }],
];

/** fetch()-compatible entry point used by services/api.ts in demo builds. */
export async function demoFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input, "https://demo.local");
  const path = url.pathname.replace(/^.*\/api\/v1/, "");
  const method = (init.method ?? "GET").toUpperCase();
  const s = load();
  try {
    for (const [m, re, handler] of routes) {
      if (m !== method) continue;
      const match = path.match(re);
      if (!match) continue;
      const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : {};
      const form = init.body instanceof FormData ? init.body : undefined;
      const res = await handler({ s, body, form, headers: new Headers(init.headers), params: match.slice(1), query: url.searchParams });
      if (method !== "GET" || path.startsWith("/markets/watchlist") || path.startsWith("/users/me/settings")) save();
      return res;
    }
    throw new HttpError(404, "not_found", `No demo route for ${method} ${path}`);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: { code: e.code, message: e.message, details: e.details ?? null, request_id: null } });
    throw e;
  }
}

export function resetDemo() {
  memory = null;
  try { localStorage.removeItem(KEY); localStorage.removeItem(REFRESH_KEY); } catch { /* ignore */ }
}
