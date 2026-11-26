/**
 * API client.
 * - Access token lives in memory only (never localStorage).
 * - Refresh token is an httpOnly cookie scoped to /api/v1/auth.
 * - Refresh calls are de-duplicated: the server rotates refresh tokens and treats a
 *   replayed token as theft, so two parallel refreshes would log the user out.
 */
export const API_BASE = "/api/v1";
export const isDemo = import.meta.env.VITE_DEMO_MODE === "true";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Real network in normal builds; the in-browser demo server in the GitHub Pages build. */
async function transport(url: string, init: RequestInit): Promise<Response> {
  if (isDemo) {
    const { demoFetch } = await import("./demo/server");
    return demoFetch(url, init);
  }
  return fetch(url, init);
}

let accessToken: string | null = null;
let refreshInFlight: Promise<TokenResponse | null> | null = null;
let onSessionLost: (() => void) | null = null;

export const tokenStore = {
  set: (t: string | null) => { accessToken = t; },
  get: () => accessToken,
  onSessionLost: (cb: () => void) => { onSessionLost = cb; },
};

async function parse(res: Response) {
  if (res.status === 204) return null;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = body?.error;
    throw new ApiError(res.status, err?.code ?? "http_error", err?.message ?? res.statusText, err?.details);
  }
  return body;
}

