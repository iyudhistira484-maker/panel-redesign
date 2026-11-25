import assert from "node:assert/strict";
import { expect, test } from "@playwright/test";

test.use({
  ignoreHTTPSErrors: true,
  trace: "off",
  screenshot: "off",
  video: "off",
});
test("real HTTPS browser observes Wings start and stop and cannot power a read-only share", async ({
  page,
}) => {
  test.skip(
    process.env.RELAY_WINGS_BROWSER !== "1",
    "Disposable Wings contract only",
  );
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  test.setTimeout(65_000);
  const id = process.env.RELAY_BROWSER_FIXTURE_ID,
    password = process.env.RELAY_BROWSER_FIXTURE_PASSWORD;
  assert.ok(id && password);
  const origin = "https://127.0.0.1:4443";
  const runtime = `${origin}/api/v1/servers/${id}/runtime`,
    power = `${origin}/api/v1/servers/${id}/power`;
  const detail = page.getByRole("button", { name: "Detail server" });
  async function open(email: string) {
    await page.goto(`${origin}/#authView`);
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page
      .getByLabel("Kata sandi", { exact: true })
      .fill(password as string);
    await page.getByRole("button", { name: "Masuk", exact: true }).click();
    const list = page.waitForResponse(
      (r) => r.url() === `${origin}/api/v1/servers`,
    );
    await page.getByRole("button", { name: "Muat daftar server" }).click();
    const data = (await (await list).json()) as {
      items: { id: string; name: string }[];
    };
    const fixture = data.items.find((item) => item.id === id);
    assert.ok(fixture);
    const state = page.waitForResponse((r) => r.url() === runtime);
    await page
      .getByRole("listitem")
      .filter({ hasText: fixture.name })
      .getByRole("button", { name: "Detail server" })
      .first()
      .click();
    expect((await state).status()).toBe(200);
    await expect(
      page.getByText("Status Wings: offline", { exact: true }),
    ).toBeVisible();
  }
  async function send(action: string, status: number) {
    await page.getByRole("button", { name: action, exact: true }).click();
    const reply = page.waitForResponse((r) => r.url() === power);
    await page.getByRole("button", { name: "Konfirmasi aksi" }).click();
    expect((await reply).status()).toBe(status);
  }
  async function verify(state: string) {
    const label = page.getByText(`Status Wings: ${state}`, { exact: true });
    const refresh = page.getByRole("button", { name: "Perbarui status" });
    await expect
      .poll(
        async () => {
          if (await label.isVisible()) return true;
          await expect(refresh).toBeEnabled();
          const response = page.waitForResponse((r) => r.url() === runtime);
          await refresh.click();
          await response;
          return label.isVisible();
        },
        { timeout: 20000, intervals: [500, 1000, 1500] },
      )
      .toBe(true);
    await expect(
      page.getByText("Status tujuan terverifikasi oleh Wings."),
    ).toBeVisible();
  }
  await open("collaborator@example.test");
  await send("Start", 404);
  await expect(
    page.getByText("Permintaan ditolak atau tidak tersedia untuk server ini."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keluar", exact: true }).click();
  await expect(detail).toHaveCount(0);
  await open("adoption@example.test");
  await send("Start", 202);
  await verify("running");
  await send("Stop", 202);
  await verify("offline");
});
