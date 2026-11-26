const API = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const ORIGINS = (Deno.env.get("AUREX_CORS_ORIGINS") ?? "https://muhammadhaiderabbas.github.io")
  .split(",").map((s) => s.trim()).filter(Boolean);
const ENV = Deno.env.get("AUREX_ENVIRONMENT") ?? "development";
const devOrigin = (o: string) => ENV !== "production" && (o.startsWith("http://localhost:") || o.startsWith("http://127.0.0.1:"));
function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
  if (ORIGINS.includes(origin) || devOrigin(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "content-type": "application/json", "cache-control": "no-store", ...(status === 429 ? { "Retry-After": "60" } : {}) },
  });
}
function guard(req: Request): Response | null {
  const origin = req.headers.get("origin") ?? "";
  if (origin && !ORIGINS.includes(origin) && !devOrigin(origin)) return json(req, { error: "origin_not_allowed" }, 403);
  const u = new URL(req.url);
  const forwarded = req.headers.get("x-forwarded-proto");
  const secure = forwarded === "https" || u.protocol === "https:" || u.hostname.endsWith(".supabase.co") || ["localhost", "127.0.0.1"].includes(u.hostname);
  if (!secure) return json(req, { error: "https_required" }, 403);
  return null;
}
function claims(req: Request): any {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const part = header.slice(7).split(".")[1];
  if (!part) return null;
  try { return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))); } catch { return null; }
}
function userId(req: Request): string | null { const c = claims(req); return typeof c?.sub === "string" ? c.sub : null; }
async function rest(req: Request, table: string, opts: { method?: string; query?: string; body?: unknown; prefer?: string } = {}) {
  const res = await fetch(`${API}/rest/v1/${table}${opts.query ?? ""}`, {
    method: opts.method ?? "GET",
    headers: { apikey: KEY, Authorization: req.headers.get("authorization") ?? `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: opts.prefer ?? "return=representation" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!res.ok) return { data: null, error: (payload && payload.message) || `http_${res.status}` };
  return { data: payload, error: null };
}
async function allow(req: Request, name: string, limit: number, window = 60) {
  const uid = userId(req) ?? "anon";
  try {
    const res = await fetch(`${API}/rest/v1/rpc/aurex_rate_limit`, {
      method: "POST",
      headers: { apikey: KEY, Authorization: req.headers.get("authorization") ?? `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_key: `${name}:${uid}:${Math.floor(Date.now() / 60000)}`, p_limit: limit, p_window_seconds: window }),
    });
    return res.ok ? (await res.json()) === true : true;
  } catch { return true; }
}
async function roleOk(req: Request): Promise<boolean> {
  try {
    const res = await fetch(`${API}/rest/v1/rpc/aurex_current_role`, {
      method: "POST",
      headers: { apikey: KEY, Authorization: req.headers.get("authorization") ?? `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok) return false;
    const role = await res.json();
    return role === "user" || role === "admin";
  } catch { return false; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  const blocked = guard(req); if (blocked) return blocked;
  const uid = userId(req);
  if (!uid) return json(req, { error: "unauthenticated" }, 401);
  if (claims(req)?.aal !== "aal2") return json(req, { error: "mfa_required" }, 403);
  if (!(await roleOk(req))) return json(req, { error: "role_not_mapped" }, 403);
  const limit = req.method === "POST" ? 10 : 60;
  if (!(await allow(req, `accounts:${req.method}`, limit))) return json(req, { error: "rate_limited" }, 429);

  if (req.method === "GET") {
    const { data, error } = await rest(req, "aurex_account_balances", { query: `?select=account_id,currency,balance&owner_id=eq.${uid}&order=account_id.asc` });
    if (error) return json(req, { error }, 500);
    return json(req, { accounts: data ?? [] });
  }
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const name = String(body.name ?? "Demo paper").trim().slice(0, 80);
    const currency = ["GBP", "USD", "EUR"].includes(String(body.currency)) ? String(body.currency) : "GBP";
    const starting = Number(body.starting_balance ?? 100);
    if (!Number.isFinite(starting) || starting <= 0 || starting > 10_000_000) return json(req, { error: "invalid_starting_balance" }, 422);

    const created = await rest(req, "aurex_paper_accounts", { method: "POST", query: "?select=*", body: { owner_id: uid, name, currency, status: "ACTIVE" } });
    if (created.error) return json(req, { error: created.error }, 500);
    const acct = (created.data as any[])?.[0];
    if (!acct) return json(req, { error: "create_failed" }, 500);

    const legs = await rest(req, "aurex_ledger_accounts", { method: "POST", body: [{ account_id: acct.id, code: "CASH" }, { account_id: acct.id, code: "EQUITY" }] });
    if (legs.error) return json(req, { error: legs.error }, 500);
    const cash = ((await rest(req, "aurex_ledger_accounts", { query: `?select=id&account_id=eq.${acct.id}&code=eq.CASH` })).data as any[])?.[0];
    const equity = ((await rest(req, "aurex_ledger_accounts", { query: `?select=id&account_id=eq.${acct.id}&code=eq.EQUITY` })).data as any[])?.[0];

    if (cash && equity) {
      const txRes = await rest(req, "aurex_ledger_transactions", { method: "POST", query: "?select=*", body: { account_id: acct.id, kind: "DEPOSIT", amount: starting, created_by: uid } });
      if (txRes.error) return json(req, { error: txRes.error }, 500);
      const tx = (txRes.data as any[])?.[0];
      const entries = await rest(req, "aurex_ledger_entries", { method: "POST", body: [
        { transaction_id: tx.id, ledger_account_id: cash.id, side: "D", amount: starting },
        { transaction_id: tx.id, ledger_account_id: equity.id, side: "C", amount: starting },
      ] });
      if (entries.error) return json(req, { error: entries.error }, 500);
    }
    await rest(req, "aurex_audit_logs", { method: "POST", body: { actor_id: uid, action: "account.create", details: { account_id: acct.id, currency, starting_balance: starting } } });
    return json(req, { account: { ...acct, balance: starting } }, 201);
  }
  return json(req, { error: "method_not_allowed" }, 405);
});
