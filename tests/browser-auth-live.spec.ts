import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { stagingPool } from "../api/db";
import { cryptoContext, keyFrom, passwordHash, totpAt } from "../api/security";

test.use({
  ignoreHTTPSErrors: true,
  trace: "off",
  screenshot: "off",
  video: "off",
});
test("HTTPS browser, Mailpit, MySQL and real API complete account recovery and 2FA", async ({
  page,
  context,
}) => {
  test.skip(
    process.env.RELAY_BROWSER_AUTH_CI !== "1",
    "Disposable staging only",
  );
  test.setTimeout(60_000);
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  const origin = "https://127.0.0.1:4443";
  const email = `browser-${randomUUID()}@example.test`;
  const secret = randomBytes(20),
    user = randomUUID();
  const crypt = cryptoContext(
    keyFrom(process.env.RELAY_TOTP_KEY, "RELAY_TOTP_KEY"),
    keyFrom(process.env.RELAY_TOKEN_PEPPER, "RELAY_TOKEN_PEPPER"),
  );
  const pool = stagingPool();
  try {
    await pool.execute(
      "INSERT INTO users (id,email,display_name,password_hash,totp_secret) VALUES (?,?,'Browser Operator',?,?)",
      [
        user,
        email,
        await passwordHash(`Initial-${randomUUID()}`),
        crypt.seal(secret, user),
      ],
    );
  } finally {
    await pool.end();
  }
  await page.goto(`${origin}/#forgot-password`);
  await page.getByLabel("Email", { exact: true }).fill(email);
  const forgot = page.waitForResponse(
    (response) => response.url() === `${origin}/api/v1/auth/forgot-password`,
  );
  await page.getByRole("button", { name: "Kirim tautan" }).click();
  expect((await forgot).status()).toBe(202);
  let resetUrl = "";
  await expect
    .poll(
      async () => {
        const search = new URL("http://127.0.0.1:8025/api/v1/search");
        search.searchParams.set("query", `to:${email}`);
        try {
          const { messages } = (await (
            await fetch(search, { signal: AbortSignal.timeout(2000) })
          ).json()) as {
            messages?: { ID: string; To: { Address: string }[] }[];
          };
          const match = messages?.find((message) =>
            message.To.some((to) => to.Address === email),
          );
          if (!match) return false;
          const { Text } = (await (
            await fetch(
              `http://127.0.0.1:8025/api/v1/message/${encodeURIComponent(match.ID)}`,
              { signal: AbortSignal.timeout(2000) },
            )
          ).json()) as { Text: string };
          resetUrl =
            Text.split(/\s+/).find((line) =>
              line.startsWith(`${origin}/#reset-password?token=`),
            ) ?? "";
          return !!resetUrl;
        } catch {
          return false;
        }
      },
      { timeout: 15000 },
    )
    .toBe(true);
  const password = `Updated-${randomUUID()}`;
  const reset = async () => {
    await page.goto(resetUrl);
    await expect(page).toHaveURL(/#reset-password$/);
    await page.getByLabel("Kata sandi baru").fill(password);
    const result = page.waitForResponse(
      (response) => response.url() === `${origin}/api/v1/auth/reset-password`,
    );
    await page.getByRole("button", { name: "Simpan kata sandi" }).click();
    return (await result).status();
  };
  expect(await reset()).toBe(204);
  await expect(page.getByRole("status")).toContainText("berhasil diperbarui");
  expect(await reset()).toBe(400);
  await expect(page.getByRole("alert")).toContainText("Tautan tidak valid");
  await page.goto(`${origin}/#authView`);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Kata sandi", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Verifikasi dua langkah" }),
  ).toBeVisible();
  expect((await context.request.get(`${origin}/api/v1/account`)).status()).toBe(
    401,
  );
  await page
    .getByLabel("Kode autentikator atau pemulihan")
    .fill(totpAt(secret, Math.floor(Date.now() / 30_000)));
  await page.getByRole("button", { name: "Verifikasi", exact: true }).click();
  await expect(page.getByText("Browser Operator")).toBeVisible();
  const session = (await context.cookies()).find(
    (cookie) => cookie.name === "__Host-relay_session",
  );
  assert.ok(session?.httpOnly && session.secure);
  await page.reload();
  await expect(page.getByText("Browser Operator")).toBeVisible();
  await page.getByRole("button", { name: "Keluar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Masuk", exact: true }),
  ).toBeVisible();
  expect(
    (
      await context.request.get(`${origin}/api/v1/account`, {
        headers: { cookie: `${session.name}=${session.value}` },
      })
    ).status(),
  ).toBe(401);
});
