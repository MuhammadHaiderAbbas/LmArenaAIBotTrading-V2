import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";

const PASSWORD = "Correct-Horse-42";

test.describe.configure({ mode: "serial" });
test.skip(!!process.env.AUREX_E2E_DEMO, "requires the API backend");

test("register, fund a paper account, move virtual cash, persist session", async ({ page }) => {
  const email = `e2e-${Date.now()}@example.com`;
  await page.goto("/register");
  await page.getByLabel("Full name").fill("E2E Trader");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByRole("heading", { name: "E2E Trader" })).toBeVisible();
  await expect(page.getByText("Paper mode")).toBeVisible();
  await expect(page.getByText("No paper accounts yet")).toBeVisible();

  // Create a paper account with the $100,000 preset (the default is £100)
  await page.getByRole("button", { name: "New paper account" }).click();
  await page.locator("dialog").getByRole("button", { name: "$100,000" }).click();
  await page.getByLabel("Account name").fill("Alpha paper");
  await page.locator("dialog").getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("link", { name: "Alpha paper" })).toBeVisible();
  await expect(page.getByText("US$100,000.00").first()).toBeVisible();
  // Live account stream (WebSocket) is connected and the equity chart is fed by it
  await expect(page.getByTestId("live-status")).toHaveText(/^\s*Live\s*$/i);
  await expect(page.getByTestId("portfolio-chart")).toBeVisible({ timeout: 15_000 });

  // Wallet: deposit then attempt an overdraw
  await page.getByRole("link", { name: "Wallet", exact: true }).click();
  await expect(page.getByText("Ledger balanced (debits = credits)")).toBeVisible();
  await page.getByLabel("Amount (USD)").fill("2500.50");
  await page.getByRole("button", { name: "Deposit virtual cash" }).click();
  await expect(page.getByText("Deposited US$2,500.50")).toBeVisible();
  await expect(page.getByText("Virtual deposit").first()).toBeVisible();

  await page.getByRole("tab", { name: "Withdraw" }).click();
  await page.getByLabel("Amount (USD)").fill("999999");
  await page.getByRole("button", { name: "Withdraw virtual cash" }).click();
  await expect(page.getByRole("alert")).toContainText("Insufficient virtual cash");

  // Session survives a reload via the httpOnly refresh cookie
  await page.reload();
  await expect(page.getByText("Ledger balanced (debits = credits)")).toBeVisible();
  await page.goto("/");
  await expect(page.getByText("Virtual deposit").first()).toBeVisible();

  // Active sessions are listed, with this one marked
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByTestId("sessions")).toContainText("This session");

  // Analytics is available from day one (with honest "not enough history" states)
  await page.getByRole("link", { name: /Analytics/ }).click();
  await expect(page.getByTestId("perf-metrics")).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/wallet");
  await expect(page).toHaveURL(/\/login$/);
});

test("admin can verify the audit chain", async ({ page }) => {
  test.skip(!process.env.AUREX_E2E_ADMIN_EMAIL, "set AUREX_E2E_ADMIN_EMAIL / AUREX_E2E_ADMIN_PASSWORD");
  await page.goto("/login");
  await page.getByLabel("Email").fill(process.env.AUREX_E2E_ADMIN_EMAIL!);
  await page.getByLabel("Password").fill(process.env.AUREX_E2E_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "Administration" }).click();
  await page.getByRole("button", { name: "Verify chain" }).click();
  await expect(page.getByText(/Chain intact — \d+ records verified/)).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export" }).click();
  expect((await download).suggestedFilename()).toMatch(/^aurex-audit-\d{8}T\d{6}Z\.jsonl$/);

  // Operations: readiness, integrity check, go-live gates and an attestation
  await page.getByRole("link", { name: "Operations" }).click();
  await expect(page.getByTestId("ops-ready")).toContainText("Live trading disabled");
  await page.getByRole("button", { name: "Run integrity check" }).click();
  await expect(page.getByTestId("integrity-result")).toContainText("audit_chain");
  await expect(page.getByTestId("integrity-result")).toContainText("append_only_triggers");
  await page.getByLabel("Reference").fill("PT-e2e-report");
  await page.getByLabel("Evidence SHA-256").fill("ab".repeat(32));
  await page.getByLabel("Review date").fill(new Date().toISOString().slice(0, 10));
  await page.getByRole("button", { name: "Record attestation" }).click();
  await expect(page.getByTestId("ops-gates")).toContainText("PT-e2e-report");
});

