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
async function allow(req: Request, name: string, limit: number, window = 60) {
  const ip = (req.headers.get("x-forwarded-for") ?? "anon").split(",")[0]?.trim() || "anon";
  try {
    const res = await fetch(`${API}/rest/v1/rpc/aurex_rate_limit`, {
      method: "POST",
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_key: `${name}:${ip}:${Math.floor(Date.now() / 60000)}`, p_limit: limit, p_window_seconds: window }),
    });
    return res.ok ? (await res.json()) === true : true;
  } catch { return true; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "GET") return json(req, { error: "method_not_allowed" }, 405);
  if (!(await allow(req, "health", 60))) return json(req, { error: "rate_limited" }, 429);

  let database = "unknown";
  try {
    const r = await fetch(`${API}/rest/v1/aurex_instruments?select=symbol&limit=1`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
    database = r.ok ? "ok" : `http_${r.status}`;
  } catch { database = "unreachable"; }

  return json(req, {
    name: "AUREX Edge API",
    version: "phase-2.0",
    environment: ENV,
    paper_only: true,
    live_trading_enabled: false,
    guards: {
      https_required: true,
      cors_allowlist: ORIGINS,
      jwt_verified_by: "supabase_auth",
      mfa_aal2_required: true,
      role_mapping: "aurex.profiles.role",
      secrets: "supabase_secrets",
    },
    rate_limits: "shared-postgres",
    database,
    time: new Date().toISOString(),
  });
});
