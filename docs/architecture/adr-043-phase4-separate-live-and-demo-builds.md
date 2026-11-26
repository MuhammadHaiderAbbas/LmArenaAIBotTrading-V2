# ADR-043 — Phase 4: separate live and simulated builds

Date: 2026-11-25
Status: Accepted. Builds verified locally; Pages deployment requires repository secrets and a push.

## Context

The GitHub Pages site used one Vite build with two entry points: `index.html` (the in-browser simulated demo) and `live.html` (real Supabase Edge API). That made it easy to mistake simulated numbers for production data, and every page/chart was bundled into one large shell chunk. GitHub Pages cannot set security response headers, so the CSP has to live in the HTML.

## Decision

1. **Two explicit build targets.** `VITE_BUILD_TARGET=demo` builds only `index.html`; `VITE_BUILD_TARGET=live` builds only `live.html`. `build:pages` produces one Pages artifact with the demo at `/<repo>/` and the live app at `/<repo>/live/`.
2. **Live requires real configuration.** The live build reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (publishable key) at build time. A Vite plugin fails the build if either is absent, and the app renders a clear setup message as defence in depth. No secret/service-role values are ever accepted.
3. **Clear labelling.** Demo build: title `Public Demo (Simulated Data)`, persistent `SIMULATED DATA` banner in the app shell, existing `Synthetic data` badge on Markets, and a callout linking to the live build. Live build: `REAL API`, `LIVE COINBASE DATA`, `PAPER ONLY`, and a link back to the simulated demo. Both use virtual capital only.
4. **CSP meta on both surfaces.** A Vite plugin injects a `Content-Security-Policy` meta tag and `referrer no-referrer` into both HTML files. The demo allows only `'self'` connections; the live build adds the configured Supabase origin and `https://*.supabase.co`. `frame-ancestors`/HSTS remain server-header concerns and are documented as such.
5. **Route-level and vendor code splitting.** All pages are `React.lazy` imports behind one `Suspense` boundary. Rollup `manualChunks` separates charts, Supabase, TanStack Query, React and icons. The previous ~751 kB combined shell is now a 20.71 kB demo shell / 11.55 kB live shell plus lazily loaded routes and vendor chunks; no chunk exceeds Vite's 500 kB warning threshold.
6. **Cold-start messaging.** Live API 5xx responses and network failures show a friendly "may be waking after a free-tier pause — retry shortly" message instead of a raw error.

## Verification

- `npm run typecheck` passed.
- `npm run build` passed with no chunk-size warning.
- Pages-shaped demo build (`VITE_BASE=/AUREX-AI-Foundation/`) passed; largest chunks: React 249.87 kB, Supabase 202.92 kB, charts 165.03 kB, demo server 154.69 kB — all separate from the 20.71 kB entry.
- Pages-shaped live build passed; live entry 11.55 kB, React 218.77 kB, Supabase 202.92 kB, charts 149.82 kB.
- A build with the Supabase env files removed failed with the expected actionable error.
- Both built HTML files contain the CSP meta and referrer policy; the live bundle contains the configured API URL, checked without printing values.
- Static demo Playwright suite: `1 passed (15.9s)`, including the new SIMULATED DATA banner assertion.
- Headless live-page smoke: sign-in screen renders with REAL API visible, no "not configured" state, CSP present, zero console/page errors.

## Consequences

- Visitors get two unmistakable URLs: demo at the Pages root, live at `/live/`. The live app is paper trading against real market data, not a simulated ledger.
- CI must set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as repository secrets for the live build; otherwise `pages.yml` fails intentionally.
- Route chunks are fetched on navigation, so the first visit to a heavy page has a small loading state (the shared `Suspense` spinner).
- No GitHub push was made; deployment happens when the owner approves a push to `main`.
