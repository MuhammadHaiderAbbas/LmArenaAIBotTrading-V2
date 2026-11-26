import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";

// Phase 1 vertical slice: Supabase Auth + TOTP MFA + Edge Functions + shared rate limits.
test.skip(!process.env.AUREX_LIVE_EMAIL, "set AUREX_LIVE_EMAIL / AUREX_LIVE_PASSWORD");

function totp(secret: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = secret.replace(/\s/g, "").toUpperCase();
  let bits = "";
  for (const ch of clean) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Math.floor(Date.now() / 30_000);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const value = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return value.toString().padStart(6, "0");
}

test("live Phase 1: enrol MFA, ledger, quote, chart, sign out and challenge", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // Relative so the same spec works at the site root and under a GitHub Pages subpath.
  await page.goto(process.env.AUREX_LIVE_URL ?? "live.html");
  await expect(page.getByText(/PAPER ONLY/).first()).toBeVisible();
  await page.getByLabel("Email").fill(process.env.AUREX_LIVE_EMAIL!);
  await page.getByLabel("Password").fill(process.env.AUREX_LIVE_PASSWORD!);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  // Enrol a new TOTP factor. For a rerun, delete the factor in Supabase first.
  await expect(page.getByRole("button", { name: "Enrol authenticator" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Enrol authenticator" }).click();
  const secret = (await page.getByTestId("mfa-secret").innerText()).trim();
  expect(secret.length).toBeGreaterThan(10);
  await page.getByTestId("mfa-code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify code" }).click();

  await expect(page.getByTestId("edge-balance")).not.toHaveText("—", { timeout: 30_000 });
  await expect(page.getByTestId("edge-price")).not.toHaveText("—", { timeout: 30_000 });
  await expect(page.getByTestId("edge-chart").locator("canvas").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/candles · source Coinbase/)).toBeVisible();

  const before = await page.getByTestId("edge-balance").innerText();
  await page.getByLabel("Deposit amount").fill("12.50");
  await page.getByRole("button", { name: "Deposit virtual cash" }).click();
  await expect(page.getByText("Virtual deposit posted to the double-entry ledger.")).toBeVisible();
  expect(await page.getByTestId("edge-balance").innerText()).not.toEqual(before);

  // Global sign-out, then password + TOTP challenge.
  await page.getByRole("button", { name: "Sign out everywhere" }).click();
  await page.getByLabel("Email").fill(process.env.AUREX_LIVE_EMAIL!);
  await page.getByLabel("Password").fill(process.env.AUREX_LIVE_PASSWORD!);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Enter your authenticator code")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("mfa-code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify code" }).click();
  await expect(page.getByText("MFA · AAL2")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("edge-balance")).not.toHaveText("—", { timeout: 30_000 });

  expect(errors).toEqual([]);
});
