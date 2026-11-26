import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

/**
 * Two explicitly separate builds:
 *  - `demo`: index.html only, simulated in-browser data, GitHub Pages root.
 *  - `live`: live.html only, real Supabase Edge API via build-time VITE_* values.
 * GitHub Pages cannot send response headers, so both carry a CSP <meta> tag.
 * `frame-ancestors` and HSTS still require a real server in the full deployment.
 */
function csp(isLive: boolean, supabaseOrigin: string): string {
  const connect = isLive ? `'self' ${supabaseOrigin} https://*.supabase.co` : "'self'";
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const target = env.VITE_BUILD_TARGET ?? "all";
  let supabaseOrigin = "https://*.supabase.co";
  try {
    if (env.VITE_SUPABASE_URL) supabaseOrigin = new URL(env.VITE_SUPABASE_URL).origin;
  } catch {
    // The live-env guard below produces the actionable error during a live build.
  }

  const securityMeta = (): Plugin => ({
    name: "aurex-security-meta",
    enforce: "pre",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const isLive = target === "live" || ctx.path.includes("live.html");
        const cspTag = `<meta http-equiv="Content-Security-Policy" content="${csp(isLive, supabaseOrigin)}" />`;
        const referrerTag = `<meta name="referrer" content="no-referrer" />`;
        let out = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i, cspTag)
          .replace(/<meta name="referrer"[^>]*>/i, referrerTag);
        if (!out.includes('http-equiv="Content-Security-Policy"') || !out.includes('name="referrer"')) {
          out = out.replace('<meta charset="UTF-8" />',
            `<meta charset="UTF-8" />\n    ${cspTag}\n    ${referrerTag}`);
        }
        return out;
      },
    },
  });

  const liveEnvGuard = (): Plugin => ({
    name: "aurex-live-env-guard",
    apply: "build",
    buildStart() {
      if (target !== "live") return;
      const missing = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"].filter((k) => !env[k]);
      if (missing.length) throw new Error(`Live build needs ${missing.join(", ")} (use .env.local or CI secrets).`);
    },
  });

  const inputs = target === "demo"
    ? { main: fileURLToPath(new URL("./index.html", import.meta.url)) }
    : target === "live"
      ? { live: fileURLToPath(new URL("./live.html", import.meta.url)) }
      : {
          main: fileURLToPath(new URL("./index.html", import.meta.url)),
          live: fileURLToPath(new URL("./live.html", import.meta.url)),
        };

  return {
    base: env.VITE_BASE ?? "/",
    plugins: [react(), tailwindcss(), securityMeta(), liveEnvGuard()],
    build: {
      assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
      rollupOptions: {
        input: inputs,
        output: {
          // Keep route code, charts and vendor SDKs out of the initial shell chunk.
          manualChunks(id) {
            if (!id.includes("node_modules")) return;
            if (id.includes("lightweight-charts")) return "charts";
            if (id.includes("@supabase")) return "supabase";
            if (id.includes("@tanstack")) return "query";
            if (id.includes("lucide-react")) return "icons";
            if (/[\\/]react(?:-dom|-router)?[\\/]/.test(id) || id.includes("scheduler")) return "react";
          },
        },
      },
    },
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    server: {
      port: 5173,
      host: true,
      proxy: { "/api": { target: process.env.AUREX_API_URL ?? "http://localhost:8000", changeOrigin: false, ws: true } },
    },
    // E2E runs against the built bundle, not the dev server, so preview needs the same
    // API/WebSocket proxy as `server`. It is not exposed publicly in any deployment.
    preview: {
      port: 4173,
      host: true,
      proxy: { "/api": { target: process.env.AUREX_API_URL ?? "http://localhost:8000", changeOrigin: false, ws: true } },
    },
  };
});
