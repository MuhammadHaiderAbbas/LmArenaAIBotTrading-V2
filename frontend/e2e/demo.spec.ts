import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";

// Runs against the static GitHub Pages build (VITE_DEMO_MODE=true). Set AUREX_E2E_DEMO=1.
test.skip(!process.env.AUREX_E2E_DEMO, "demo build only");

test("static demo: launch, markets, wallet, admin, deep links", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("login");
  await expect(page.getByText("Public demo.")).toBeVisible();
  await page.getByRole("button", { name: "Launch demo", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Demo Trader" })).toBeVisible();
  await expect(page.getByTestId("demo-banner")).toContainText("SIMULATED DATA");
  await expect(page.getByTestId("paper-trading-banner")).toContainText(/paper trading only/i);
  await page.getByRole("link", { name: "Status", exact: true }).click();
  await expect(page.getByTestId("public-status-state")).toContainText("Operational");
  await expect(page.getByTestId("public-announcements")).toContainText("Paper trading only");
  await page.getByRole("link", { name: "Send feedback" }).click();
  await page.getByLabel("Feedback message").fill("Soft launch feedback from the demo E2E run.");
  await page.getByRole("button", { name: "Send feedback" }).click();
  await expect(page.getByTestId("feedback-thanks")).toBeVisible();
  await page.goto("");
  await expect(page.getByRole("link", { name: "Demo paper account" })).toBeVisible();
  await expect(page.getByText("US$100,000.00").first()).toBeVisible();
  await expect(page.getByTestId("live-status")).toContainText(/Live · polling/i);

  // Markets: synthetic data clearly labelled, chart renders, indicators toggle
  await page.getByRole("link", { name: "Markets", exact: true }).click();
  await expect(page.getByText("Synthetic data")).toBeVisible();
  await expect(page.getByTestId("price-chart").locator("canvas").first()).toBeVisible();
  await page.getByRole("tab", { name: "Forex" }).click();
  await page.getByRole("button", { name: /^GBP\/USD British/ }).click();
  await expect(page).toHaveURL(/symbol=GBPUSD/);
  await page.getByRole("button", { name: "1d" }).click();
  await expect(page.getByText(/\d+ candles · source Synthetic/)).toBeVisible();

  // Wallet: double-entry ledger in the browser
  await page.getByRole("link", { name: "Wallet", exact: true }).click();
  await expect(page.getByText("Ledger balanced (debits = credits)")).toBeVisible();
  await page.getByLabel("Amount (USD)").fill("250");
  await page.getByRole("button", { name: "Deposit virtual cash" }).click();
  await expect(page.getByText("Deposited US$250.00")).toBeVisible();

  // First demo user is admin: audit chain verifies
  await page.getByRole("link", { name: "Administration" }).click();
  await page.getByRole("button", { name: "Verify chain" }).click();
  await expect(page.getByText(/Chain intact — \d+ records verified/)).toBeVisible();
  const auditDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export" }).click();
  expect((await auditDownload).suggestedFilename()).toMatch(/^aurex-audit-.*\.jsonl$/);
  await page.getByRole("link", { name: "Operations" }).click();
  await expect(page.getByTestId("ops-ready")).toContainText("Live trading disabled");
  await expect(page.getByTestId("ops-gates")).toContainText(/UK solicitor/);
  await expect(page.getByTestId("ops-gates")).toContainText(/DPIA/);
  await expect(page.getByTestId("ops-gates")).toContainText(/off-site backup/i);
  await expect(page.getByRole("textbox", { name: "Evidence SHA-256" })).toBeVisible();
  await page.getByRole("button", { name: "Anchor now" }).click();
  await expect(page.getByTestId("ops-anchoring")).toContainText("covers record");
  await page.getByRole("button", { name: "Run integrity check" }).click();
  await expect(page.getByTestId("integrity-result")).toContainText("anchors_match_chain");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByTestId("sessions")).toContainText("This session");

  // Research Lab: the demo user starts with the fictional sample corpus
  await page.getByRole("link", { name: "AI Research Lab" }).click();
  await page.getByRole("button", { name: /outlook for Northwind/ }).click();
  await expect(page.getByText("Verified facts")).toBeVisible();
  await expect(page.getByText("Contradictory evidence")).toBeVisible();
  await expect(page.getByText("Cites the fictional sample corpus; not real market information.")).toBeVisible();
  await page.getByRole("tab", { name: "Corpus" }).click();
  await page.getByRole("button", { name: "Add document" }).click();
  await page.getByLabel("Title").fill("Desk memo on GBP/USD");
  await page.getByLabel("Text", { exact: true }).fill("Sterling weakened after softer inflation data, and traders now expect GBP/USD volatility to stay elevated.");
  await page.getByLabel("Source").fill("Demo desk");
  await page.locator("dialog").getByRole("button", { name: "Index document" }).click();
  await expect(page.getByText(/Indexed “Desk memo on GBP\/USD”/)).toBeVisible();
  await page.locator("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("cell", { name: /^Desk memo on GBP\/USD Demo desk/ })).toBeVisible();

  // Agent department in the browser: run, explained decision, all eight agents
  await page.getByRole("link", { name: "AI Trading" }).click();
  await page.getByLabel("Instrument").selectOption("EUR/USD");
  await page.getByRole("button", { name: "Run analysis" }).click();
  await expect(page.getByTestId("decision")).toHaveText(/BUY|NO TRADE/);
  for (const a of ["technical", "quant", "regime", "news", "portfolio", "risk"]) await expect(page.getByTestId(`agent-${a}`)).toBeVisible();
  await expect(page.getByTestId("agent-news")).not.toContainText("Error");

  // Model Lab in the browser: logistic regression with walk-forward validation
  await page.getByRole("link", { name: "Model Lab" }).click();
  await page.getByLabel("Instrument").selectOption("EUR/USD");
  await expect(page.getByLabel("Algorithm").locator("option")).toHaveCount(1);  // demo is logistic-only
  await page.getByLabel("Algorithm").selectOption("logistic");
  await expect(page.getByText(/random forest and LightGBM need the AUREX backend/)).toBeVisible();
  await page.getByLabel("History").selectOption("60");
  await page.getByRole("button", { name: "Train & validate" }).click();
  await expect(page.getByTestId("gates")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("gates")).toContainText("Plausible performance");
  await expect(page.getByRole("button", { name: "Promote" })).toBeDisabled();
  await page.getByRole("button", { name: "Drift check" }).click();
  await expect(page.getByText(/max PSI/)).toBeVisible();

  // Backtesting in the browser
  await page.getByRole("link", { name: "Backtesting" }).click();
  await page.getByLabel("Strategy").selectOption("donchian_breakout");
  await page.getByLabel("Instrument").selectOption("BTC-USD");
  await page.getByLabel("Period").selectOption("90");
  await page.getByRole("button", { name: "Run backtest" }).click();
  await expect(page.getByTestId("metrics-table")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("oos-headline")).toContainText("Sharpe");

  // Paper execution and the risk engine in the browser
  await tradeFlow(page);
  await riskFlow(page);
  await analyticsFlow(page);

  // A £100 GBP account alongside the $100k demo account, then paper binary options on it
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "New paper account" }).click();
  await page.getByLabel("Account name").fill("Small paper");
  await page.locator("dialog").getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("link", { name: "Small paper" })).toBeVisible();
  await binaryFlow(page, "Small paper · GBP");
  // Platform kill switch (demo user is the administrator)
  await page.getByRole("link", { name: "Administration" }).click();
  await page.getByLabel("Halt reason").fill("demo drill");
  await page.getByRole("button", { name: "Halt all trading" }).click();
  await expect(page.getByText("Trading halted")).toBeVisible();
  await page.getByRole("button", { name: "Resume trading" }).click();
  await expect(page.getByText("Risk gate on")).toBeVisible();

  // Two-factor authentication in the browser (Launch demo then asks for a code)
  await mfaFlow(page, "Demo-Account-2026!", async () => {
    await page.getByRole("button", { name: "Launch demo", exact: true }).click();
  });

  // Deep link + reload survives (SPA fallback + persisted session)
  await page.goto("markets?symbol=AAPL");
  await expect(page.getByText("Apple Inc.").first()).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("price-chart")).toBeVisible();

  expect(errors).toEqual([]);
});

