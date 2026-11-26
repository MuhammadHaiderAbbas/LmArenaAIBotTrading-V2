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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  const blocked = guard(req); if (blocked) return blocked;
  const uid = userId(req);
  if (!uid) return json(req, { error: "unauthenticated" }, 401);
  if (claims(req)?.aal !== "aal2") return json(req, { error: "mfa_required" }, 403);
  if (!(await allow(req, "profile", 20))) return json(req, { error: "rate_limited" }, 429);

  if (req.method === "GET") {
    const { data, error } = await rest(req, "aurex_profiles", { query: `?select=*&id=eq.${uid}` });
    if (error) return json(req, { error }, 500);
    return json(req, { profile: (data as any[])?.[0] ?? null });
  }
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const fullName = String(body.full_name ?? "").trim().slice(0, 120);
    if (fullName.length < 2) return json(req, { error: "full_name_too_short" }, 422);
    const { data, error } = await rest(req, "aurex_profiles", {
      method: "POST", query: "?select=*", prefer: "resolution=merge-duplicates,return=representation",
      body: { id: uid, full_name: fullName, role: "user" },
    });
    if (error) return json(req, { error }, 500);
    await rest(req, "aurex_audit_logs", { method: "POST", body: { actor_id: uid, action: "profile.upsert", details: { full_name: fullName } } });
    return json(req, { profile: (data as any[])?.[0] ?? null }, 201);
  }
  return json(req, { error: "method_not_allowed" }, 405);
});