test("non-admin users do not see administration", async ({ page }) => {
  const email = `e2e-u-${Date.now()}@example.com`;
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Plain User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Plain User" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Administration" })).toHaveCount(0);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/$/);
});

test("markets stream live quotes and render charts", async ({ page }) => {
  const email = `e2e-m-${Date.now()}@example.com`;
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Market User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Market User" })).toBeVisible();
  await expect(page.getByText("Watchlist").first()).toBeVisible();

  await page.getByRole("link", { name: "Markets", exact: true }).click();
  await expect(page.getByText("Streaming")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("price-chart").locator("canvas").first()).toBeVisible();
  await page.getByRole("tab", { name: "ETFs" }).click();
  await page.getByRole("button", { name: "Add QQQ to watchlist" }).click();
  await expect(page.getByRole("button", { name: "Remove QQQ from watchlist" })).toBeVisible();
  await page.getByRole("button", { name: /^QQQ Invesco/ }).click();
  await expect(page.getByTestId("last-price")).not.toHaveText("—");
});

test("research lab: corpus, grounded report with citations", async ({ page }) => {
  test.skip(!process.env.AUREX_E2E_ADMIN_EMAIL, "needs an admin to load the corpus");
  await page.goto("/login");
  await page.getByLabel("Email").fill(process.env.AUREX_E2E_ADMIN_EMAIL!);
  await page.getByLabel("Password").fill(process.env.AUREX_E2E_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "AI Research Lab" }).click();
  await page.getByRole("tab", { name: "Corpus" }).click();
  await page.getByRole("button", { name: "Load sample corpus" }).click();
  await expect(page.getByText(/\d+ indexed/)).toBeVisible();
  await expect(page.getByText("Fictional sample").first()).toBeVisible();

  await page.getByRole("tab", { name: "Research" }).click();
  await page.getByLabel("Research question").fill("What did the central bank decide on the policy rate?");
  await page.getByRole("button", { name: "Research", exact: true }).click();
  await expect(page.getByText("Verified facts")).toBeVisible();
  await expect(page.getByText("Interpretation (automated heuristic)")).toBeVisible();
  await expect(page.getByRole("meter", { name: "Evidence confidence" })).toBeVisible();
  await page.getByRole("button", { name: "Source 1" }).first().click();
  await expect(page.getByText(/voted seven to two/).last()).toBeVisible();

  await page.getByLabel("Research question").fill("volcanic eruptions in Iceland tourism");
  await page.getByRole("button", { name: "Research", exact: true }).click();
  await expect(page.getByText("Insufficient evidence", { exact: true })).toBeVisible();
});

test("agent desk: run analysis, explained decision, evidence", async ({ page }) => {
  const email = `e2e-ai-${Date.now()}@example.com`;
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Agent User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("button", { name: "New paper account" }).click();
  await page.locator("dialog").getByRole("button", { name: "$100,000" }).click();
  await page.locator("dialog").getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("link", { name: "Main paper account" })).toBeVisible();

  await page.getByRole("link", { name: "AI Trading" }).click();
  await page.getByLabel("Instrument").selectOption("ETH-USD");
  await page.getByRole("button", { name: "Run analysis" }).click();
  const decision = page.getByTestId("decision");
  await expect(decision).toHaveText(/BUY|NO TRADE/);
  if ((await decision.textContent())?.includes("NO TRADE")) await expect(page.getByText("Why no trade")).toBeVisible();
  else await expect(page.getByTestId("proposal")).toBeVisible();
  for (const a of ["technical", "quant", "regime", "fundamental", "news", "sentiment", "portfolio", "risk"]) {
    await expect(page.getByTestId(`agent-${a}`)).toBeVisible();
  }
  await expect(page.getByTestId("agent-fundamental")).toContainText("Abstained");
  await page.getByTestId("agent-technical").getByRole("button", { name: /Evidence/ }).click();
  await expect(page.getByText("RSI(14)")).toBeVisible();
  await expect(page.getByText(/ETH-USD · (BUY|No trade)/)).toBeVisible();
  await page.getByRole("tab", { name: "Agents" }).click();
  await expect(page.getByText("Risk Agent")).toBeVisible();
});

