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