// Shared with the static demo spec (kept in sync manually: Playwright specs don't share imports here).
async function tradeFlow(page: import("@playwright/test").Page) {
  await page.goto("markets?symbol=BTC-USD");
  await page.getByRole("button", { name: "Buy", exact: true }).click();
  const dialog = page.locator("dialog");
  await expect(dialog.getByText("Tradable")).toBeVisible();
  await dialog.getByLabel("Quantity").fill("0.05");
  await dialog.getByRole("button", { name: "Place paper buy order" }).click();
  await expect(page.getByTestId("order-result")).toContainText("Filled 0.05 BTC-USD");
  // A resting limit far below the market
  await dialog.getByRole("button", { name: "New order" }).click();
  await dialog.getByLabel("Order type").selectOption("LIMIT");
  await dialog.getByLabel("Quantity").fill("0.01");
  await dialog.getByLabel("Limit price").fill("1000.00");
  await dialog.getByRole("button", { name: "Place paper buy order" }).click();
  await expect(page.getByTestId("order-result")).toContainText("LIMIT order working");
  // Oversized order is rejected with a reason (no leverage)
  await dialog.getByRole("button", { name: "New order" }).click();
  await dialog.getByLabel("Quantity").fill("100");
  await dialog.getByRole("button", { name: "Place paper buy order" }).click();
  await expect(page.getByTestId("order-result")).toContainText("insufficient cash");
  await dialog.getByRole("button", { name: "Close dialog" }).click();

  await page.getByRole("link", { name: "Portfolio", exact: true }).click();
  await expect(page.getByRole("cell", { name: /^BTC-USD/ })).toBeVisible();
  await expect(page.getByText("1 of 5 positions")).toBeVisible();

  await page.getByRole("link", { name: "Trade History", exact: true }).click();
  await page.getByRole("button", { name: "Cancel order BTC-USD" }).click();
  await expect(page.getByRole("button", { name: "Cancel order BTC-USD" })).toHaveCount(0);
  await page.getByRole("button", { name: "Rejected", exact: true }).click();
  await page.getByRole("cell", { name: "REJECTED" }).first().click();
  await expect(page.getByTestId("order-timeline")).toContainText("insufficient cash");

  await page.getByRole("link", { name: "Portfolio", exact: true }).click();
  await page.getByRole("button", { name: "Close BTC-USD" }).click();
  await expect(dialog.getByLabel("Quantity")).toHaveValue("0.05");
  await dialog.getByRole("button", { name: "Place paper sell order" }).click();
  await expect(page.getByTestId("order-result")).toContainText("Filled 0.05 BTC-USD");
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByText("No open positions")).toBeVisible();
  await expect(page.getByText("Closed positions")).toBeVisible();

  await page.getByRole("link", { name: "Wallet", exact: true }).click();
  await expect(page.getByText("Ledger balanced (debits = credits)")).toBeVisible();
  await expect(page.getByText("Trade · sell")).toBeVisible();
  await expect(page.getByText(/^Sell 0.05 BTC-USD @/)).toBeVisible();
}

