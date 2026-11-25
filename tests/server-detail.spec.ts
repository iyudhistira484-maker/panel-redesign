import { expect, test } from "@playwright/test";

for (const width of [360, 1280]) {
  test(`server detail keyboard and session isolation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    const actor = "Operator desktop dan ponsel";
    await page.route("**/api/v1/account", (route) =>
      route.fulfill({ json: { displayName: actor, twoFactor: true } }),
    );
    await page.route("**/api/v1/auth/logout", (route) =>
      route.fulfill({ status: 204 }),
    );
    await page.route("**/api/v1/servers", (route) =>
      route.fulfill({
        json: {
          items: [
            { id: "one", name: "Server pertama" },
            { id: "two", name: `Server ${"panjang".repeat(20)}` },
          ],
          next: null,
        },
      }),
    );
    await page.route("**/api/v1/servers/*/runtime", (route) =>
      route.fulfill({
        json: {
          presence: route.request().url().includes("/one/")
            ? "present"
            : "unreachable",
          state: "offline",
        },
      }),
    );
    await page.route("**/api/v1/servers/one/stats", (route) =>
      route.fulfill({
        json: {
          cpuAbsolute: 1,
          memoryBytes: 1,
          memoryLimitBytes: 2,
          diskBytes: 3,
          uptimeMs: 10,
          rxBytes: 5,
          txBytes: 6,
        },
      }),
    );
    await page.route("**/api/v1/servers/one/console", (route) =>
      route.fulfill({
        json: { lines: ["RELAY_CONTRACT_READY"], truncated: false },
      }),
    );
    await page.route("**/api/v1/servers/one/activity", (route) =>
      route.fulfill({
        json: [
          {
            id: "audit",
            event: "wings.power_start_uncertain",
            created_at: "2026-11-24T00:00:00Z",
            actor_name: actor,
          },
        ],
      }),
    );
    await page.goto("/#authView");
    await page.getByRole("button", { name: "Muat daftar server" }).click();
    const details = page.getByRole("button", { name: "Detail server" });
    await details.first().focus();
    await page.keyboard.press("Enter");
    await expect(details.first()).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByText("Status Wings: offline", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "Perbarui status" }),
    ).toBeFocused();
    await page
      .getByRole("button", { name: "Baca penggunaan sumber daya" })
      .click();
    await page.getByRole("button", { name: "Baca konsol staging" }).click();
    await page.getByRole("button", { name: "Baca aktivitas server" }).click();
    await expect(page.getByLabel("Cuplikan sumber daya Wings")).toBeVisible();
    await expect(page.getByLabel("Cuplikan konsol Wings")).toBeVisible();
    await expect(
      page.getByText("Hasil Start tidak diketahui", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await details.last().focus();
    await page.keyboard.press("Space");
    await expect(details.first()).toHaveAttribute("aria-expanded", "false");
    await expect(
      page.getByText("Status Wings tidak tersedia.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Cuplikan sumber daya Wings")).toHaveCount(0);
    await expect(page.getByLabel("Cuplikan konsol Wings")).toHaveCount(0);
    await expect(
      page.getByRole("list", { name: "Aktivitas server", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Keluar", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Masuk", exact: true }),
    ).toBeVisible();
    await expect(details).toHaveCount(0);
    await expect(page.getByText(actor, { exact: true })).toHaveCount(0);
  });
}