test("model lab: train, gated promotion, drift check", async ({ page }) => {
  test.skip(!process.env.AUREX_E2E_ADMIN_EMAIL, "training requires an admin");
  await page.goto("/login");
  await page.getByLabel("Email").fill(process.env.AUREX_E2E_ADMIN_EMAIL!);
  await page.getByLabel("Password").fill(process.env.AUREX_E2E_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "Model Lab" }).click();
  await page.getByLabel("Instrument").selectOption("BTC-USD");
  await page.getByLabel("Algorithm").selectOption("logistic");
  await page.getByLabel("History").selectOption("60");
  await page.getByRole("button", { name: "Train & validate" }).click();
  await expect(page.getByTestId("gates")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("gates")).toContainText("Trained on real market data");
  await expect(page.getByText(/deterministic synthetic generator/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Promote" })).toBeDisabled();
  await expect(page.getByTestId("equity-chart").locator("canvas").first()).toBeVisible();
  await page.getByRole("button", { name: "Drift check" }).click();
  await expect(page.getByText(/max PSI/)).toBeVisible({ timeout: 60_000 });
});

test("backtesting: optimise in-sample, evaluate out-of-sample", async ({ page }) => {
  const email = `e2e-bt-${Date.now()}@example.com`;
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Backtester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Backtester" })).toBeVisible();
  await page.getByRole("link", { name: "Backtesting" }).click();
  await page.getByLabel("Strategy").selectOption("sma_crossover");
  await page.getByLabel("Instrument").selectOption("ETH-USD");
  await page.getByLabel("Period").selectOption("90");
  await page.getByRole("button", { name: "Run backtest" }).click();
  await expect(page.getByTestId("metrics-table")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("metrics-table")).toContainText("OOS strategy");
  await expect(page.getByText("In-sample parameter sensitivity")).toBeVisible();
  await expect(page.getByText(/Backtested on synthetic data/)).toBeVisible();
  await expect(page.getByTestId("backtest-chart").locator("canvas").first()).toBeVisible();
  await expect(page.getByText(/sma crossover · ETH-USD/).first()).toBeVisible();
});

test("paper execution: market buy, limit order, cancel, close position, history", async ({ page }) => {
  const email = `e2e-trade-${Date.now()}@example.com`;
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Paper Trader");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Paper Trader" })).toBeVisible();
  await page.getByRole("button", { name: "New paper account" }).click();
  await page.locator("dialog").getByRole("button", { name: "$100,000" }).click();
  await page.getByLabel("Account name").fill("Trading paper");
  await page.locator("dialog").getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("link", { name: "Trading paper" })).toBeVisible();
  await tradeFlow(page);
  await analyticsFlow(page);
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

test("risk engine: limits, rejection with checks, brackets, kill switch, autopilot", async ({ page }) => {
  const email = `e2e-risk-${Date.now()}@example.com`;
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Risk Manager");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Risk Manager" })).toBeVisible();
  await page.getByRole("button", { name: "New paper account" }).click();
  await page.locator("dialog").getByRole("button", { name: "$100,000" }).click();
  await page.getByLabel("Account name").fill("Risk paper");
  await page.locator("dialog").getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("link", { name: "Risk paper" })).toBeVisible();
  await riskFlow(page);
});

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

test("£100 account and paper binary options: disclosure, risk gate, open contract, switch off", async ({ page }) => {
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Small Saver");
  await page.getByLabel("Email").fill(`e2e-binary-${Date.now()}@example.com`);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Small Saver" })).toBeVisible();
  await page.getByRole("button", { name: "New paper account" }).click();
  await page.getByLabel("Account name").fill("Hundred pounds");
  await page.locator("dialog").getByRole("button", { name: "Create account" }).click();   // default preset: £100 GBP
  await expect(page.getByRole("link", { name: "Hundred pounds" })).toBeVisible();
  await expect(page.getByText("£100.00").first()).toBeVisible();
  await binaryFlow(page);
});

// Shared with the static demo spec (kept in sync manually).
async function binaryFlow(page: import("@playwright/test").Page, account?: string) {
  await page.getByRole("link", { name: "Binary Options", exact: true }).click();
  if (account) await page.getByLabel("Account", { exact: true }).selectOption({ label: account });
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

test("two-factor authentication: enrol, then sign in with a code", async ({ page }) => {
  const email = `e2e-mfa-${Date.now()}@example.com`;
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Second Factor");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Second Factor" })).toBeVisible();
  await mfaFlow(page, PASSWORD, async () => {
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
  });
});

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