// Shared with the static demo spec (kept in sync manually).
async function riskFlow(page: import("@playwright/test").Page) {
  await page.goto("risk");
  await expect(page.getByTestId("risk-status")).toContainText("Trading allowed");
  await page.getByLabel("Max position size").fill("2");
  await page.getByRole("button", { name: "Save limits" }).click();
  await expect(page.getByText("Saved")).toBeVisible();

  // The gate refuses an oversized order and shows every check
  await page.goto("markets?symbol=BTC-USD");
  await page.getByRole("button", { name: "Buy", exact: true }).click();
  const dialog = page.locator("dialog");
  await dialog.getByLabel("Quantity").fill("0.05");
  await dialog.getByRole("button", { name: "Place paper buy order" }).click();
  await expect(page.getByTestId("order-result")).toContainText("risk: position would be");
  await expect(dialog.getByTestId("risk-checks")).toContainText("Position size");
  // A small bracketed order passes and places protective orders
  await dialog.getByRole("button", { name: "New order" }).click();
  await dialog.getByLabel("Quantity").fill("0.01");
  const ask = Number((await dialog.getByText(/^Ask/).textContent())!.replace(/[^\d.]/g, ""));
  await dialog.getByLabel("Stop loss (optional)").fill((Math.floor(ask * 0.95 * 100) / 100).toFixed(2));
  await dialog.getByLabel("Take profit (optional)").fill((Math.ceil(ask * 1.1 * 100) / 100).toFixed(2));
  await dialog.getByRole("button", { name: "Place paper buy order" }).click();
  await expect(page.getByTestId("order-result")).toContainText("Filled 0.01 BTC-USD");
  await expect(page.getByTestId("order-result")).toContainText("Protective orders placed: STOP");
  await dialog.getByRole("button", { name: "Close dialog" }).click();

  // Decisions log, kill switch
  await page.getByRole("link", { name: "Risk Centre" }).click();
  await page.getByLabel("Decision filter").selectOption("false");
  await expect(page.getByRole("cell", { name: /position would be/ })).toBeVisible();
  await page.getByLabel("Kill switch reason").fill("e2e drill");
  await page.getByRole("button", { name: "Engage" }).click();
  await expect(page.getByTestId("risk-status")).toContainText("account kill switch is engaged: e2e drill");
  await expect(page.getByTestId("risk-events")).toContainText("Kill switch engaged");
  await page.getByRole("button", { name: "Release" }).click();
  await expect(page.getByTestId("risk-status")).toContainText("Trading allowed");

  // Autopilot through the gate
  const ap = page.getByTestId("autopilot");
  for (const s of ["ETH-USD", "SPY"]) await ap.getByRole("button", { name: s, exact: true }).click();   // leave BTC-USD only
  await ap.getByRole("button", { name: "Start" }).click();
  await expect(ap.getByText("running")).toBeVisible();
  await ap.getByRole("button", { name: "Run cycle now" }).click();
  await expect(ap.getByTestId("cycle-result")).toContainText("BTC-USD");
  await ap.getByRole("button", { name: "Emergency stop" }).click();
  await page.locator("dialog").getByRole("button", { name: "Confirm emergency stop" }).click();
  await expect(page.getByTestId("risk-status")).toContainText("kill switch is engaged");
  await expect(ap.getByText("stopped")).toBeVisible();
  await page.getByRole("button", { name: "Release" }).click();
}

