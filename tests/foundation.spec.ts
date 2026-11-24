import { expect, test } from "@playwright/test";
for (const width of [360, 768, 1280, 1920]) {
  test(`overview without page overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Ringkasan server" }),
    ).toBeVisible();
    await expect(page.getByRole("row")).toHaveCount(7);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    if (width < 960) {
      await page
        .getByRole("button", { name: "Buka atau tutup navigasi" })
        .click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
  });
}
test("filter, grid and details", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Cari server…" }).fill("Atlas");
  await expect(page.getByRole("row")).toHaveCount(3);
  await page.getByLabel("Filter status").selectOption("running");
  await page.getByRole("button", { name: "Tampilan kisi" }).click();
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.getByRole("button", { name: "Atlas Survival" }).click();
  await expect(page.getByRole("dialog")).toContainText("192.0.2.10:25565");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Atlas Survival" }),
  ).toBeFocused();
  await page.getByRole("textbox", { name: "Cari server…" }).fill("unknown");
  await expect(
    page.getByRole("heading", { name: "Server tidak ditemukan" }),
  ).toBeVisible();
});
for (const locale of ["id", "en"]) {
  test(`layout gallery and persisted preference: ${locale}`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByLabel("Bahasa").selectOption(locale);
    const headings =
      locale === "id"
        ? [
            "Masuk",
            "Server tidak ditemukan",
            "Halaman tidak tersedia",
            "Node",
            "Pengaturan tampilan",
          ]
        : [
            "Sign in",
            "No servers found",
            "Page unavailable",
            "Nodes",
            "Display settings",
          ];
    for (const [i, route] of [
      "authView",
      "emptyView",
      "errorView",
      "nodes",
      "settings",
    ].entries()) {
      await page.goto(`/#${route}`);
      await expect(
        page.getByRole("heading", { name: headings[i], exact: true }),
      ).toBeVisible();
    }
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
  });
}

test("component samples work with keyboard", async ({ page }) => {
  await page.goto("/#settings");
  const settings = page.getByRole("tab", { name: "Pengaturan" });
  await settings.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Pratinjau" })).toBeFocused();
  await page.getByRole("button", { name: "Berikutnya" }).click();
  await expect(
    page.getByRole("navigation", { name: "Paginasi" }),
  ).toContainText("2 / 3");
});
