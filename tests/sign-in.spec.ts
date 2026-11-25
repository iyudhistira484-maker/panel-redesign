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

test("staging inventory errors clear previously loaded rows without showing demo data", async ({
  page,
}) => {
  await page.route("**/api/v1/account", (route) =>
    route.fulfill({ json: { displayName: "Operator Relay", twoFactor: true } }),
  );
  let fail = false;
  await page.route("**/api/v1/servers", (route) =>
    route.fulfill(
      fail
        ? { status: 503 }
        : {
            json: {
              items: [{ id: "fixture", name: "Staging fixture only" }],
              next: null,
            },
          },
    ),
  );
  await page.goto("/#authView");
  const load = page.getByRole("button", { name: "Muat daftar server" });
  await load.click();
  await expect(page.getByText("Staging fixture only")).toBeVisible();
  fail = true;
  await load.click();
  await expect(page.getByRole("alert")).toHaveText(
    "Daftar server gagal dimuat.",
  );
  await expect(
    page.getByRole("list", { name: "Server yang dapat diakses" }),
  ).toHaveCount(0);
});

test("server power requires confirmation and an uncertain response never looks successful", async ({
  page,
}) => {
  await page.route("**/api/v1/account", (route) =>
    route.fulfill({ json: { displayName: "Operator", twoFactor: true } }),
  );
  await page.route("**/api/v1/servers", (route) =>
    route.fulfill({
      json: { items: [{ id: "fixture", name: "Fixture" }], next: null },
    }),
  );
  await page.route("**/servers/fixture/runtime", (route) =>
    route.fulfill({ json: { presence: "present", state: "offline" } }),
  );
  let posts = 0;
  await page.route("**/servers/fixture/power", (route) => {
    posts++;
    expect(route.request().postDataJSON()).toEqual({
      action: "start",
      confirm: true,
    });
    return route.fulfill({ status: 502 });
  });
  await page.goto("/#authView");
  await page.getByRole("button", { name: "Muat daftar server" }).click();
  await page.getByRole("button", { name: "Detail server" }).click();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  expect(posts).toBe(0);
  await page.getByRole("button", { name: "Konfirmasi aksi" }).click();
  await expect(
    page.getByText("Hasil belum diketahui.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start", exact: true }),
  ).toHaveCount(0);
  expect(posts).toBe(1);
});