// Shared with the static demo spec (kept in sync manually). Expects tradeFlow to have run first.
async function analyticsFlow(page: import("@playwright/test").Page) {
  await page.goto("analytics?period=all");
  await expect(page.getByTestId("perf-metrics")).toContainText("Return (TWR)");
  await expect(page.getByText(/need at least 20/)).toBeVisible();
  await page.getByRole("tab", { name: "Trades" }).click();
  await expect(page.getByTestId("trade-stats")).toContainText("Closed trades");
  await expect(page.getByRole("cell", { name: "BTC-USD" }).first()).toBeVisible();
  await page.getByRole("tab", { name: "Execution" }).click();
  await expect(page.getByTestId("execution-stats")).toContainText("All-in cost");
  await expect(page.getByTestId("rejections")).toContainText("Insufficient cash");
  await page.getByRole("tab", { name: "Risk" }).click();
  await expect(page.getByText("Gate decisions")).toBeVisible();
  await page.getByRole("tab", { name: "AI quality" }).click();
  await expect(page.getByTestId("ai-stats")).toContainText("Signal edge");
  await page.getByRole("tab", { name: "Report" }).click();
  await page.getByRole("button", { name: "Generate" }).click();
  await expect(page.getByTestId("report-hash")).toHaveText(/^[0-9a-f]{64}$/);
  await expect(page.getByTestId("report")).toContainText("Ledger balanced");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Round trips (CSV)" }).click();
  expect((await download).suggestedFilename()).toMatch(/^aurex-trades-all-\d{8}\.csv$/);
}

