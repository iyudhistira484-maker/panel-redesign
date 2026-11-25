import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
  test.setTimeout(75_000);
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
      .locator(`[data-server-id="${id}"]`)
      .getByRole("button", { name: "Detail server" })
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
          if (await label.isVisible()) return true;
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
  async function readMetrics(status: number) {
    const response = page.waitForResponse(
      (r) => r.url() === `${origin}/api/v1/servers/${id}/stats`,
    );
    await page
      .getByRole("button", { name: "Baca penggunaan sumber daya" })
      .click();
    expect((await response).status()).toBe(status);
  }
  async function readConsole(status: number) {
    const response = page.waitForResponse(
      (r) => r.url() === `${origin}/api/v1/servers/${id}/console`,
    );
    await page.getByRole("button", { name: "Baca konsol staging" }).click();
    const result = await response;
    expect(result.status()).toBe(status);
    if (status === 200)
      expect(await result.text()).not.toContain("fixture-console-secret");
  }
  const activity = page.getByRole("list", {
    name: "Aktivitas server",
    exact: true,
  });
  const readActivity = page.getByRole("button", {
    name: "Baca aktivitas server",
  });
  await open("collaborator@example.test");
  await readActivity.click();
  await expect(activity).toContainText("catalog.fixture_checked");
  await expect(activity.locator("time").first()).toBeVisible();
  await readConsole(404);
  await expect(
    page.getByText("Cuplikan konsol tidak tersedia", { exact: false }),
  ).toBeVisible();
  await readMetrics(404);
  await expect(
    page.getByRole("alert").filter({ hasText: "Penggunaan sumber daya" }),
  ).toContainText("Penggunaan sumber daya tidak tersedia");
  await send("Start", 404);
  await expect(
    page.getByText("Permintaan ditolak atau tidak tersedia untuk server ini."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keluar", exact: true }).click();
  await expect(detail).toHaveCount(0);
  await open("adoption@example.test");
  await send("Start", 202);
  await verify("running");
  await readConsole(200);
  await expect(page.getByLabel("Cuplikan konsol Wings")).toContainText(
    "RELAY_CONTRACT_READY",
  );
  await expect(page.getByLabel("Cuplikan konsol Wings")).toContainText(
    "RELAY_DIAGNOSTIC runtime=ready config=loaded",
  );
  await expect(page.getByLabel("Cuplikan konsol Wings")).not.toContainText(
    "fixture-console-secret",
  );
  await readMetrics(200);
  await expect(page.getByLabel("Cuplikan sumber daya Wings")).toContainText(
    "MiB",
  );
  await send("Stop", 202);
  await verify("offline");

  // Pause only the first disposable CI daemon after observing a valid state.
  // Refreshing runtime first would hide the action and not test dispatch failure.
  const docker = promisify(execFile);
  const refresh = page.getByRole("button", { name: "Perbarui status" });
  const fixtureDaemon = "relay-wings-contract";
  assert.equal(process.env.RELAY_DISPOSABLE_WINGS_CI, "1");
  assert.equal(process.env.RELAY_BOOTSTRAP_SCENARIO, "legacy-panel");
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url() === power && request.method() === "POST")
      requests.push(request.url());
  });
  await docker("docker", ["pause", fixtureDaemon], { timeout: 5000 });
  try {
    await send("Start", 502);
    await expect(
      page.getByText("Hasil belum diketahui.", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText("Status tujuan terverifikasi oleh Wings."),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Start", exact: true }),
    ).toHaveCount(0);
    await refresh.click();
    await expect(page.getByText("Status Wings tidak tersedia.")).toBeVisible({
      timeout: 9000,
    });
    await readConsole(502);
    await expect(
      page.getByText("Cuplikan konsol tidak tersedia", { exact: false }),
    ).toBeVisible();
    await expect(page.getByLabel("Cuplikan konsol Wings")).toHaveCount(0);
    expect(requests).toHaveLength(1);
  } finally {
    await docker("docker", ["unpause", fixtureDaemon], { timeout: 5000 });
  }
  await refresh.click();
  await expect(
    page.getByText(/^Status Wings: (offline|starting|running)$/),
  ).toBeVisible();
  await readActivity.click();
  await expect(activity).toContainText("Hasil Start tidak diketahui");
  await expect(activity).toContainText("Start diminta");
  await expect(activity).toContainText("Stop diminta");
  expect(requests).toHaveLength(1);
  const collaborator = "collaborator@example.test";
  const access = `${origin}/api/v1/servers/${id}/activity-access`;
  await page.getByLabel("Email subuser").fill(collaborator);
  await page.getByRole("button", { name: "Cabut akses aktivitas" }).click();
  await expect(page.getByText("Akses aktivitas dicabut.")).toBeVisible();
  await page.getByRole("button", { name: "Beri akses aktivitas" }).click();
  await expect(page.getByText("Akses aktivitas diberikan.")).toBeVisible();
  const browser = page.context().browser();
  assert.ok(browser);
  const subuser = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const headers = { origin, "x-relay-request": "1" };
    expect(
      (
        await subuser.request.post(`${origin}/api/v1/auth/login`, {
          headers,
          data: { email: collaborator, password },
        })
      ).status(),
    ).toBe(200);
    const history = `${origin}/api/v1/servers/${id}/activity`;
    expect((await subuser.request.get(history)).status()).toBe(200);
    expect(
      (
        await subuser.request.post(access, {
          headers,
          data: { email: collaborator, action: "revoke" },
        })
      ).status(),
    ).toBe(404);
    for (const action of ["start", "stop"])
      expect(
        (
          await subuser.request.post(power, {
            headers,
            data: { action, confirm: true },
          })
        ).status(),
      ).toBe(404);
    await page.getByRole("button", { name: "Cabut akses aktivitas" }).click();
    await expect(page.getByText("Akses aktivitas dicabut.")).toBeVisible();
    expect(
      (await subuser.request.get(`${origin}/api/v1/account`)).status(),
    ).toBe(200);
    expect((await subuser.request.get(history)).status()).toBe(404);
  } finally {
    await subuser.close();
  }
});