export function refreshSession(): Promise<TokenResponse | null> {
  if (!refreshInFlight) {
    refreshInFlight = transport(`${API_BASE}/auth/refresh`, { method: "POST", credentials: "same-origin" })
      .then(async (res) => {
        if (!res.ok) return null;
        const data = (await res.json()) as TokenResponse;
        accessToken = data.access_token;
        return data;
      })
      .catch(() => null)
      .finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

/** Authenticated file download (CSV / JSON exports). Works against the demo server too. */
export async function apiDownload(path: string, fallbackName: string): Promise<void> {
  const headers = new Headers();
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  let res = await transport(`${API_BASE}${path}`, { headers, credentials: "same-origin" });
  if (res.status === 401 && (await refreshSession())) {
    headers.set("Authorization", `Bearer ${accessToken}`);
    res = await transport(`${API_BASE}${path}`, { headers, credentials: "same-origin" });
  }
  if (!res.ok) await parse(res);
  const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function api<T>(
  path: string,
  init: RequestInit & { json?: unknown; idempotencyKey?: string } = {},
  retry = true,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set("Content-Type", "application/json");
  if (init.idempotencyKey) headers.set("Idempotency-Key", init.idempotencyKey);
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  const res = await transport(`${API_BASE}${path}`, {
    ...init,
    headers,
    credentials: "same-origin",
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  if (res.status === 401 && retry && !path.startsWith("/auth/")) {
    const refreshed = await refreshSession();
    if (refreshed) return api<T>(path, init, false);
    accessToken = null;
    onSessionLost?.();
  }
  return parse(res) as Promise<T>;
}

// ---- Types mirrored from the backend schemas -------------------------------
export type Role = "admin" | "user";

export interface User {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  is_active: boolean;
  created_at: string;
  last_login_at: string | null;
  mfa_enabled?: boolean;
}

export interface MfaChallenge { mfa_required: true; mfa_token: string; expires_in: number }

export interface TokenResponse {
  access_token: string;
  token_type: "bearer";
  expires_in: number;
  user: User;
}

export interface TradingAccount {
  id: string;
  name: string;
  mode: "PAPER";
  base_currency: string;
  status: "ACTIVE" | "CLOSED";
  created_at: string;
  cash_balance: string;
  equity: string;
}

export interface BalanceLine { code: string; name: string; type: string; currency: string; balance: string }
export interface AccountBalances {
  trading_account_id: string;
  currency: string;
  cash: string;
  investments: string;
  equity: string;
  lines: BalanceLine[];
  ledger_balanced: boolean;
}

export interface LedgerEntry { ledger_code: string; direction: "DEBIT" | "CREDIT"; amount: string; currency: string }
export interface LedgerTransaction {
  id: string;
  type: string;
  description: string;
  created_at: string;
  created_by: string | null;
  entries: LedgerEntry[];
}

export interface Page<T> { items: T[]; total: number; limit: number; offset: number }

export interface AuditLog {
  id: number;
  occurred_at: string;
  actor_user_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  outcome: "success" | "failure";
  ip_address: string | null;
  request_id: string | null;
  details: Record<string, unknown>;
  hash: string;
}

export interface UserSettings { timezone: string; base_currency: string; theme: string; updated_at: string }

export interface SystemInfo {
  name: string;
  version: string;
  environment: string;
  trading_mode: "PAPER";
  live_trading_enabled: boolean;
  registration_open: boolean;
  supported_currencies: string[];
}

// ---- Market data (Phase 3) -------------------------------------------------
export type AssetClass = "CRYPTO" | "FX" | "STOCK" | "ETF";

export interface Instrument {
  symbol: string;
  slug: string;
  display_name: string;
  asset_class: AssetClass;
  instrument_type: "SPOT" | "SPOT_FX" | "SHARE" | "ETF";
  venue: string;
  market: "CRYPTO_24_7" | "FX_24_5" | "US_EQUITY" | "UK_EQUITY";
  base_currency: string;
  quote_currency: string;
  price_decimals: number;
  tick_size: string;
  lot_size: string;
}

export interface Quote {
  symbol: string;
  last: string;
  bid: string;
  ask: string;
  prev_close: string | null;
  change: string | null;
  change_pct: string | null;
  as_of: string;
  source: string;
  market_open: boolean;
  stale: boolean;
  tradable: boolean;
  age_seconds: number;
  // actual | estimated_spread | reference | simulated
  pricing?: string;
}

export interface InstrumentWithQuote { instrument: Instrument; quote: Quote | null }

export interface MarketStatus { market: string; label: string; is_open: boolean; next_change: string | null }

export interface MarketOverview {
  markets: MarketStatus[];
  groups: Record<AssetClass, InstrumentWithQuote[]>;
  data_mode: "synthetic" | "mixed" | "live";
  price_source_note?: string;
}

export interface Candle { open_time: string; open: string; high: string; low: string; close: string; volume: string }
type Line = (number | null)[];
export interface CandlesResponse {
  symbol: string;
  timeframe: string;
  source: string | null;
  candles: Candle[];
  indicators: Partial<{
    sma20: Line; sma50: Line; ema20: Line; ema50: Line; rsi14: Line;
    bb20: { upper: Line; middle: Line; lower: Line };
    macd: { macd: Line; signal: Line; histogram: Line };
  }>;
}

export interface Watchlist { id: string; name: string; items: InstrumentWithQuote[] }

// ---- Research (Phase 4) ------------------------------------------------------
export type DocType = "earnings" | "filing" | "central_bank" | "economic_data" | "news" | "analysis" | "other";

export interface ResearchDocument {
  id: string;
  title: string;
  source_name: string;
  source_url: string | null;
  doc_type: DocType;
  content_type: string;
  published_at: string | null;
  retrieved_at: string;
  word_count: number;
  page_count: number | null;
  symbols: string[];
  sentiment: number;
  is_sample: boolean;
}
export interface ResearchChunk { id: string; ordinal: number; text: string; page: number | null; paragraph: number; sentiment: number }
export interface ResearchDocumentDetail extends ResearchDocument { chunks: ResearchChunk[] }
export interface IngestResult { created: number; duplicates: number; documents: ResearchDocument[] }

export interface SearchHit {
  chunk_id: string; document: ResearchDocument; text: string; page: number | null;
  paragraph: number; score: number; stale: boolean;
}

export interface ReportClaim { statement: string; citations: number[]; quote: string; verified: boolean }
export interface ReportSource {
  n: number; document_id: string; chunk_id: string; title: string; source_name: string;
  source_url: string | null; doc_type: DocType; published_at: string | null; retrieved_at: string;
  page: number | null; paragraph: number; age_days: number | null; stale: boolean;
  stale_after_days: number; is_sample: boolean; relevance: number; sentiment: number; excerpt: string;
}
export interface ReportBody {
  question: string;
  generated_at: string;
  engine: string;
  insufficient_evidence: boolean;
  facts: ReportClaim[];
  interpretation: { text: string; basis: "system" | "model"; label: string } | null;
  contradictions: ReportClaim[];
  open_questions: string[];
  confidence: { score: number; label: "low" | "medium" | "high"; factors: Record<string, number>; method: string };
  sources: ReportSource[];
  validation: { claims_proposed: number; claims_verified: number; claims_rejected: number; rejected: { statement: string; reason: string }[] };
  warnings: string[];
  disclaimer: string;
}
export interface ReportSummary {
  id: string; question: string; symbols: string[]; engine: string; confidence: number;
  insufficient_evidence: boolean; created_at: string;
}
export interface ResearchReport extends ReportSummary { body: ReportBody; latency_ms: number }

export interface ResearchStatus {
  engine: "extractive" | "claude"; model: string | null; embedding_model: string;
  documents: number; chunks: number; url_ingestion_enabled: boolean;
  llm_key_configured?: boolean;
  llm_key_source?: "server_setting" | "environment" | "none";
}

// ---- AI agents (Phase 5) ----------------------------------------------------------
export interface AIAgent { name: string; display_name: string; role: string; kind: "directional" | "gate"; weight: number; enabled: boolean; version: string }
export interface AgentEvidence { label: string; value: string; detail: string }
export interface AgentFinding {
  agent: string; status: "ok" | "abstain" | "error"; direction: -1 | 0 | 1; score: number;
  confidence: number; summary: string; evidence: AgentEvidence[]; duration_ms: number;
}
export interface TradeProposal {
  id: string; run_id: string; account_id: string; symbol: string; direction: "BUY" | "SELL";
  strategy_id: string; entry_type: string; entry_price: string; stop_loss: string; take_profit: string;
  quantity: string; notional: string; risk_amount: string; account_currency: string; confidence: number;
  reward_risk: number; invalidation_conditions: string[]; risk_check_required: boolean;
  status: ProposalStatus; effective_status: ProposalStatus | "EXPIRED";
  expires_at: string; created_at: string; dismissed_at: string | null;
  decided_at?: string | null; decision_reason?: string | null; order_id?: string | null;
}
export type ProposalStatus = "PENDING_RISK_REVIEW" | "DISMISSED" | "EXECUTED" | "RISK_REJECTED";
export interface ProposalExecution { proposal: TradeProposal; order_id: string; order_status: OrderStatus; reason: string | null }
export interface RunSummary {
  id: string; symbol: string; decision: "BUY" | "NO_TRADE"; bias: "bullish" | "bearish" | "neutral";
  net_score: number; agreement: number; coverage: number; confidence: number; created_at: string; latency_ms: number;
}
export interface AgentRun extends RunSummary {
  account_id: string | null; reasons: string[]; weights: Record<string, number>; context: Record<string, unknown>;
  started_at: string; finished_at: string; findings: AgentFinding[]; proposal: TradeProposal | null;
}

// ---- Quantitative models (Phase 6) --------------------------------------------------
export interface MLAlgorithm { key: string; label: string; description: string; params: Record<string, unknown> }
export interface MLGate { name: string; passed: boolean; value: string; threshold: string }
export interface MLVersionSummary {
  id: string; model_id: string; symbol: string; version: number; status: "candidate" | "champion" | "retired";
  eligible: boolean; eligibility_note: string; data_source: string; trained_at: string; promoted_at: string | null;
  retired_at: string | null; n_samples: number;
  summary: { auc: number; brier: number; brier_climatology: number; net_return: number; sharpe: number; buy_hold_return: number; trades: number };
}
export interface MLModelSpec { id: string; name: string; symbol: string; timeframe: string; horizon: number; algorithm: string; created_at: string; versions: MLVersionSummary[] }
export interface MLEvaluation { id: string; kind: "walk_forward" | "drift_check"; status: string; metrics: Record<string, any>; created_at: string } // eslint-disable-line @typescript-eslint/no-explicit-any
export interface MLStrategyStats { net_return: number; sharpe: number; max_drawdown: number; trades: number; exposure: number; hit_rate: number; periods: number }
export interface MLOos {
  samples: number; accuracy: number; brier: number; brier_climatology: number; log_loss: number; auc: number; ece: number;
  base_rate: number; cost_per_side: number; threshold: number;
  strategy_net_return: number; strategy_sharpe: number; strategy_max_drawdown: number; strategy_trades: number;
  strategy_exposure: number; strategy_hit_rate: number; strategy_periods: number;
}
export interface MLVersionDetail extends MLVersionSummary {
  gates: MLGate[];
  metrics: {
    horizon: number;
    oos: MLOos;
    baselines: { buy_hold: MLStrategyStats; momentum: MLStrategyStats; climatology: { brier: number } };
    folds: { fold: number; train_size: number; test_size: number; test_from: string; test_to: string; brier: number; brier_climatology: number; net_return: number; buy_hold_return: number; beats_buy_hold: boolean }[];
    calibration: { bin: number; predicted: number; observed: number; count: number }[];
    curves: { times: string[]; model: number[]; buy_hold: number[]; momentum: number[] };
  };
  params: Record<string, unknown>; features: string[]; feature_importance: Record<string, number>;
  train_from: string; train_to: string; artifact_sha256: string;
  model: { name: string; algorithm: string; horizon: number; timeframe: string };
  evaluations: MLEvaluation[];
}

// ---- Backtesting (Phase 7) ---------------------------------------------------------
export interface StrategyInfo { key: string; name: string; description: string; defaults: Record<string, number>; params: Record<string, { type: "int" | "float"; min: number; max: number }>; grid_size: number }
export interface BtMetrics {
  total_return: number; cagr: number; volatility: number; sharpe: number; sortino: number; max_drawdown: number; calmar: number;
  trades: number; win_rate: number; profit_factor: number | null; avg_win: number; avg_loss: number; avg_bars_held: number;
  exposure: number; turnover: number; fees: number; slippage_and_spread: number; halted: boolean; risk_events: number; bars: number;
}
export interface BtTrade { entry_time: string; exit_time: string | null; entry_price: number; exit_price: number | null; qty: number; pnl: number; return: number | null; fees: number; exit_reason: string; bars_held: number | null }
export interface BacktestSummary { id: string; strategy_key: string; symbol: string; days: number; params: Record<string, number>; data_source: string; oos_sharpe: number; oos_return: number; created_at: string; latency_ms: number }
export interface BacktestRun extends BacktestSummary {
  timeframe: string; period_from: string; period_to: string;
  config: { costs: Record<string, number>; risk: Record<string, number>; capital: number; optimise: boolean; asset_class: string };
  result: {
    params: Record<string, number>; optimised: boolean; split_time: string;
    in_sample: { strategy: BtMetrics; buy_hold: BtMetrics }; out_of_sample: { strategy: BtMetrics; buy_hold: BtMetrics }; full: BtMetrics;
    degradation: { sharpe: number; total_return: number };
    grid: { params: Record<string, number>; sharpe: number; total_return: number; max_drawdown: number; trades: number }[];
    warnings: string[]; curves: { strategy: [string, number][]; buy_hold: [string, number][] };
    trades: BtTrade[]; events: { time: string; type: string; detail: string }[];
  };
}

// ---- Paper execution (Phase 8) ---------------------------------------------
export type OrderSide = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT" | "STOP";
export type OrderStatus = "OPEN" | "FILLED" | "CANCELLED" | "REJECTED" | "EXPIRED";
export interface OrderInput {
  account_id: string; symbol: string; side: OrderSide; type: OrderType; quantity: string;
  limit_price?: string; stop_price?: string; time_in_force?: "GTC" | "DAY"; client_order_id?: string;
  stop_loss?: string; take_profit?: string;
}
export interface Order {
  id: string; account_id: string; symbol: string; side: OrderSide; type: OrderType; quantity: string;
  limit_price: string | null; stop_price: string | null; time_in_force: "GTC" | "DAY"; status: OrderStatus;
  filled_qty: string; avg_fill_price: string | null; client_order_id: string | null; source: string;
  reject_reason: string | null; expires_at: string | null; created_at: string; updated_at: string;
  stop_loss?: string | null; take_profit?: string | null; parent_order_id?: string | null; oco_group?: string | null;
  proposal_id?: string | null;
}
export interface RiskCheck { name: string; label: string; passed: boolean; value: string; limit: string; message: string }
export interface Execution {
  id: string; order_id: string; account_id: string; symbol: string; side: OrderSide; quantity: string; price: string;
  reference_price: string; mid_price: string; fx_rate: string; fee: string; spread_cost: string; slippage_cost: string;
  realised_pnl: string | null; ledger_transaction_id: string; executed_at: string;
}
export interface OrderDetail extends Order {
  events: { type: string; detail: Record<string, unknown>; created_at: string }[];
  executions: Execution[];
  risk_checks: RiskCheck[];
  children: Order[];
}
export interface Position {
  id: string; symbol: string; asset_class: AssetClass; quantity: string; avg_price: string; last: string; bid: string;
  quote_currency: string; fx_rate: string; cost_basis: string; market_value: string; unrealised_pnl: string;
  unrealised_pct: number; realised_pnl: string; fees: string; opened_at: string; price_as_of: string | null;
  stale: boolean; price_decimals: number;
}
export interface ClosedPosition { id: string; symbol: string; avg_price: string; realised_pnl: string; fees: string; opened_at: string; closed_at: string | null }
export interface PortfolioSummary {
  account_id: string; account_name: string; currency: string; cash: string; available_cash: string;
  investments_at_cost: string; market_value: string; equity: string; unrealised_pnl: string; realised_pnl: string;
  fees: string; exposure: number; open_positions: number; allocation: Record<string, number>; positions: Position[]; binary_at_risk?: string;
}
export interface PortfolioSnapshot { taken_at: string; cash: string; market_value: string; equity: string; reason: string }

// ---- Risk engine (Phase 9) ------------------------------------------------------
export interface RiskLimits {
  risk_per_trade_pct: number; max_position_pct: number; max_gross_exposure_pct: number; max_open_positions: number;
  daily_loss_limit_pct: number; max_drawdown_pct: number; max_orders_per_minute: number; price_collar_pct: number;
  binary_max_stake_pct: number; binary_max_open: number; binary_enabled?: boolean;
}
export interface SystemHalt { halted: boolean; reason: string | null; since: string | null }
export type AutopilotState = "STOPPED" | "RUNNING" | "PAUSED";
export interface RiskOverview {
  account_id: string; currency: string; limits: RiskLimits; defaults: RiskLimits; ceilings: RiskLimits;
  state: { kill_switch: boolean; kill_reason: string | null; kill_engaged_at: string | null; daily_halted: boolean;
    drawdown_halted: boolean; drawdown_halted_at: string | null; blocked_reason: string | null };
  metrics: { equity: string; pnl_equity: string; peak_pnl_equity: string | null; day_start_equity: string | null; daily_pnl: string;
    daily_loss_pct: number; drawdown_pct: number; exposure_pct: number; largest_position_pct: number; open_positions: number };
  autopilot: { status: AutopilotState; symbols: string[]; last_cycle_at: string | null; interval_seconds: number };
  system: SystemHalt;
}
export interface RiskDecision {
  id: string; order_id: string | null; proposal_id: string | null; source: string; symbol: string; side: OrderSide;
  approved: boolean; reason: string | null; checks: RiskCheck[]; created_at: string;
}
export interface RiskEvent { id: string; account_id: string | null; type: string; message: string; detail: Record<string, unknown>; created_at: string }
export interface AutopilotCycle {
  at: string; skipped?: string;
  results: { symbol: string; outcome: "executed" | "risk_rejected" | "no_trade" | "skipped" | "error"; detail?: string; run_id?: string; order_id?: string }[];
}

// ---- Analytics (Phase 10) ----------------------------------------------------------
export type AnalyticsPeriod = "7d" | "30d" | "90d" | "365d" | "all";
export interface PerfMetrics {
  periods: number; total_return: number; cagr: number | null; volatility: number | null; sharpe: number | null; sortino: number | null;
  max_drawdown: number; max_drawdown_days: number; calmar: number | null; best_day: number | null; worst_day: number | null; positive_days: number | null;
}
export interface Performance {
  period: AnalyticsPeriod; since: string; currency: string; metrics: PerfMetrics;
  curve: { t: string; equity: number }[];
  daily: { date: string; return: number; growth: number; flow: number; drawdown: number }[];
  benchmark: { symbol: string; available: boolean; return?: number; curve?: { date: string; growth: number }[] } | null;
  notes: string[];
}
export interface TradeStats {
  trades: number; wins: number; losses: number; win_rate: number | null; net_pnl: number; fees: number; profit_factor: number | null;
  avg_win: number; avg_loss: number; payoff_ratio: number | null; expectancy: number | null; best: number | null; worst: number | null;
  avg_hold_hours: number | null; return_on_cost: number | null; no_losses: boolean;
}
export interface GroupRow { key: string; trades: number; win_rate: number | null; net_pnl: number; profit_factor: number | null; expectancy: number | null }
export interface TradesReport {
  period: AnalyticsPeriod; since: string; currency: string; stats: TradeStats;
  by_symbol: GroupRow[]; by_asset_class: GroupRow[]; by_source: GroupRow[]; by_exit: GroupRow[];
  trades: { symbol: string; asset_class: string; source: string; exit: string; opened_at: string; closed_at: string; pnl: number; gross_pnl: number; fees: number; cost: number; hold_hours: number }[];
  open: { positions: number; unrealised_pnl: number };
}
export interface CostRow { key?: string; fills: number; notional: number; fees: number; spread: number; slippage: number; total_cost: number; cost_bps: number | null; fee_bps: number | null; spread_bps: number | null; slippage_bps: number | null }
export interface ExecutionReport {
  period: AnalyticsPeriod; currency: string; total: CostRow; by_asset_class: CostRow[];
  orders: { total: number; fill_rate: number | null; by_source: ({ source: string } & Record<string, number | string>)[] };
  rejections: { reason: string; count: number }[]; notes: string[];
}
export interface RiskReport {
  period: AnalyticsPeriod; decisions: number; approved: number; rejected: number;
  by_source: { source: string; approved: number; rejected: number }[]; failed_checks: { check: string; count: number }[];
  events: Record<string, number>; breaker_trips: { type: string; message: string; at: string }[];
}
export interface Calibration { n: number; brier: number | null; ece: number | null; bins: { lo: number; hi: number; n: number; confidence: number; hit_rate: number }[] }
export interface SignalStats { n: number; avg_forward_return: number | null; hit_rate: number | null }
export interface AIReport {
  period: AnalyticsPeriod; horizon_hours: number;
  proposals: { total: number; by_status: Record<string, number>; execution_rate: number | null };
  realised: { closed_trades: number; net_pnl: number; calibration: Calibration };
  signals: { runs: number; pending: number; buy: SignalStats; no_trade: SignalStats; edge: number | null; buy_calibration: Calibration };
  models: { symbol: string; version: number; eligible: boolean; note: string; last_drift_check: string | null; drift_status: string | null; max_psi: number | null }[];
  notes: string[];
}
export interface FullReport {
  report: string; version: number; generated_at: string; sha256: string; period: AnalyticsPeriod; disclaimer: string;
  account: { id: string; name: string; currency: string; mode: string; created_at: string; owner: string };
  snapshot: { cash: number; market_value: number; equity: number; unrealised_pnl: number; realised_pnl: number; fees: number; exposure: number; open_positions: number };
  integrity: { ledger_balanced: boolean; ledger_lines: Record<string, string> };
  performance: Omit<Performance, "curve">; trades: TradesReport; execution: ExecutionReport; risk: RiskReport; ai: AIReport;
}

// ---- Operations (Phase 12) ---------------------------------------------------------
export interface OpsGate { key: string; label: string; ok: boolean; detail: string }
export interface OpsStatus {
  version: string; environment: string; ready: boolean; checks: Record<string, string>;
  worker: { leader_instance: string | null; heartbeat_age_seconds: number | null; passes: number | null; last_error: string | null; this_process: string; this_process_is_leader: boolean };
  backup: { at?: string; file?: string; sha256?: string; size?: number; ok?: boolean; detail?: string; age_hours: number | null };
  restore_drill: { at?: string; file?: string; ok?: boolean; detail?: string; age_hours: number | null };
  anchoring: { sinks: string[]; last: null | { at: string; last_record_id: number; head_hash: string; records: number; sinks: { sink: string; ok: boolean; status?: number; error?: string }[]; age_hours: number | null } };
  gates: OpsGate[]; gates_met: number; gates_total: number; live_trading_enabled: boolean;
  users: { total: number; admins: number };
}
export interface IntegrityResult { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }

// --- binary options (paper) -----------------------------------------------------------------
export type BinaryDirection = "HIGHER" | "LOWER";
export type BinaryStatus = "OPEN" | "WON" | "LOST" | "TIE" | "VOID";
export interface BinaryConfig {
  paper_only: boolean; payout_rate: number; expiries: number[]; break_even_win_rate: number; coin_flip_expected_return: number;
  minimum_stake: string; void_after_seconds: number; notice: string;
}
export interface BinaryContract {
  id: string; account_id: string; symbol: string; direction: BinaryDirection; stake: string; currency: string;
  payout_rate: number; potential_return: string; strike: string; expiry_seconds: number; opened_at: string; expires_at: string;
  status: BinaryStatus; settle_price: string | null; settle_price_at: string | null; settled_at: string | null;
  returned: string | null; pnl: string | null; void_reason: string | null; client_id: string | null;
  price_source?: string; settle_source?: string;
}
export interface BinaryGroupStats {
  contracts: number; open: number; won: number; lost: number; ties: number; void: number; staked: string; net_pnl: string;
  win_rate: number | null; return_on_stake: number | null;
}
export interface BinaryStats extends BinaryGroupStats, Omit<BinaryConfig, "notice"> {
  account_id: string; currency: string; expected_return_at_win_rate: number | null; edge_vs_break_even: number | null;
  by_expiry: Record<string, BinaryGroupStats>; by_symbol: Record<string, BinaryGroupStats>; by_direction: Record<string, BinaryGroupStats>;
}
