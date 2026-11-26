#!/usr/bin/env node
/**
 * Static parity check for the rules duplicated between the Python backend and the
 * browser-only demo. It reads both source trees and fails CI when a mirrored constant,
 * calendar date, cost, gate rule or safety boundary drifts apart.
 *
 * Run: node scripts/check-rule-parity.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const failures = [];
let groups = 0;

const norm = (v) => JSON.stringify(v);
function compare(name, backend, demo) {
  groups++;
  if (norm(backend) !== norm(demo)) {
    failures.push(`${name}\n    backend: ${norm(backend)}\n    demo:    ${norm(demo)}`);
  }
}
function requireSource(name, rel, re, description) {
  groups++;
  if (!re.test(read(rel))) failures.push(`${name}: ${description} (${rel})`);
}

/** Slice a balanced {...}, [...] or (...) that follows a pattern. */
function block(text, pattern) {
  const m = text.match(pattern);
  if (!m) throw new Error(`parity source not found: ${pattern}`);
  const start = m.index + m[0].length - 1;
  const pairs = { '{': '}', '[': ']', '(': ')' };
  const close = pairs[text[start]];
  if (!close) throw new Error(`parity pattern does not end with an opening bracket: ${pattern}`);
  let depth = 0, quote = null, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === text[start]) depth++;
    else if (c === close && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error(`unbalanced block: ${pattern}`);
}
function numericDict(source, key) {
  const out = {};
  for (const m of block(source, new RegExp(`${key}\\s*(?::[^=]+)?=\\s*\\{`))
    .matchAll(/["']?([A-Z][A-Z0-9_]*)["']?\s*:\s*(?:Decimal\()?(\d+(?:\.\d+)?)\)?/g)) {
    out[m[1]] = Number(m[2]);
  }
  return out;
}
function isoDates(source, pattern) {
  return [...block(source, pattern).matchAll(/"(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]).sort();
}
function numbers(list) { return [...list.matchAll(/\d+/g)].map((m) => Number(m[0])); }
function text(v) { return v.replace(/\s+/g, ' ').trim(); }

const calendarPy = read('backend/app/market/calendar.py');
const marketTs = read('frontend/src/services/demo/market.ts');
const riskPy = read('backend/app/risk/engine.py');
const riskTs = read('frontend/src/services/demo/risk.ts');
const costsPy = read('backend/app/backtest/engine.py');
const syntheticPy = read('backend/app/market/providers/synthetic.py');
const serverTs = read('frontend/src/services/demo/server.ts');
const configPy = read('backend/app/core/config.py');
const binaryApi = read('backend/app/api/v1/binary.py');
const binaryTs = serverTs;

// Calendar: full-day holidays and half-day closes must be identical in both builds.
compare('NYSE holidays', isoDates(calendarPy, /NYSE_HOLIDAYS\s*=\s*\{date\.fromisoformat\(d\) for d in \[/),
  isoDates(marketTs, /const NYSE = new Set\(\[/));
compare('LSE holidays', isoDates(calendarPy, /LSE_HOLIDAYS\s*=\s*\{date\.fromisoformat\(d\) for d in \[/),
  isoDates(marketTs, /const LSE = new Set\(\[/));
function earlyCloses(source, python) {
  const b = block(source, /EARLY_CLOSES(?::[^=]+)?=\s*\{/);
  const out = {};
  if (python) {
    for (const m of b.matchAll(/Market\.(US_EQUITY|UK_EQUITY):\s*\{([^}]*)\}/g)) {
      out[m[1]] = {};
      for (const d of m[2].matchAll(/date\((\d+),\s*(\d+),\s*(\d+)\):\s*time\((\d+)(?:,\s*(\d+))?\)/g)) {
        const day = `${d[1]}-${d[2].padStart(2, '0')}-${d[3].padStart(2, '0')}`;
        out[m[1]][day] = [Number(d[4]), Number(d[5] ?? 0)];
      }
    }
  } else {
    for (const m of b.matchAll(/(US_EQUITY|UK_EQUITY):\s*\{([^}]*)\}/g)) {
      out[m[1]] = {};
      for (const d of m[2].matchAll(/"(\d{4}-\d{2}-\d{2})":\s*\[(\d+),\s*(\d+)\]/g)) {
        out[m[1]][d[1]] = [Number(d[2]), Number(d[3])];
      }
    }
  }
  return out;
}
compare('early session closes', earlyCloses(calendarPy, true), earlyCloses(marketTs, false));

// Risk limits and assumed stops.
for (const key of ['DEFAULTS', 'CEILINGS', 'DEFAULT_STOP_PCT']) {
  compare(`risk ${key}`, numericDict(riskPy, key), numericDict(riskTs, `export const ${key}`));
}

// Execution costs: the demo uses the same fee/slippage as the live matcher, and the
// same synthetic quote spread as the backend generator.
const backendCosts = {};
for (const m of block(costsPy, /DEFAULT_COSTS\s*=\s*\{/)
  .matchAll(/"([A-Z]+)":\s*Costs\(fee_bps=([\d.]+),\s*half_spread_bps=([\d.]+),\s*slippage_bps=([\d.]+)\)/g)) {
  backendCosts[m[1]] = { fee_bps: Number(m[2]), slippage_bps: Number(m[4]) };
}
const demoCosts = {};
const fees = numericDict(serverTs, 'const FEE_BPS');
const slips = numericDict(serverTs, 'const SLIP_BPS');
for (const cls of Object.keys(fees)) demoCosts[cls] = { fee_bps: fees[cls], slippage_bps: slips[cls] };
compare('execution fees and slippage', backendCosts, demoCosts);

const backendSpread = {};
for (const m of block(syntheticPy, /SPREAD\s*=\s*\{/).matchAll(/AssetClass\.([A-Z]+):\s*([\d.]+)/g)) {
  backendSpread[m[1]] = Number(m[2]);
}
compare('synthetic quote spread', backendSpread, numericDict(marketTs, 'export const SPREAD'));

// Binary options: payout, expiries, minimum stake, void window and disclosure.
const pick = (source, re) => { const m = source.match(re); if (!m) throw new Error(`parity source not found: ${re}`); return m[1]; };
compare('binary payout', Number(pick(configPy, /binary_payout_rate:\s*float\s*=\s*([\d.]+)/)),
  Number(pick(binaryTs, /const BINARY_PAYOUT\s*=\s*([\d.]+)/)));
compare('binary expiries', numbers(pick(configPy, /binary_expiries[\s\S]*?default_factory=lambda:\s*\[([^\]]+)\]/)),
  numbers(pick(binaryTs, /\bBINARY_EXPIRIES\s*=\s*\[([^\]]+)\]/)));
compare('binary void window', pick(configPy, /binary_void_after_seconds:\s*int\s*=\s*(\d+)/),
  pick(binaryTs, /BINARY_VOID_AFTER_S\s*=\s*(\d+)/));
compare('minimum order/stake', pick(configPy, /min_order_value:\s*str\s*=\s*"([^"]+)"/),
  pick(binaryTs, /const MIN_ORDER_VALUE\s*=\s*(\d+)/));
compare('binary disclosure',
  text([...block(binaryApi, /NOTICE\s*=\s*\(/).matchAll(/"([^"]*)"/g)].map((m) => m[1]).join(' ')),
  text(pick(binaryTs, /const BINARY_NOTICE\s*=\s*"([^"]*)"/)));
requireSource('binary paper-only', 'backend/app/binary/service.py', /"paper_only": True/, 'config must declare paper_only = True');
requireSource('binary paper-only', 'frontend/src/services/demo/server.ts', /paper_only: true/, 'demo config must declare paper_only = true');

// Safety boundaries that must never become configuration switches.
requireSource('live trading', 'backend/app/core/config.py', /def live_trading_enabled[\s\S]*?return False/, 'live_trading_enabled must be hard-coded False');
requireSource('live trading', 'backend/app/core/config.py', /_reject_live_trading_override/, 'environment overrides must be rejected');
requireSource('live trading', 'backend/alembic/versions/0001_foundation.py', /mode = 'PAPER'/, 'database must reject non-PAPER accounts');
requireSource('live trading', 'frontend/src/services/demo/server.ts', /live_trading_enabled: false/, 'demo must report live trading off');
requireSource('live trading', 'edge-functions/health/index.ts', /live_trading_enabled: false/, 'edge health must report live trading off');
requireSource('live trading', 'edge-functions/health/index.ts', /paper_only: true/, 'edge health must report paper-only');
requireSource('admin MFA', 'backend/app/core/config.py', /self\.require_admin_mfa is False or not self\.admin_mfa_required/,
  'staging/production must reject AUREX_REQUIRE_ADMIN_MFA=false');
requireSource('admin MFA', 'frontend/src/live/main.tsx', /PAPER ONLY · MFA REQUIRED/, 'live build must show the MFA requirement');

// Go-live gates: the demo mirrors the backend's gate keys, even though most stay red there.
const statusPy = read('backend/app/ops/status.py');
function attestationKeys(source, python) {
  const b = block(source, /ATTESTABLE\s*(?::[^=]+)?=\s*\{/);
  return [...b.matchAll(python ? /"([a-z_]+)":\s*"/g : /^\s*([a-z_]+):\s*"/gm)].map((m) => m[1]).sort();
}
compare('go-live attestation keys', attestationKeys(statusPy, true), attestationKeys(serverTs, false));
for (const key of ['offsite_backups', 'offsite_anchors']) {
  requireSource('off-site gates', 'backend/app/ops/status.py', new RegExp(`gate\\("${key}"`), `missing ${key} gate`);
  requireSource('off-site gates', 'frontend/src/services/demo/server.ts', new RegExp(`g\\("${key}"`), `demo missing ${key} gate`);
}

// Soft launch: both surfaces expose the same paper-only status, feedback loop and banner.
for (const [name, file, re] of [
  ['public status', 'backend/app/api/v1/system.py', /async def public_status/],
  ['public status', 'frontend/src/services/demo/server.ts', /\^\\\/system\\\/status\$/],
  ['feedback loop', 'backend/app/api/v1/feedback.py', /async def submit_feedback/],
  ['feedback loop', 'frontend/src/services/demo/server.ts', /\^\\\/feedback\$/],
  ['paper banner', 'frontend/src/components/layout/PaperTradingBanner.tsx', /PAPER TRADING ONLY/i],
  ['paper banner', 'frontend/src/live/main.tsx', /PAPER TRADING ONLY/],
]) requireSource(name, file, re, 'soft-launch surface is missing');

if (failures.length) {
  console.error(`Rule parity FAILED (${failures.length} of ${groups} groups):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`Rule parity OK — ${groups} rule groups match across backend and demo.`);
