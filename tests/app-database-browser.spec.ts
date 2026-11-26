import assert from "node:assert/strict";
import { expect, test } from "@playwright/test";

test.use({
  ignoreHTTPSErrors: true,
  trace: "off",
  screenshot: "off",
  video: "off",
});
test("owner backs up and restores an application database over HTTPS and sees the review hold", async ({
  page,
  browser,
}) => {
  test.skip(
    process.env.RELAY_APP_DB_BROWSER !== "1",
    "Disposable application database fixtures only",
  );
  const origin = "https://127.0.0.1:4443";
  const server = process.env.RELAY_APP_DB_BROWSER_SERVER ?? "";
  const database = process.env.RELAY_APP_DB_BROWSER_DATABASE ?? "";
  const owner = process.env.RELAY_APP_DB_BROWSER_OWNER_COOKIE ?? "";
  const shared = process.env.RELAY_APP_DB_BROWSER_SHARE_COOKIE ?? "";
  assert.match(server, /^[a-f0-9-]{36}$/);
  assert.match(database, /^[a-f0-9-]{36}$/);
  assert.match(owner, /^[A-Za-z0-9_-]{43}$/);
  assert.match(shared, /^[A-Za-z0-9_-]{43}$/);
  const cookie = (value: string) => ({
    name: "__Host-relay_session",
    value,
    url: `${origin}/`,
    secure: true,
    httpOnly: true,
    sameSite: "Strict" as const,
  });
  const open = async (target: typeof page) => {
    await target.goto(`${origin}/#authView`);
    await target
      .getByRole("button", { name: "Muat daftar server", exact: true })
      .click();
    await target
      .locator(`[data-server-id="${server}"]`)
      .getByRole("button", { name: "Detail server" })
      .click();
  };
  const other = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await other.addCookies([cookie(shared)]);
    const otherPage = await other.newPage();
    await open(otherPage);
    await expect(
      otherPage.getByRole("region", { name: "Database aplikasi" }),
    ).toHaveCount(0);
    assert.equal(
      (
        await other.request.get(`${origin}/api/v1/servers/${server}/databases`)
      ).status(),
      404,
    );
  } finally {
    await other.close();
  }
  await page.context().addCookies([cookie(owner)]);
  await open(page);
  const panel = page.getByRole("region", {
    name: "Database aplikasi",
    exact: true,
  });
  await panel
    .getByRole("button", { name: "Muat database", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Interrupted ledger MySQL", exact: true })
    .click();
  const held = panel.getByRole("region", { name: "Interrupted ledger MySQL" });
  await expect(held.getByRole("alert")).toContainText("Jangan ulangi");
  await expect(
    held.getByText("Perlu diperiksa", { exact: true }),
  ).toBeVisible();
  await expect(
    held.getByRole("button", { name: "Pulihkan backup database" }),
  ).toHaveCount(0);
  await panel
    .getByRole("button", { name: "Browser ledger MySQL", exact: true })
    .click();
  const target = panel.getByRole("region", { name: "Browser ledger MySQL" });
  await expect(target.getByText("Belum ada backup database.")).toBeVisible();
  const path = `${origin}/api/v1/servers/${server}/databases/${database}/backups`;
  const created = page.waitForResponse(
    (response) =>
      response.url() === path && response.request().method() === "POST",
  );
  await target.getByRole("button", { name: "Buat backup database" }).click();
  const result = await created;
  expect(result.status()).toBe(201);
  const backup = await target.locator("li code").textContent();
  assert.ok(backup);
  assert.match(backup, /^[a-f0-9-]{36}$/);
  await target
    .getByRole("button", { name: "Pulihkan backup database" })
    .click();
  await expect(
    target.getByText("Database sumber tidak akan ditimpa.", { exact: false }),
  ).toBeVisible();
  await target.getByRole("button", { name: "Batal", exact: true }).click();
  await expect(
    target.getByText("Tujuan pemulihan kosong", { exact: true }),
  ).toBeVisible();
  await target
    .getByRole("button", { name: "Pulihkan backup database" })
    .click();
  const restored = page.waitForResponse(
    (response) =>
      response.url() === `${path}/${backup}/restore` &&
      response.request().method() === "POST",
  );
  await target
    .getByRole("button", { name: "Konfirmasi restore database" })
    .click();
  expect((await restored).status()).toBe(200);
  await expect(
    target.getByText("Sudah dipulihkan", { exact: true }),
  ).toBeVisible();
  await expect(
    target.getByRole("button", { name: "Pulihkan backup database" }),
  ).toHaveCount(0);
  console.log(
    "::notice::Chromium verified application database create, explicit restore, review hold, and owner-only access",
  );
});
