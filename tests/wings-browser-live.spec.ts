import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { stagingPool } from "../api/db";

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
  test.setTimeout(100_000);
  const id = process.env.RELAY_BROWSER_FIXTURE_ID,
    password = process.env.RELAY_BROWSER_FIXTURE_PASSWORD;
  assert.ok(id && password);
  const origin = "https://127.0.0.1:4443";
  const runtime = `${origin}/api/v1/servers/${id}/runtime`,
    power = `${origin}/api/v1/servers/${id}/power`;
  const loginFirst = process.env.RELAY_BROWSER_LOGIN_FIRST === "1";
  const detail = page.getByRole("button", {
    name: /^(Detail server|Buka konsol)$/,
  });
  async function open(email: string) {
    await page.goto(loginFirst ? origin : `${origin}/#authView`);
    await expect(page.getByText("Atlas Survival")).toHaveCount(0);
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page
      .getByLabel("Kata sandi", { exact: true })
      .fill(password as string);
    const list = page.waitForResponse(
      (r) => r.url() === `${origin}/api/v1/servers`,
    );
    await page.getByRole("button", { name: "Masuk", exact: true }).click();
    if (!loginFirst)
      await page.getByRole("button", { name: "Muat daftar server" }).click();
    const data = (await (await list).json()) as {
      items: { id: string; name: string }[];
    };
    const fixture = data.items.find((item) => item.id === id);
    assert.ok(fixture);
    const state = page.waitForResponse((r) => r.url() === runtime);
    await page
      .locator(`[data-server-id="${id}"]`)
      .getByRole("button", {
        name:
          loginFirst && email === "adoption@example.test"
            ? "Buka konsol"
            : "Detail server",
      })
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
  const renameApi = `${fileApi}/rename-fixture`;
  const renamed = "browser-renamed.txt";
  const requestRename = (source: string, target: string) =>
    page.context().request.post(renameApi, {
      headers: editHeaders,
      data: { source, target },
    });
  const copyApi = `${fileApi}/copy-fixture`;
  const copyName = "browser-copy.txt";
  const requestCopy = (source: string, target: string) =>
    page.context().request.post(copyApi, {
      headers: editHeaders,
      data: { source, target },
    });
  const uploadApi = `${fileApi}/upload-fixture`;
  const uploadedBytes = Buffer.from("Browser upload: å\r\n");
  const uploadName = "browser-upload.txt";
  const chmodApi = `${fileApi}/chmod-fixture`;
  const chmod = (name: string, mode: string) =>
    page
      .context()
      .request.post(chmodApi, { headers: editHeaders, data: { name, mode } });
  await open("collaborator@example.test");
  expect((await chmod(uploadName, "600")).status()).toBe(404);
  expect((await requestRename("example.txt", renamed)).status()).toBe(404);
  expect((await requestCopy("example.txt", copyName)).status()).toBe(404);
  expect(await page.getByLabel("File untuk diunggah").count()).toBe(0);
  expect(
    (
      await page.context().request.post(uploadApi, {
        headers: editHeaders,
        data: { name: uploadName, content: uploadedBytes.toString("base64") },
      })
    ).status(),
  ).toBe(403);
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
  if (loginFirst) {
    await expect(
      page.getByRole("button", { name: "Baca konsol staging" }),
    ).toHaveCount(0);
    expect(
      (
        await page
          .context()
          .request.get(`${origin}/api/v1/servers/${id}/console`)
      ).status(),
    ).toBe(404);
  } else {
    await readConsole(404);
    await expect(
      page.getByText("Cuplikan konsol tidak tersedia", { exact: false }),
    ).toBeVisible();
  }
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
  const input = page.getByLabel("File untuk diunggah");
  await input.setInputFiles({
    name: uploadName,
    mimeType: "text/plain",
    buffer: uploadedBytes,
  });
  const uploadReply = page.waitForResponse((r) => r.url() === uploadApi);
  await page.getByRole("button", { name: "Unggah file" }).click();
  expect((await uploadReply).status()).toBe(201);
  await expect(page.getByText("Unggahan terverifikasi.")).toBeVisible();
  await expect(
    files.getByRole("button", { name: uploadName, exact: true }),
  ).toBeVisible();
  const uploadVolume = process.env.RELAY_WINGS_CONTRACT_DATA ?? "";
  assert.match(uploadVolume, /^\/tmp\/tmp\.[A-Za-z0-9]+\/data\/volumes$/);
  assert.match(id, /^[0-9a-f-]{36}$/);
  const readUploaded = async () =>
    (
      await docker(
        "docker",
        [
          "exec",
          fixtureDaemon,
          "cat",
          `${uploadVolume}/${id}/fixture-docs/${uploadName}`,
        ],
        { encoding: "buffer", timeout: 5000 },
      )
    ).stdout;
  expect(await readUploaded()).toEqual(uploadedBytes);
  expect(
    (
      await page.context().request.post(uploadApi, {
        headers: editHeaders,
        data: {
          name: uploadName,
          content: Buffer.from("overwrite").toString("base64"),
        },
      })
    ).status(),
  ).toBe(409);
  await page
    .getByRole("combobox", { name: /^File sumber/ })
    .selectOption(uploadName);
  await page.getByLabel("Nama / jalur").fill(copyName);
  const copied = page.waitForResponse((response) => response.url() === copyApi);
  await page.getByRole("button", { name: "Salin file" }).click();
  expect((await copied).status()).toBe(201);
  await expect(page.getByText("Operasi terverifikasi.")).toBeVisible();
  await expect(
    files.getByRole("button", { name: copyName, exact: true }),
  ).toBeVisible();
  expect((await requestCopy(uploadName, copyName)).status()).toBe(409);
  expect(
    (await requestCopy("../relay-start.sh", "invalid-copy.txt")).status(),
  ).toBe(400);
  const copiedBytes = (
    await docker(
      "docker",
      [
        "exec",
        fixtureDaemon,
        "cat",
        `${uploadVolume}/${id}/fixture-docs/${copyName}`,
      ],
      { encoding: "buffer", timeout: 5000 },
    )
  ).stdout;
  expect(copiedBytes).toEqual(uploadedBytes);
  expect(await readUploaded()).toEqual(uploadedBytes);
  console.log(
    "::notice::Wings fixture copy verified source and destination bytes and rejected overwrite and collaborator",
  );
  expect((await requestRename(copyName, uploadName)).status()).toBe(409);
  expect((await requestRename("example.txt", renamed)).status()).toBe(404);
  expect((await requestRename(copyName, "../rename-escape.txt")).status()).toBe(
    400,
  );
  await page
    .getByRole("combobox", { name: /^File sumber/ })
    .selectOption(copyName);
  await page.getByLabel("Nama / jalur").fill(renamed);
  const renameReply = page.waitForResponse(
    (response) => response.url() === renameApi,
  );
  await page.getByRole("button", { name: "Ubah nama file" }).click();
  expect((await renameReply).status()).toBe(200);
  await expect(page.getByText("Operasi terverifikasi.")).toBeVisible();
  await expect(
    files.getByRole("button", { name: copyName, exact: true }),
  ).toHaveCount(0);
  await expect(
    files.getByRole("button", { name: renamed, exact: true }),
  ).toBeVisible();
  expect(
    (
      await docker(
        "docker",
        [
          "exec",
          fixtureDaemon,
          "cat",
          `${uploadVolume}/${id}/fixture-docs/${renamed}`,
        ],
        { encoding: "buffer", timeout: 5000 },
      )
    ).stdout,
  ).toEqual(uploadedBytes);
  await docker(
    "docker",
    [
      "exec",
      fixtureDaemon,
      "test",
      "!",
      "-e",
      `${uploadVolume}/${id}/fixture-docs/${copyName}`,
    ],
    { timeout: 5000 },
  );
  console.log(
    "::notice::Chromium rename verified destination bytes and removed source without overwrite",
  );
  const folderParent = "browser-created",
    child = "nested",
    moveFolder = `${folderParent}/${child}`;
  const folderApi = `${fileApi}/create-folder-fixture`;
  const createFolder = (name: string) =>
    page
      .context()
      .request.post(folderApi, { headers: editHeaders, data: { name } });
  expect((await createFolder("unregistered/nested")).status()).toBe(400);
  expect((await createFolder("one/two/three")).status()).toBe(400);
  for (const name of [folderParent, moveFolder]) {
    await page.getByLabel("Nama / jalur").fill(name);
    const created = page.waitForResponse(
      (response) => response.url() === folderApi,
    );
    await page
      .getByRole("button", { name: "Buat folder", exact: true })
      .click();
    expect((await created).status()).toBe(201);
    await expect(page.getByRole("option", { name, exact: true })).toHaveCount(
      1,
    );
  }
  expect((await createFolder(moveFolder)).status()).toBe(409);
  const moveTarget = "moved-fixture.txt";
  const badDestination = await page.context().request.post(renameApi, {
    headers: editHeaders,
    data: { source: renamed, target: moveTarget, destination: "../" },
  });
  expect(badDestination.status()).toBe(400);
  expect(
    (
      await page.context().request.post(renameApi, {
        headers: editHeaders,
        data: {
          source: renamed,
          target: moveTarget,
          destination: "unregistered",
        },
      })
    ).status(),
  ).toBe(400);
  await page
    .getByRole("combobox", { name: /^File sumber/ })
    .selectOption(renamed);
  await page.getByLabel("Nama / jalur").fill(moveTarget);
  await page.getByLabel("Folder tujuan").selectOption(moveFolder);
  const moveReply = page.waitForResponse(
    (response) => response.url() === renameApi,
  );
  await page
    .getByRole("button", { name: "Pindahkan file", exact: true })
    .click();
  expect((await moveReply).status()).toBe(200);
  await expect(page.getByText("Operasi terverifikasi.")).toBeVisible();
  await expect(
    files.getByRole("button", { name: renamed, exact: true }),
  ).toHaveCount(0);
  expect(
    (
      await docker(
        "docker",
        [
          "exec",
          fixtureDaemon,
          "cat",
          `${uploadVolume}/${id}/fixture-docs/${moveFolder}/${moveTarget}`,
        ],
        { encoding: "buffer", timeout: 5000 },
      )
    ).stdout,
  ).toEqual(uploadedBytes);
  await docker(
    "docker",
    [
      "exec",
      fixtureDaemon,
      "test",
      "!",
      "-e",
      `${uploadVolume}/${id}/fixture-docs/${renamed}`,
    ],
    { timeout: 5000 },
  );
  const moveDb = stagingPool();
  try {
    const [receipts] = await moveDb.query(
      "SELECT CAST(name AS CHAR) AS name, digest FROM client_uploaded_files WHERE server_id=? AND name IN (?,?)",
      [id, renamed, `${moveFolder}/${moveTarget}`],
    );
    expect(receipts).toEqual([
      {
        name: `${moveFolder}/${moveTarget}`,
        digest: createHash("sha256").update(uploadedBytes).digest("hex"),
      },
    ]);
    const moveBack = (target: string) =>
      page.context().request.post(renameApi, {
        headers: editHeaders,
        data: {
          source: moveTarget,
          target,
          destination: "parent",
          sourceFolder: moveFolder,
        },
      });
    expect((await moveBack(uploadName)).status()).toBe(409);
    await files
      .getByRole("button", { name: folderParent, exact: true })
      .click();
    await files.getByRole("button", { name: child, exact: true }).click();
    await files.getByRole("button", { name: moveTarget, exact: true }).click();
    const returnedResponse = page.waitForResponse(
      (response) => response.url() === renameApi,
    );
    await page
      .getByRole("button", { name: "Pindahkan kembali ke fixture-docs" })
      .click();
    const returned = await returnedResponse;
    await expect(
      page.getByText("Operasi terverifikasi.", { exact: true }),
    ).toBeVisible();
    await expect(
      files.getByRole("button", { name: moveTarget, exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Folder induk" }).click();
    await expect(
      files.getByRole("button", { name: child, exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Folder induk" }).click();
    await expect(
      files.getByRole("button", { name: moveTarget, exact: true }),
    ).toBeVisible();
    expect(returned.status()).toBe(200);
    expect(await returned.json()).toMatchObject({
      name: moveTarget,
      directory: "/fixture-docs",
      size: uploadedBytes.length,
    });
    const root = `${uploadVolume}/${id}/fixture-docs`;
    const readBack = await docker(
      "docker",
      ["exec", fixtureDaemon, "cat", `${root}/${moveTarget}`],
      { encoding: "buffer", timeout: 5000 },
    );
    expect(readBack.stdout).toEqual(uploadedBytes);
    await docker(
      "docker",
      [
        "exec",
        fixtureDaemon,
        "test",
        "!",
        "-e",
        `${root}/${moveFolder}/${moveTarget}`,
      ],
      { timeout: 5000 },
    );
    const [returnedReceipts] = await moveDb.query(
      "SELECT CAST(name AS CHAR) AS name,digest FROM client_uploaded_files WHERE server_id=? AND name IN (?,?)",
      [id, moveTarget, `${moveFolder}/${moveTarget}`],
    );
    expect(returnedReceipts).toEqual([
      {
        name: moveTarget,
        digest: createHash("sha256").update(uploadedBytes).digest("hex"),
      },
    ]);
  } finally {
    await moveDb.end();
  }
  console.log(
    "::notice::Chromium fixture move verified destination bytes, source absence and relocated receipt",
  );
  await page
    .getByRole("combobox", { name: /^File sumber/ })
    .selectOption(uploadName);
  expect((await chmod(uploadName, "777")).status()).toBe(400);
  expect((await chmod("../browser-upload.txt", "600")).status()).toBe(400);
  expect((await chmod("example.txt", "600")).status()).toBe(404);
  for (const mode of ["600", "644"]) {
    const changed = page.waitForResponse(
      (response) => response.url() === chmodApi,
    );
    await page.getByRole("button", { name: mode, exact: true }).click();
    expect(await (await changed).json()).toMatchObject({
      name: uploadName,
      mode,
    });
    await expect(
      page.getByText("Operasi terverifikasi.", { exact: true }),
    ).toBeVisible();
    const actual = await docker(
      "docker",
      [
        "exec",
        fixtureDaemon,
        "stat",
        "-c",
        "%a",
        `${uploadVolume}/${id}/fixture-docs/${uploadName}`,
      ],
      { timeout: 5000 },
    );
    expect(actual.stdout.trim()).toBe(mode);
  }
  expect(await readUploaded()).toEqual(uploadedBytes);
  const gzipDownload = page.waitForEvent("download");
  const gzipResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/gzip-fixture"),
  );
  await page.getByRole("button", { name: "Unduh sebagai gzip" }).click();
  expect((await gzipResponse).headers()["content-type"]).toBe(
    "application/gzip",
  );
  const compressed = await gzipDownload;
  expect(compressed.suggestedFilename()).toBe(`${uploadName}.gz`);
  const compressedPath = await compressed.path();
  assert.ok(compressedPath);
  const unpack = (content: string) =>
    page.context().request.post(`${fileApi}/gunzip-fixture`, {
      headers: editHeaders,
      data: { content },
    });
  await page.getByLabel("Arsip untuk diekstrak").setInputFiles({
    name: `${uploadName}.gz`,
    mimeType: "application/gzip",
    buffer: await readFile(compressedPath),
  });
  const extractResponse = page.waitForResponse(
    (response) => response.url() === `${fileApi}/gunzip-fixture`,
  );
  await page.getByRole("button", { name: "Ekstrak ke folder baru" }).click();
  const gzipResult = await extractResponse;
  expect(gzipResult.status()).toBe(201);
  await expect(
    page.getByText("Ekstraksi terverifikasi:", { exact: false }),
  ).toBeVisible();
  const outcome = await page
    .getByText("Ekstraksi terverifikasi:", { exact: false })
    .textContent();
  const directory = outcome?.match(/\/fixture-docs\/extract-[0-9a-f]{32}/)?.[0];
  assert.ok(directory);
  const actualExtract = (
    await docker(
      "docker",
      [
        "exec",
        fixtureDaemon,
        "cat",
        `${uploadVolume}/${id}${directory}/extracted.txt`,
      ],
      { encoding: "buffer", timeout: 5000 },
    )
  ).stdout;
  expect(actualExtract).toEqual(uploadedBytes);
  const entries = async () =>
    (
      await docker(
        "docker",
        [
          "exec",
          fixtureDaemon,
          "ls",
          "-1",
          `${uploadVolume}/${id}/fixture-docs`,
        ],
        { timeout: 5000 },
      )
    ).stdout;
  const binaryName = "browser-data.bin";
  const binaryBytes = Buffer.from(
    Array.from({ length: 16384 }, (_, i) => i % 256),
  );
  await input.setInputFiles({
    name: binaryName,
    mimeType: "application/octet-stream",
    buffer: binaryBytes,
  });
  const binaryUpload = page.waitForResponse(
    (response) => response.url() === uploadApi,
  );
  await page.getByRole("button", { name: "Unggah file" }).click();
  expect((await binaryUpload).status()).toBe(201);
  const binaryDownload = page.waitForEvent("download");
  await files
    .getByRole("button", { name: `Unduh ${binaryName}`, exact: true })
    .click();
  const binaryArtifact = await binaryDownload;
  expect(binaryArtifact.suggestedFilename()).toBe(binaryName);
  const binaryPath = await binaryArtifact.path();
  assert.ok(binaryPath);
  expect(await readFile(binaryPath)).toEqual(binaryBytes);
  const storedBinary = await docker(
    "docker",
    [
      "exec",
      fixtureDaemon,
      "cat",
      `${uploadVolume}/${id}/fixture-docs/${binaryName}`,
    ],
    { encoding: "buffer", timeout: 5000 },
  );
  expect(storedBinary.stdout).toEqual(binaryBytes);
  const zipNames = [uploadName, "example.txt", binaryName];
  await page.getByLabel("File sumber ZIP").selectOption(zipNames);
  const zipDownload = page.waitForEvent("download");
  await page.getByRole("link", { name: "Unduh ZIP" }).click();
  const archiveFile = await (await zipDownload).path();
  assert.ok(archiveFile);
  await page.getByLabel("Arsip untuk diekstrak").setInputFiles({
    name: "fixture-docs.zip",
    mimeType: "application/zip",
    buffer: await readFile(archiveFile),
  });
  const zipResponse = page.waitForResponse(
    (response) => response.url() === `${fileApi}/unzip-fixture`,
  );
  await page.getByRole("button", { name: "Ekstrak ke folder baru" }).click();
  const zipResult = await zipResponse;
  expect(zipResult.status()).toBe(201);
  const zipOutput = (await zipResult.json()) as {
    directory: string;
    count: number;
  };
  expect(zipOutput.count).toBe(zipNames.length);
  expect(zipOutput.directory).toMatch(/^\/fixture-docs\/extract-[a-f0-9]{32}$/);
  for (const name of zipNames) {
    const read = async (path: string) =>
      (
        await docker(
          "docker",
          [
            "exec",
            fixtureDaemon,
            "cat",
            `${uploadVolume}/${id}${path}/${name}`,
          ],
          { encoding: "buffer", timeout: 5000 },
        )
      ).stdout;
    expect(await read(zipOutput.directory)).toEqual(
      await read("/fixture-docs"),
    );
  }
  const reconciliation = await page
    .context()
    .request.post(`${fileApi}/reconcile-zip-fixture`, {
      headers: editHeaders,
      data: {},
    });
  expect(reconciliation.status()).toBe(200);
  expect(await reconciliation.json()).toMatchObject({
    status: "succeeded",
    directory: zipOutput.directory,
    count: zipNames.length,
  });
  expect(await entries()).not.toContain("zip-pending-");
  // Recreate the durable states left by a lost response, using the real Wings volume.
  const zipDb = stagingPool();
  const check = page.getByRole("button", {
    name: "Periksa hasil ekstraksi ZIP",
  });
  const markPending = () =>
    zipDb.execute(
      "UPDATE fixture_zip_operations SET status='pending', updated_at=CURRENT_TIMESTAMP(6)-INTERVAL 61 SECOND WHERE server_id=?",
      [id],
    );
  try {
    await zipDb.execute(
      "DELETE FROM client_uploaded_files WHERE server_id=? AND name=?",
      [
        id,
        `${zipOutput.directory.slice("/fixture-docs/".length)}/${binaryName}`,
      ],
    );
    await markPending();
    const recovered = page.waitForResponse(
      (response) => response.url() === `${fileApi}/reconcile-zip-fixture`,
    );
    await check.click();
    expect(await (await recovered).json()).toMatchObject({
      status: "succeeded",
      directory: zipOutput.directory,
      count: zipNames.length,
    });
    await expect(check).toBeEnabled();
    const recoveredBinary = await page.context().request.get(fileApi, {
      params: {
        directory: zipOutput.directory,
        preview: binaryName,
        download: "1",
      },
    });
    expect(recoveredBinary.status()).toBe(200);
    expect(recoveredBinary.headers()["content-type"]).toBe(
      "application/octet-stream",
    );
    expect(await recoveredBinary.body()).toEqual(binaryBytes);
    const folder = `${uploadVolume}/${id}${zipOutput.directory}`;
    const staged = folder.replace(
      /\/extract-([a-f0-9]{32})$/,
      "/zip-pending-$1",
    );
    await docker("docker", ["exec", fixtureDaemon, "mv", folder, staged], {
      timeout: 5000,
    });
    await docker(
      "docker",
      ["exec", fixtureDaemon, "rm", `${staged}/example.txt`],
      { timeout: 5000 },
    );
    await markPending();
    await check.click();
    await expect(page.getByText("Aman dicoba ulang.")).toBeVisible();
    expect(await entries()).not.toContain(staged.split("/").at(-1));
    expect(await entries()).not.toContain(folder.split("/").at(-1));
  } finally {
    await zipDb.end();
  }
  const beforeBadZip = await entries();
  expect(
    (
      await page.context().request.post(`${fileApi}/unzip-fixture`, {
        headers: editHeaders,
        data: { content: Buffer.from("invalid zip").toString("base64") },
      })
    ).status(),
  ).toBe(400);
  expect(await entries()).toBe(beforeBadZip);
  const beforeInvalid = await entries();
  expect(
    (await unpack(Buffer.from("invalid gzip").toString("base64"))).status(),
  ).toBe(400);
  expect(await entries()).toBe(beforeInvalid);
  expect(await readUploaded()).toEqual(uploadedBytes);
  console.log(
    "::notice::Wings gzip round-trip verified exact bytes in a new folder; corrupt input created nothing",
  );
  const binaryCopy = "browser-copy.bin";
  await page
    .getByRole("combobox", { name: /^File sumber/ })
    .selectOption(binaryName);
  await page.getByLabel("Nama / jalur").fill(binaryCopy);
  const copiedBinary = page.waitForResponse(
    (response) => response.url() === copyApi,
  );
  await page.getByRole("button", { name: "Salin file", exact: true }).click();
  expect((await copiedBinary).status()).toBe(201);
  await expect(
    files.getByRole("button", { name: `Unduh ${binaryCopy}` }),
  ).toBeVisible();
  expect((await requestCopy(binaryName, binaryCopy)).status()).toBe(409);
  await page
    .getByRole("combobox", { name: /^File sumber/ })
    .selectOption(binaryCopy);
  await page.getByLabel("Nama / jalur").fill(binaryCopy);
  await page.getByLabel("Folder tujuan").selectOption("review");
  const movedBinary = page.waitForResponse(
    (response) => response.url() === renameApi,
  );
  await page
    .getByRole("button", { name: "Pindahkan file", exact: true })
    .click();
  expect((await movedBinary).status()).toBe(200);
  await expect(
    files.getByRole("button", { name: `Unduh ${binaryCopy}` }),
  ).toHaveCount(0);
  const binVolume = `${uploadVolume}/${id}/fixture-docs`;
  const verifyBinary = async (relative: string) =>
    expect(
      (
        await docker(
          "docker",
          ["exec", fixtureDaemon, "cat", `${binVolume}/${relative}`],
          { encoding: "buffer", timeout: 5000 },
        )
      ).stdout,
    ).toEqual(binaryBytes);
  await verifyBinary(`review/${binaryCopy}`);
  await verifyBinary(binaryName);
  await files.getByRole("button", { name: "review", exact: true }).click();
  const backBinary = page.waitForResponse(
    (response) => response.url() === renameApi,
  );
  await files
    .getByRole("button", { name: "Pindahkan kembali", exact: true })
    .click();
  expect((await backBinary).status()).toBe(200);
  await expect(
    files.getByRole("button", { name: "Pindahkan kembali", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Folder induk" }).click();
  await expect(
    files.getByRole("button", { name: `Unduh ${binaryCopy}` }),
  ).toBeVisible();
  await verifyBinary(binaryCopy);
  await docker(
    "docker",
    [
      "exec",
      fixtureDaemon,
      "test",
      "!",
      "-e",
      `${binVolume}/review/${binaryCopy}`,
    ],
    { timeout: 5000 },
  );
  const batchApi = `${fileApi}/batch-fixture`;
  const batch = (
    operation: "copy" | "move",
    items: { source: string; target: string }[],
    destination?: string,
  ) =>
    page.context().request.post(batchApi, {
      headers: editHeaders,
      data: { operation, items, destination },
    });
  const batchText = "batch-text.txt",
    batchBinary = "batch-data.bin";
  const batchItems = [
    { source: uploadName, target: batchText },
    { source: moveTarget, target: "example.txt" },
    { source: binaryName, target: batchBinary },
  ];
  expect((await batch("copy", [batchItems[0], batchItems[0]])).status()).toBe(
    400,
  );
  expect((await batch("move", [batchItems[0]], "unregistered")).status()).toBe(
    400,
  );
  await page.getByText("Batch file", { exact: true }).click();
  const runBatch = page.getByRole("button", { name: "Jalankan batch" });
  const batchSources = page.getByLabel("Sumber batch");
  await batchSources.selectOption(batchItems.map((item) => item.source));
  for (const item of batchItems)
    await page
      .getByLabel(`Tujuan ${item.source}`, { exact: true })
      .fill(item.target);
  const copyBatchResponse = page.waitForResponse(
    (response) => response.url() === batchApi,
  );
  await runBatch.click();
  const copyBatch = await copyBatchResponse;
  expect(copyBatch.status()).toBe(200);
  expect(await copyBatch.json()).toEqual({
    batchId: expect.stringMatching(/^[a-f0-9]{32}$/),
    halted: false,
    results: [
      { ...batchItems[2], status: "verified" },
      { ...batchItems[0], status: "verified" },
      { ...batchItems[1], status: "rejected", error: "file_exists" },
    ],
  });
  await expect(
    page.getByText(`${moveTarget} → example.txt: ditolak (tujuan sudah ada)`, {
      exact: true,
    }),
  ).toBeVisible();
  await verifyBinary(batchBinary);
  expect(await readUploaded()).toEqual(uploadedBytes);
  const moveItems = [
    { source: batchText, target: batchText },
    { source: batchBinary, target: batchBinary },
  ];
  await page.getByLabel("Operasi batch").selectOption("move");
  await page.getByLabel("Tujuan batch").selectOption(moveFolder);
  await batchSources.selectOption(moveItems.map((item) => item.source));
  const moveBatchResponse = page.waitForResponse(
    (response) => response.url() === batchApi,
  );
  await runBatch.click();
  const moveBatch = await moveBatchResponse;
  expect(moveBatch.status()).toBe(200);
  const interruptedMove = await moveBatch.json();
  expect(interruptedMove).toEqual({
    batchId: expect.stringMatching(/^[a-f0-9]{32}$/),
    halted: true,
    results: [
      { ...moveItems[1], status: "unconfirmed" },
      { ...moveItems[0], status: "not_attempted" },
    ],
  });
  await verifyBinary(`${moveFolder}/${batchBinary}`);
  await docker(
    "docker",
    ["exec", fixtureDaemon, "test", "!", "-e", `${binVolume}/${batchBinary}`],
    { timeout: 5000 },
  );
  const untouched = await docker(
    "docker",
    ["exec", fixtureDaemon, "cat", `${binVolume}/${batchText}`],
    { encoding: "buffer", timeout: 5000 },
  );
  expect(untouched.stdout).toEqual(uploadedBytes);
  const binaryDb = stagingPool();
  try {
    const [receipts] = await binaryDb.query(
      "SELECT digest FROM client_uploaded_files WHERE server_id=? AND name=?",
      [id, binaryName],
    );
    expect(receipts).toEqual([
      { digest: createHash("sha256").update(binaryBytes).digest("hex") },
    ]);
    const statusUrl = `${fileApi}/batch-status-fixture`;
    const stored = await page.context().request.get(statusUrl);
    expect(await stored.json()).toEqual({
      batch: { ...interruptedMove, operation: "move", destination: moveFolder },
    });
    await expect(
      page.getByText(`${batchBinary} → ${batchBinary}: belum terkonfirmasi`, {
        exact: true,
      }),
    ).toBeVisible();
    // Advance the persisted grace-period timestamp, not the recorded outcome.
    await binaryDb.execute(
      "UPDATE fixture_file_batches SET updated_at=CURRENT_TIMESTAMP(6)-INTERVAL 61 SECOND WHERE server_id=?",
      [id],
    );
    const frozen = await batch("move", moveItems, moveFolder);
    expect(frozen.status()).toBe(409);
    expect((await frozen.json()).error).toBe("batch_reconciliation_required");
    async function checkBatch() {
      const response = page.waitForResponse(
        (response) =>
          response.url() === statusUrl &&
          response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Periksa hasil batch" }).click();
      return response;
    }
    const targetPath = `${binVolume}/${moveFolder}/${batchBinary}`;
    const holdPath = `${targetPath}.held`;
    const fileCommand = (...args: string[]) =>
      docker("docker", ["exec", fixtureDaemon, ...args], { timeout: 5000 });
    const ageBatch = () =>
      binaryDb.execute(
        "UPDATE fixture_file_batches SET updated_at=CURRENT_TIMESTAMP(6)-INTERVAL 61 SECOND WHERE server_id=?",
        [id],
      );
    await fileCommand("mv", targetPath, holdPath);
    try {
      for (const mismatch of [false, true]) {
        if (mismatch)
          await fileCommand("cp", `${binVolume}/${batchText}`, targetPath);
        await ageBatch();
        const check = await checkBatch();
        expect(check.status()).toBe(200);
        expect(await check.json()).toEqual({
          batch: {
            ...interruptedMove,
            operation: "move",
            destination: moveFolder,
          },
        });
        await expect(runBatch).toBeDisabled();
        if (mismatch) {
          const wrong = await docker(
            "docker",
            ["exec", fixtureDaemon, "cat", targetPath],
            { encoding: "buffer", timeout: 5000 },
          );
          expect(wrong.stdout).toEqual(uploadedBytes);
        } else await fileCommand("test", "!", "-e", targetPath);
      }
    } finally {
      await fileCommand("mv", holdPath, targetPath);
    }
    await ageBatch();
    const recoveredBatch = await checkBatch();
    expect(recoveredBatch.status()).toBe(200);
    expect(await recoveredBatch.json()).toEqual({
      batch: {
        ...interruptedMove,
        halted: false,
        results: [
          { ...moveItems[1], status: "verified" },
          { ...moveItems[0], status: "not_attempted" },
        ],
        operation: "move",
        destination: moveFolder,
      },
    });
    await expect(
      page.getByText(`${batchBinary} → ${batchBinary}: terverifikasi`, {
        exact: true,
      }),
    ).toBeVisible();
    const [batchReceipts] = await binaryDb.query(
      "SELECT CAST(name AS CHAR) AS name,digest FROM client_uploaded_files WHERE server_id=? AND name IN (?,?,?,?) ORDER BY name",
      [
        id,
        batchText,
        batchBinary,
        `${moveFolder}/${batchText}`,
        `${moveFolder}/${batchBinary}`,
      ],
    );
    expect(batchReceipts).toEqual([
      {
        name: batchText,
        digest: createHash("sha256").update(uploadedBytes).digest("hex"),
      },
      {
        name: `${moveFolder}/${batchBinary}`,
        digest: createHash("sha256").update(binaryBytes).digest("hex"),
      },
    ]);
    const [copyReceipts] = await binaryDb.query(
      "SELECT CAST(name AS CHAR) AS name,digest FROM client_uploaded_files WHERE server_id=? AND name IN (?,?)",
      [id, binaryCopy, `review/${binaryCopy}`],
    );
    expect(copyReceipts).toEqual([
      {
        name: binaryCopy,
        digest: createHash("sha256").update(binaryBytes).digest("hex"),
      },
    ]);
  } finally {
    await binaryDb.end();
  }
  const copyRecoveryTarget = "batch-recovered-copy.bin";
  const pendingCopyItems = [
    { source: binaryName, target: copyRecoveryTarget },
    { source: uploadName, target: "batch-untouched.txt" },
  ];
  await page.getByLabel("Operasi batch").selectOption("copy");
  await batchSources.selectOption(pendingCopyItems.map((item) => item.source));
  for (const item of pendingCopyItems)
    await page
      .getByLabel(`Tujuan ${item.source}`, { exact: true })
      .fill(item.target);
  const interruptedCopyResponse = page.waitForResponse(
    (response) => response.url() === batchApi,
  );
  await runBatch.click();
  const interruptedCopyReply = await interruptedCopyResponse;
  expect(interruptedCopyReply.status()).toBe(200);
  const interruptedCopy = await interruptedCopyReply.json();
  expect(interruptedCopy).toEqual({
    batchId: expect.stringMatching(/^[a-f0-9]{32}$/),
    halted: true,
    results: [
      { ...pendingCopyItems[0], status: "unconfirmed" },
      { ...pendingCopyItems[1], status: "not_attempted" },
    ],
  });
  await verifyBinary(binaryName);
  await verifyBinary(copyRecoveryTarget);
  await docker(
    "docker",
    [
      "exec",
      fixtureDaemon,
      "test",
      "!",
      "-e",
      `${binVolume}/batch-untouched.txt`,
    ],
    { timeout: 5000 },
  );
  await page.reload();
  if (!loginFirst)
    await page.getByRole("button", { name: "Muat daftar server" }).click();
  await page
    .locator(`[data-server-id="${id}"]`)
    .getByRole("button", { name: loginFirst ? "Buka konsol" : "Detail server" })
    .click();
  await page.getByRole("button", { name: "Buka daftar file" }).click();
  await files.getByRole("button", { name: "fixture-docs" }).click();
  await page.getByText("Batch file", { exact: true }).click();
  await expect(
    page.getByText(
      `${binaryName} → ${copyRecoveryTarget}: belum terkonfirmasi`,
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText(`${uploadName} → batch-untouched.txt: belum dicoba`, {
      exact: true,
    }),
  ).toBeVisible();
  const copyDb = stagingPool();
  try {
    await copyDb.execute(
      "UPDATE fixture_file_batches SET updated_at=CURRENT_TIMESTAMP(6)-INTERVAL 61 SECOND WHERE server_id=?",
      [id],
    );
    const statusUrl = `${fileApi}/batch-status-fixture`;
    const checked = page.waitForResponse(
      (response) =>
        response.url() === statusUrl && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Periksa hasil batch" }).click();
    expect((await checked).status()).toBe(200);
    await expect(
      page.getByText(`${binaryName} → ${copyRecoveryTarget}: terverifikasi`, {
        exact: true,
      }),
    ).toBeVisible();
    const [receipts] = await copyDb.query(
      "SELECT CAST(name AS CHAR) AS name,digest FROM client_uploaded_files WHERE server_id=? AND name IN (?,?,?) ORDER BY name",
      [id, binaryName, copyRecoveryTarget, "batch-untouched.txt"],
    );
    const digest = createHash("sha256").update(binaryBytes).digest("hex");
    expect(receipts).toEqual([
      { name: copyRecoveryTarget, digest },
      { name: binaryName, digest },
    ]);
    await verifyBinary(binaryName);
    await verifyBinary(copyRecoveryTarget);
  } finally {
    await copyDb.end();
  }
  const rejectedUploads = [
    {
      name: "../upload-traversal.txt",
      content: uploadedBytes.toString("base64"),
    },
    {
      name: "upload-invalid-utf8.txt",
      content: Buffer.from([0xc3, 0x28]).toString("base64"),
    },
    {
      name: "upload-too-large.txt",
      content: Buffer.alloc(16385, 65).toString("base64"),
    },
    { name: "upload-noncanonical.txt", content: "YR==" },
  ];
  for (const data of rejectedUploads) {
    const rejected = await page
      .context()
      .request.post(uploadApi, { headers: editHeaders, data });
    expect(rejected.status(), data.name).toBe(400);
  }
  const absentUpload = async (path: string) => {
    await docker(
      "docker",
      [
        "exec",
        fixtureDaemon,
        "sh",
        "-ec",
        'test ! -e "$1" && test ! -L "$1"',
        "upload-absence",
        `${uploadVolume}/${id}/${path}`,
      ],
      { timeout: 5000 },
    );
  };
  await absentUpload("upload-traversal.txt");
  for (const data of rejectedUploads.slice(1))
    await absentUpload(`fixture-docs/${data.name}`);
  expect(await readUploaded()).toEqual(uploadedBytes);
  console.log(
    "::notice::Chromium fixture upload verified exact Wings bytes, denied collaborator and rejected overwrite",
  );

  const downloaded = page.waitForEvent("download");
  const attachment = page.waitForResponse(
    (r) =>
      r.url().startsWith(fileApi) &&
      new URL(r.url()).searchParams.get("download") === "1",
  );
  await files
    .getByRole("button", { name: `Unduh ${uploadName}`, exact: true })
    .click();
  const response = await attachment;
  expect(response.headers()["content-disposition"]).toBe(
    `attachment; filename="${uploadName}"`,
  );
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe(uploadName);
  const local = await file.path();
  assert.ok(local);
  expect(await readFile(local)).toEqual(uploadedBytes);
  console.log(
    "::notice::Chromium downloaded the newly uploaded file with original bytes",
  );

  await files.getByRole("button", { name: "example.txt", exact: true }).click();
  const preview = page.getByRole("region", { name: "Pratinjau teks" });
  await expect(preview.locator("pre")).toHaveText(
    "<strong>fixture preview</strong>",
  );
  await expect(preview.locator("strong")).toHaveCount(0);
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
  await expect(page.getByText("Pratinjau tidak tersedia.")).toBeVisible();
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
  expect((await chmod(uploadName, "600")).status()).toBe(409);
  const onlineUpload = await page.context().request.post(uploadApi, {
    headers: editHeaders,
    data: {
      name: "upload-while-running.txt",
      content: uploadedBytes.toString("base64"),
    },
  });
  expect(onlineUpload.status()).toBe(409);
  expect((await onlineUpload.json()).error).toBe("server_not_offline");
  await absentUpload("fixture-docs/upload-while-running.txt");
  console.log(
    "::notice::Chromium upload guard rejects traversal, malformed content, oversize and running server with no created files",
  );

  const schedule = page.getByRole("region", {
    name: "Jadwal backup",
    exact: true,
  });
  const refreshSchedule = schedule.getByRole("button", {
    name: "Muat ulang jadwal dan riwayat",
  });
  await schedule.getByRole("button", { name: "Muat jadwal backup" }).click();
  await expect(schedule.getByText("Tidak ada jadwal aktif.")).toBeVisible();
  await schedule.getByLabel("Interval (menit)").fill("15");
  await schedule
    .getByLabel("Jumlah backup terjadwal yang disimpan")
    .selectOption("2");
  if (process.env.RELAY_S3_FIXTURE_USER)
    await schedule.getByLabel("Penyimpanan").selectOption("s3");
  await schedule.getByRole("button", { name: "Simpan jadwal" }).click();
  await expect(schedule.getByRole("status")).toHaveText("Jadwal disimpan.");
  await expect(
    schedule.getByText("Jadwal berikutnya:", { exact: false }),
  ).toBeVisible();
  // Advance only the disposable fixture clock/deadline. The worker sees real Wings running.
  const scheduleDb = stagingPool();
  try {
    await scheduleDb.execute(
      "UPDATE backup_schedules SET next_run_at=CURRENT_TIMESTAMP(3)-INTERVAL 1 SECOND WHERE server_id=?",
      [id],
    );
  } finally {
    await scheduleDb.end();
  }
  await expect(async () => {
    await refreshSchedule.click();
    await expect(refreshSchedule).toBeEnabled();
    await expect(
      schedule.getByText(
        "Dilewati: server tidak offline atau tidak terjangkau",
        { exact: false },
      ),
    ).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 9000, intervals: [700, 1200, 2000] });
  await expect(schedule.getByLabel("Interval (menit)")).toHaveValue("15");
  await expect(
    schedule.getByLabel("Jumlah backup terjadwal yang disimpan"),
  ).toHaveValue("2");
  await schedule
    .getByRole("button", { name: "Nonaktifkan jadwal", exact: true })
    .click();
  await schedule
    .getByRole("button", { name: "Konfirmasi nonaktifkan" })
    .click();
  await expect(schedule.getByText("Tidak ada jadwal aktif.")).toBeVisible();
  await expect(
    schedule.getByText("Dilewati: server tidak offline atau tidak terjangkau", {
      exact: false,
    }),
  ).toBeVisible();
  console.log(
    "::notice::Chromium verified schedule setup, real skipped run history, and disable preserving history",
  );
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
  const startedAt = async () =>
    (
      await docker(
        "docker",
        ["inspect", "--format", "{{.State.StartedAt}}", id],
        { timeout: 3000 },
      )
    ).stdout.trim();
  const beforeRestart = await startedAt();
  await send("Restart", 202);
  await expect(
    page.getByText(
      "Restart diminta. Status berjalan saja tidak membuktikan restart.",
    ),
  ).toBeVisible();
  await expect.poll(startedAt, { timeout: 20000 }).not.toBe(beforeRestart);
  await expect(async () => {
    const refresh = page.getByRole("button", { name: "Perbarui status" });
    await refresh.click();
    await expect(
      page.getByRole("button", { name: "Stop", exact: true }),
    ).toBeEnabled({ timeout: 1000 });
  }).toPass({ timeout: 12000, intervals: [1000, 1500, 2500] });
  console.log(
    "::notice::Chromium owner Restart replaced the Wings workload process",
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
    backups.getByRole("button", { name: "Buat backup", exact: true }),
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