// RFC 6238 code for a base32 secret (used to act as the user's authenticator app).
function totpCode(secret: string, step = Math.floor(Date.now() / 30_000)): string {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/\s/g, "").toUpperCase()) bits += alpha.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const d = createHmac("sha1", key).update(msg).digest();
  const o = d[d.length - 1]! & 0x0f;
  return String((d.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

// Shared with the other spec (kept in sync manually). Enrols, signs out, signs back in with a code.
async function mfaFlow(page: import("@playwright/test").Page, password: string, signIn: () => Promise<void>) {
  await page.getByRole("link", { name: "Settings" }).click();
  const card = page.getByTestId("two-factor");
  await card.getByRole("button", { name: "Set up two-factor authentication" }).click();
  await card.getByLabel("Confirm your password").fill(password);
  await card.getByRole("button", { name: "Continue" }).click();
  const secret = (await card.getByTestId("mfa-secret").textContent())!.replace(/\s/g, "");
  await card.getByLabel("6-digit code").fill(totpCode(secret));
  await card.getByRole("button", { name: "Turn on" }).click();
  await expect(card.getByTestId("recovery-codes")).toContainText("will not be shown again");
  await card.getByRole("button", { name: "I have saved them" }).click();
  await expect(card.getByText("On", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await signIn();
  await expect(page.getByRole("heading", { name: "Two-factor authentication" })).toBeVisible();
  await page.getByLabel("Authentication code").fill("000000");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("Invalid authentication code")).toBeVisible();
  // the enrolment code's time step is spent (no replay): use the next one, within the drift window
  await page.getByLabel("Authentication code").fill(totpCode(secret, Math.floor(Date.now() / 30_000) + 1));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("link", { name: "Overview" })).toBeVisible();
}

// Shared with the static demo spec (kept in sync manually).
async function binaryFlow(page: import("@playwright/test").Page, account?: string) {
  await page.getByRole("link", { name: "Binary Options", exact: true }).click();
  if (account) await page.getByLabel("Account", { exact: true }).selectOption({ label: account });
  await expect(page.getByTestId("binary-disclaimer")).toContainText("Paper simulation only — not available with real money");
  await expect(page.getByRole("note", { name: "Binary options warning" })).toContainText("banned for retail customers in the UK");
  await expect(page.getByTestId("binary-maths")).toContainText("55.6%");
  await expect(page.getByTestId("live-tick-chart")).toBeVisible();
  await page.getByLabel("Instrument").selectOption("BTC-USD");
  await expect(page.getByTestId("binary-price")).toContainText("Market open");
  // 2.50 is 2.5% of £100: above the 2% binary stake cap
  await page.getByLabel("Stake (GBP)").fill("2.50");
  await page.getByRole("button", { name: "Open Higher contract" }).click();
  await expect(page.getByText(/binary limit 2%/).first()).toBeVisible();
  await expect(page.getByTestId("risk-checks")).toContainText("Stake (maximum loss)");
  await page.getByLabel("Stake (GBP)").fill("1.00");
  await page.getByRole("button", { name: "Lower", exact: true }).click();
  await page.getByRole("button", { name: "Open Lower contract" }).click();
  await expect(page.getByRole("status")).toContainText("Opened LOWER BTC-USD");
  await expect(page.getByTestId("binary-open-row")).toHaveCount(1);
  await expect(page.getByTestId("binary-stats")).toContainText("£1.00");          // at risk now
  // Switch binaries off in the Risk Centre; new contracts are then refused
  const acct = new URL(page.url()).searchParams.get("account");
  await page.goto(`risk?account=${acct}`);
  await page.getByLabel("Allow binary options").click();
  await expect(page.getByLabel("Allow binary options")).not.toBeChecked();
  await page.goto(`binary?account=${acct}`);
  await page.getByRole("button", { name: "Open Higher contract" }).click();
  await expect(page.getByText(/binary trading is switched off/).first()).toBeVisible();
  await page.getByRole("link", { name: "Wallet", exact: true }).click();
  await expect(page.getByText("Ledger balanced (debits = credits)")).toBeVisible();
}
