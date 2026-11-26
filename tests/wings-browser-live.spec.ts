import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
  test.setTimeout(95_000);
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
  const fileApi = `${origin}/api/v1/servers/${id}/files`;
  const docker = promisify(execFile);
  const fixtureDaemon = "relay-wings-contract";
  assert.equal(process.env.RELAY_DISPOSABLE_WINGS_CI, "1");
  assert.equal(process.env.RELAY_BOOTSTRAP_SCENARIO, "legacy-panel");
  const editApi = `${fileApi}/edit-fixture`;
  const editHeaders = { origin, "x-relay-request": "1" };
  const initialVersion = createHash("sha256")
    .update("<strong>fixture preview</strong>\n")
    .digest("hex");
  await open("collaborator@example.test");
  expect((await page.context().request.get(fileApi)).status()).toBe(404);
  expect(
    (
      await page.context().request.get(fileApi, {
        params: {
          directory: "/fixture-docs",
          preview: "example.txt",
          download: "1",
        },
      })
    ).status(),
  ).toBe(404);
  expect(
    (
      await page.context().request.post(editApi, {
        headers: editHeaders,
        data: { version: initialVersion, text: "blocked" },
      })
    ).status(),
  ).toBe(404);
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
  await page.getByRole("button", { name: "Buka daftar file" }).click();
  const files = page.getByRole("list", { name: "Isi folder" });
  await expect(files).toContainText("relay-start.sh");
  await expect(files).not.toContainText("fixture-link");
  expect(
    (
      await page
        .context()
        .request.get(fileApi, { params: { directory: "/fixture-link" } })
    ).status(),
  ).toBe(404);
  await files.getByRole("button", { name: "fixture-docs" }).click();
  await expect(files).toContainText("example.txt");
  await files.getByRole("button", { name: "example.txt", exact: true }).click();
  const preview = page.getByRole("region", { name: "Pratinjau teks" });
  await expect(preview.locator("pre")).toHaveText(
    "<strong>fixture preview</strong>",
  );
  await expect(preview.locator("strong")).toHaveCount(0);
  const downloaded = page.waitForEvent("download");
  const attachment = page.waitForResponse(
    (r) =>
      r.url().startsWith(fileApi) &&
      new URL(r.url()).searchParams.get("download") === "1",
  );
  await preview.getByRole("button", { name: "Unduh file teks" }).click();
  const response = await attachment;
  expect(response.headers()["content-disposition"]).toBe(
    'attachment; filename="example.txt"',
  );
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe("example.txt");
  const local = await file.path();
  assert.ok(local);
  expect(await readFile(local)).toEqual(
    Buffer.from("<strong>fixture preview</strong>\n"),
  );

  await preview.getByRole("button", { name: "Edit teks staging" }).click();
  await preview
    .getByRole("textbox", { name: "Editor teks" })
    .fill("Saved from Chromium\n");
  await preview.getByRole("button", { name: "Simpan teks" }).click();
  await expect(preview.getByText("Tersimpan dan terverifikasi.")).toBeVisible();
  const stale = await page.context().request.post(editApi, {
    headers: editHeaders,
    data: { version: initialVersion, text: "stale overwrite" },
  });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).error).toBe("file_version_conflict");
  await preview.getByRole("button", { name: "Edit teks staging" }).click();
  await preview
    .getByRole("textbox", { name: "Editor teks" })
    .fill("Unverified outage draft");
  let saveAttempts = 0;
  page.on("request", (request) => {
    if (request.url() === editApi && request.method() === "POST")
      saveAttempts++;
  });
  await docker("docker", ["pause", fixtureDaemon], { timeout: 5000 });
  try {
    const response = page.waitForResponse((reply) => reply.url() === editApi);
    await preview.getByRole("button", { name: "Simpan teks" }).click();
    expect((await response).status()).toBe(502);
    await expect(preview.getByRole("alert")).toContainText(
      "Penyimpanan belum terverifikasi",
    );
    await expect(
      preview.getByRole("button", { name: "Simpan teks" }),
    ).toBeDisabled();
    await expect(preview.getByText("Tersimpan dan terverifikasi.")).toHaveCount(
      0,
    );
  } finally {
    await docker("docker", ["unpause", fixtureDaemon], { timeout: 5000 });
  }
  await preview.getByRole("button", { name: "Muat ulang file" }).click();
  expect(saveAttempts).toBe(1);

  await expect(preview.locator("pre")).toHaveText("Saved from Chromium");
  await files.getByRole("button", { name: "binary.txt", exact: true }).click();
  await expect(page.getByText("Pratinjau teks tidak tersedia.")).toBeVisible();
  await expect(preview).toHaveCount(0);
  for (const [name, status] of [
    ["large.txt", 422],
    ["link.txt", 404],
    ["../example.txt", 400],
  ] as const) {
    expect(
      (
        await page.context().request.get(fileApi, {
          params: { directory: "/fixture-docs", preview: name, download: "1" },
        })
      ).status(),
    ).toBe(status);
  }
  await page.getByRole("button", { name: "Folder induk" }).click();
  await expect(files).toContainText("relay-start.sh");
  expect(
    (
      await page
        .context()
        .request.get(fileApi, { params: { directory: "/../" } })
    ).status(),
  ).toBe(400);
  expect(
    (
      await page
        .context()
        .request.get(fileApi, { params: { directory: "/fixture-docs/../../" } })
    ).status(),
  ).toBe(400);

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

  const s3 = Boolean(process.env.RELAY_S3_FIXTURE_USER);
  const backups = page.getByRole("region", {
    name: s3 ? "Backup server" : "Backup lokal",
  });
  await backups
    .getByRole("button", { name: "Muat backup", exact: true })
    .click();
  await expect(backups.getByText("Belum ada backup.")).toBeVisible();
  await expect(
    backups.getByRole("button", { name: "Buat backup" }),
  ).toBeEnabled();

  const refreshBackups = backups.getByRole("button", {
    name: "Muat ulang backup",
  });
  const backupRow = backups.getByRole("listitem");
  async function readyBackup() {
    await expect(async () => {
      await refreshBackups.click();
      await expect(refreshBackups).toBeEnabled();
      await expect(
        backupRow.getByRole("link", { name: "Unduh backup" }),
      ).toBeVisible({ timeout: 300 });
    }).toPass({ timeout: 7000, intervals: [700, 1200, 2000] });
  }
  await backups
    .getByRole("button", {
      name: s3 ? "Buat backup S3" : "Buat backup",
      exact: true,
    })
    .click();
  await expect(backups.getByRole("status")).toContainText(
    "Permintaan diterima",
  );
  await readyBackup();
  if (s3) {
    await expect(backupRow).toContainText("S3");
    const second = process.env.RELAY_BROWSER_SECOND_FIXTURE_ID ?? "";
    assert.match(second, /^[0-9a-f-]{36}$/);
    const downloadPath = await backupRow
      .getByRole("link", { name: "Unduh backup" })
      .getAttribute("href");
    assert.ok(downloadPath);
    expect(
      (
        await page
          .context()
          .request.get(
            origin +
              downloadPath.replace(`/servers/${id}/`, `/servers/${second}/`),
          )
      ).status(),
    ).toBe(404);
  }
  const archiveDownload = page.waitForEvent("download");
  await backupRow.getByRole("link", { name: "Unduh backup" }).click();
  const archive = await archiveDownload;
  expect(archive.suggestedFilename()).toMatch(/^[0-9a-f-]{36}\.tar\.gz$/);
  const archivePath = await archive.path();
  assert.ok(archivePath);
  const extracted = await docker(
    "tar",
    ["-xOzf", archivePath, "fixture-docs/example.txt"],
    { encoding: "buffer", timeout: 5000 },
  );
  const checkpoint = Buffer.from("Saved from Chromium\n");
  expect(extracted.stdout).toEqual(checkpoint);
  await backupRow
    .getByRole("button", { name: "Kunci backup", exact: true })
    .click();
  await expect(backupRow).toContainText("Terkunci");
  await expect(
    backupRow.getByRole("button", { name: "Hapus backup" }),
  ).toHaveCount(0);
  await backupRow.getByRole("button", { name: "Buka kunci backup" }).click();
  await expect(
    backupRow.getByRole("button", { name: "Hapus backup" }),
  ).toBeVisible();
  const newer = "After the browser backup\n";
  expect(
    (
      await page.context().request.post(editApi, {
        headers: editHeaders,
        data: {
          version: createHash("sha256").update(checkpoint).digest("hex"),
          text: newer,
        },
      })
    ).status(),
  ).toBe(200);
  // Read bytes independently of the browser's file API quota.
  const volumeRoot = process.env.RELAY_WINGS_CONTRACT_DATA ?? "";
  assert.match(volumeRoot, /^\/tmp\/tmp\.[A-Za-z0-9]+\/data\/volumes$/);
  assert.match(id, /^[0-9a-f-]{36}$/);
  const fileBytes = async () =>
    (
      await docker(
        "docker",
        [
          "exec",
          fixtureDaemon,
          "cat",
          `${volumeRoot}/${id}/fixture-docs/example.txt`,
        ],
        { encoding: "buffer", timeout: 5000 },
      )
    ).stdout;
  expect(await fileBytes()).toEqual(Buffer.from(newer));
  await backupRow.getByRole("button", { name: "Pulihkan backup" }).click();
  await expect(
    backupRow.getByText("Pulihkan dan timpa file yang cocok?"),
  ).toBeVisible();
  await backupRow.getByRole("button", { name: "Konfirmasi" }).click();
  await expect(backups.getByRole("status")).toContainText(
    "Permintaan diterima",
  );
  await readyBackup();
  expect(await fileBytes()).toEqual(checkpoint);
  await backupRow.getByRole("button", { name: "Hapus backup" }).click();
  await backupRow.getByRole("button", { name: "Batal" }).click();
  await expect(
    backupRow.getByRole("link", { name: "Unduh backup" }),
  ).toBeVisible();
  await backupRow.getByRole("button", { name: "Hapus backup" }).click();
  await expect(
    backupRow.getByText("Hapus backup ini secara permanen?"),
  ).toBeVisible();
  await backupRow.getByRole("button", { name: "Konfirmasi" }).click();
  await expect(backups.getByText("Belum ada backup.")).toBeVisible();
  console.log(
    `::notice::Chromium verified ${s3 ? "S3" : "local"} backup create download lock unlock restore delete and checkpoint bytes`,
  );

  // Pause only the first disposable CI daemon after observing a valid state.
  // Refreshing runtime first would hide the action and not test dispatch failure.
  const refresh = page.getByRole("button", { name: "Perbarui status" });
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
  await page.getByRole("button", { name: "Muat daftar subuser" }).click();
  const subusers = page.getByRole("list", { name: "Subuser aktif" });
  const removable = subusers
    .getByRole("listitem")
    .filter({ hasText: collaborator });
  const mixed = subusers
    .getByRole("listitem")
    .filter({ hasText: "outsider@example.test" });
  await expect(removable).toContainText("activity.read");
  await expect(mixed).toContainText("control.stop");
  await expect(
    mixed.getByRole("button", { name: "Cabut akses", exact: true }),
  ).toHaveCount(0);
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
    expect(
      (
        await subuser.request.get(`${origin}/api/v1/servers/${id}/subusers`)
      ).status(),
    ).toBe(404);
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
    const ownerRequest = page.context().request;
    const state = async () =>
      (await (await ownerRequest.get(runtime)).json()).state;
    if ((await state()) !== "offline") {
      await expect
        .poll(state, { timeout: 15000, intervals: [1000] })
        .toBe("running");
      expect(
        (
          await ownerRequest.post(power, {
            headers,
            data: { action: "stop", confirm: true },
          })
        ).status(),
      ).toBe(202);
      await expect
        .poll(state, { timeout: 15000, intervals: [1000] })
        .toBe("offline");
    }
    const setPower = async (name: "Start" | "Stop", grant: boolean) => {
      await removable
        .getByRole("button", {
          name: grant ? `Beri izin ${name}` : `Cabut izin ${name}`,
        })
        .click();
      await removable
        .getByRole("button", { name: "Konfirmasi perubahan izin" })
        .click();
      await expect(
        removable.getByRole("button", {
          name: grant ? `Cabut izin ${name}` : `Beri izin ${name}`,
        }),
      ).toBeVisible();
      await expect(removable).toContainText("activity.read");
    };
    await setPower("Start", true);
    expect(
      (
        await subuser.request.post(power, {
          headers,
          data: { action: "start", confirm: true },
        })
      ).status(),
    ).toBe(202);
    await expect
      .poll(state, { timeout: 15000, intervals: [1000] })
      .toBe("running");
    expect(
      (
        await subuser.request.post(power, {
          headers,
          data: { action: "stop", confirm: true },
        })
      ).status(),
    ).toBe(404);
    await setPower("Start", false);
    expect(
      (
        await subuser.request.post(power, {
          headers,
          data: { action: "start", confirm: true },
        })
      ).status(),
    ).toBe(404);
    expect((await subuser.request.get(history)).status()).toBe(200);
    // The previous action left the workload running. Only Stop is delegated now.
    await setPower("Stop", true);
    await expect(removable).not.toContainText("control.start");
    const subuserPower = async (action: "start" | "stop") =>
      (
        await subuser.request.post(power, {
          headers,
          data: { action, confirm: true },
        })
      ).status();
    expect(await subuserPower("stop")).toBe(202);
    await expect
      .poll(state, { timeout: 15000, intervals: [1000] })
      .toBe("offline");
    expect(await subuserPower("start")).toBe(404);
    expect(await state()).toBe("offline");
    await setPower("Stop", false);
    expect(await subuserPower("stop")).toBe(404);
    expect(
      (await subuser.request.get(`${origin}/api/v1/account`)).status(),
    ).toBe(200);
    expect((await subuser.request.get(history)).status()).toBe(200);
    await readActivity.click();
    await expect(activity).toContainText("catalog.control.start.grant");
    await expect(activity).toContainText("catalog.control.start.revoke");
    await expect(activity).toContainText("catalog.control.stop.grant");
    await expect(activity).toContainText("catalog.control.stop.revoke");
    await removable
      .getByRole("button", { name: "Cabut akses", exact: true })
      .click();
    expect((await subuser.request.get(history)).status()).toBe(200);
    await removable
      .getByRole("button", { name: "Konfirmasi cabut akses" })
      .click();
    await expect(page.getByText("Akses aktivitas dicabut.")).toBeVisible();
    await expect(mixed).toContainText("control.stop");
    await expect(removable).toHaveCount(0);
    expect(
      (await subuser.request.get(`${origin}/api/v1/account`)).status(),
    ).toBe(200);
    expect((await subuser.request.get(history)).status()).toBe(404);
    await page
      .getByRole("button", { name: "Tambah akun yang sudah ada" })
      .click();
    await expect(removable).toContainText("activity.read");
    async function changeSubuser(label: string) {
      await removable.getByRole("button", { name: label, exact: true }).click();
      await removable
        .getByRole("button", { name: "Konfirmasi perubahan subuser" })
        .click();
    }
    await changeSubuser("SFTP baca dan tulis");
    await expect(removable).toContainText("file.create");
    await changeSubuser("SFTP baca saja");
    await expect(removable).not.toContainText("file.create");
    await expect(removable).toContainText("file.sftp");
    await changeSubuser("Hapus subuser");
    await expect(removable).toHaveCount(0);
    await expect(mixed).toContainText("control.stop");
  } finally {
    await subuser.close();
  }
});
