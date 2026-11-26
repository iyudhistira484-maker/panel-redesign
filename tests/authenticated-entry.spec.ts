import { expect, test } from "@playwright/test";
import { createServer } from "vite";

// Separate preview configuration: the normal suite still covers demo landing.
test("authenticated entry never displays fixture servers", async ({ page }) => {
  const server = await createServer({
    define: { __RELAY_AUTHENTICATED_ENTRY__: "true" },
    server: { host: "127.0.0.1", port: 4198, strictPort: true },
  });
  await server.listen();
  try {
    let authenticated = false;
    let catalogRequests = 0;
    await page.addInitScript(() => localStorage.clear());
    await page.route("**/api/v1/account", (route) =>
      route.fulfill(
        authenticated
          ? { json: { displayName: "Pilot owner" } }
          : { status: 401 },
      ),
    );
    await page.route("**/api/v1/auth/login", async (route) => {
      authenticated = true;
      await route.fulfill({ json: { twoFactorRequired: false } });
    });
    await page.route("**/api/v1/servers", async (route) => {
      catalogRequests++;
      expect(authenticated).toBe(true);
      await route.fulfill({ json: { items: [], next: null } });
    });
    await page.goto("http://127.0.0.1:4198/#overview");
    await expect(
      page.getByRole("heading", { name: /^(Masuk|Sign in)$/ }),
    ).toBeVisible();
    await expect(page.getByText("Atlas Survival")).toHaveCount(0);
    expect(catalogRequests).toBe(0);
    await page.getByLabel("Email").fill("owner@example.test");
    await page.getByLabel(/^(Kata sandi|Password)$/).fill("fixture-password");
    await page.getByRole("button", { name: /^(Masuk|Sign in)$/ }).click();
    await expect(
      page.getByText(
        /Tidak ada server yang dapat diakses|No accessible servers/,
      ),
    ).toBeVisible();
    expect(catalogRequests).toBe(1);
    await expect(page.getByText("Atlas Survival")).toHaveCount(0);
  } finally {
    await page.goto("about:blank");
    await server.close();
  }
});

test("login-first owner opens a console snapshot while a shared server does not request one", async ({
  page,
}) => {
  const server = await createServer({
    define: { __RELAY_AUTHENTICATED_ENTRY__: "true" },
    server: { host: "127.0.0.1", port: 4198, strictPort: true },
  });
  await server.listen();
  try {
    const paths: string[] = [];
    await page.route("**/api/v1/account", (route) =>
      route.fulfill({ json: { displayName: "Pilot operator" } }),
    );
    await page.route("**/api/v1/servers", (route) =>
      route.fulfill({
        json: {
          items: [
            { id: "owner-fixture", name: "Owner fixture", isOwner: true },
            { id: "shared-fixture", name: "Shared fixture", isOwner: false },
          ],
          next: null,
        },
      }),
    );
    await page.route("**/api/v1/servers/*/console", async (route) => {
      paths.push(new URL(route.request().url()).pathname);
      await route.fulfill({
        json: { lines: ["RELAY_CONTRACT_READY"], truncated: false },
      });
    });
    await page.goto("http://127.0.0.1:4198/");
    await page
      .getByRole("button", { name: /^(Open console|Buka konsol)$/ })
      .click();
    await expect(
      page.getByText("RELAY_CONTRACT_READY", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("listitem")
      .filter({ hasText: "Shared fixture" })
      .getByRole("button", { name: /^(Server detail|Detail server)$/ })
      .click();
    await expect(
      page.getByText("RELAY_CONTRACT_READY", { exact: true }),
    ).toHaveCount(0);
    expect(paths).toEqual(["/api/v1/servers/owner-fixture/console"]);
  } finally {
    await page.goto("about:blank");
    await server.close();
  }
});
