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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
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
  if (req.method !== "GET") return json(req, { error: "method_not_allowed" }, 405);
  if (!userId(req)) return json(req, { error: "unauthenticated" }, 401);
  if (claims(req)?.aal !== "aal2") return json(req, { error: "mfa_required" }, 403);
  if (!(await roleOk(req))) return json(req, { error: "role_not_mapped" }, 403);
  if (!(await allow(req, "quote", 30))) return json(req, { error: "rate_limited" }, 429);

  const symbol = (new URL(req.url).searchParams.get("symbol") ?? "BTC-USD").toUpperCase();
  const instRes = await rest(req, "aurex_instruments", { query: `?select=*&symbol=eq.${symbol}` });
  if (instRes.error) return json(req, { error: instRes.error }, 500);
  const instrument = (instRes.data as any[])?.[0];
  if (!instrument) return json(req, { error: "unknown_instrument" }, 404);
  if (instrument.asset_class !== "CRYPTO") return json(req, { error: "live_feed_not_configured", instrument }, 422);

  try {
    const response = await fetch(`https://api.exchange.coinbase.com/products/${encodeURIComponent(symbol)}/ticker`, { headers: { "User-Agent": "aurex-phase2/1.0" } });
    if (!response.ok) return json(req, { error: "provider_unavailable", status: response.status }, 503);
    const price = Number((await response.json()).price);
    if (!Number.isFinite(price) || price <= 0) return json(req, { error: "bad_provider_price" }, 502);
    const captured_at = new Date().toISOString();
    const saved = await rest(req, "aurex_quotes", { method: "POST", body: { symbol, price, source: "Coinbase", captured_at } });
    if (saved.error) return json(req, { error: saved.error }, 500);
    return json(req, { symbol, name: instrument.name, price, price_decimals: instrument.price_decimals, source: "Coinbase", tradable: instrument.tradable, captured_at });
  } catch { return json(req, { error: "provider_unreachable" }, 503); }
});
