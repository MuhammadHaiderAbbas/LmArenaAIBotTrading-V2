import { expect, test } from "@playwright/test";

// Post-deploy smoke test: both published surfaces must be the expected paper-only builds.
// Set AUREX_E2E_DEPLOYED=1 and AUREX_WEB_URL to the deployed site root.
test.skip(!process.env.AUREX_E2E_DEPLOYED, "set AUREX_E2E_DEPLOYED for deployed builds");

test("deployed demo and live pages load as paper-only builds", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("");
  await expect(page.getByText("Public demo.")).toBeVisible();
  await page.getByRole("button", { name: "Launch demo", exact: true }).click();
  await expect(page.getByTestId("demo-banner")).toContainText("SIMULATED DATA");
  await page.getByRole("link", { name: "Operations" }).click();
  await expect(page.getByTestId("ops-ready")).toContainText("Live trading disabled");

  await page.goto("live/");
  await expect(page.getByTestId("paper-trading-banner")).toContainText(/paper trading only/i);
  await expect(page.getByText(/PAPER ONLY/).first()).toBeVisible();
  await expect(page.getByText(/Live build missing VITE_SUPABASE/)).toHaveCount(0);
  expect(errors).toEqual([]);
});
