import { expect, test } from "@playwright/test";

test("password recovery submits same-origin and displays a generic confirmation", async ({
  page,
}) => {
  await page.route("**/api/v1/auth/forgot-password", async (route) => {
    expect(route.request().headers()["x-relay-request"]).toBe("1");
    expect(route.request().postDataJSON()).toEqual({
      email: "someone@example.test",
    });
    await route.fulfill({ status: 202 });
  });
  await page.goto("/#authView");
  await page.getByRole("link", { name: "Lupa kata sandi" }).click();
  await page
    .getByRole("textbox", { name: "Email" })
    .fill("someone@example.test");
  await page.getByRole("button", { name: "Kirim tautan" }).click();
  await expect(page.getByRole("status")).toContainText("Jika akun tersedia");
});

test("reset fragment is removed before submission and the exact token is sent once", async ({
  page,
}) => {
  const token = "R".repeat(43);
  await page.route("**/api/v1/auth/reset-password", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      token,
      password: "Relay-test-2026!",
    });
    await route.fulfill({ status: 204 });
  });
  await page.goto(`/#reset-password?token=${token}`);
  await expect(page).toHaveURL(/#reset-password$/);
  await page.getByLabel("Kata sandi baru").fill("Relay-test-2026!");
  await page.getByRole("button", { name: "Simpan kata sandi" }).click();
  await expect(page.getByRole("status")).toContainText("berhasil diperbarui");
  await expect(
    page.getByRole("button", { name: "Simpan kata sandi" }),
  ).toHaveCount(0);
});
