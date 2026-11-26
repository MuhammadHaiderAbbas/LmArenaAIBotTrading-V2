import { defineConfig, devices } from "@playwright/test";

// Expects the API on :8000 (migrated DB). Local runs serve the built bundle with
// `vite preview`; set AUREX_WEB_URL to run the same specs against a deployed build.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  use: { baseURL: process.env.AUREX_WEB_URL ?? "http://localhost:4173", trace: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.AUREX_WEB_URL
    ? undefined
    : { command: "npm run preview -- --port 4173", url: "http://localhost:4173", reuseExistingServer: true, timeout: 60_000 },
});
