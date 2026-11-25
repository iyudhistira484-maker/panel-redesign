import { expect, test } from "@playwright/test";

test("sign-in requires 2FA and confirms the account before displaying an active session", async ({
  page,
}) => {
  let authenticated = false;
  let checks = 0;
  await page.route("**/api/v1/account", async (route) => {
    checks++;
    await route.fulfill(
      authenticated
        ? { json: { displayName: "Operator Relay" } }
        : { status: 401 },
    );
  });
  await page.route("**/api/v1/auth/login", async (route) => {
    expect(route.request().headers()["x-relay-request"]).toBe("1");
    expect(route.request().postDataJSON()).toEqual({
      email: "operator@example.test",
      password: "Relay-pass-1",
    });
    await route.fulfill({ json: { twoFactorRequired: true } });
  });
  await page.route("**/api/v1/auth/challenge", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ code: "123456" });
    authenticated = true;
    await route.fulfill({ json: { twoFactorRequired: false } });
  });
  await page.route("**/api/v1/auth/logout", async (route) => {
    expect(route.request().headers()["x-relay-request"]).toBe("1");
    authenticated = false;
    await route.fulfill({ status: 204 });
  });
  await page.goto("/#authView");
  await page.getByLabel("Email", { exact: true }).fill("operator@example.test");
  await page.getByLabel("Kata sandi", { exact: true }).fill("Relay-pass-1");
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Verifikasi dua langkah" }),
  ).toBeVisible();
  expect(checks).toBe(1);
  await expect(page.getByLabel("Kode autentikator atau pemulihan")).toHaveValue(
    "",
  );
  await page.getByLabel("Kode autentikator atau pemulihan").fill("123456");
  await page.getByRole("button", { name: "Verifikasi", exact: true }).click();
  await expect(page.getByText("Operator Relay")).toBeVisible();
  expect(checks).toBe(2);
  await page.reload();
  await expect(page.getByText("Operator Relay")).toBeVisible();
  await page.getByRole("button", { name: "Keluar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Masuk", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Operator Relay")).toHaveCount(0);
});
