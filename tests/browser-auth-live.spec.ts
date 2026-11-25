import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { stagingPool } from "../api/db";
import { base32, passwordHash, totpAt } from "../api/security";

test.use({
  ignoreHTTPSErrors: true,
  trace: "off",
  screenshot: "off",
  video: "off",
});
test("HTTPS browser, Mailpit, MySQL and real API complete account recovery and 2FA", async ({
  page,
  context,
}) => {
  test.skip(
    process.env.RELAY_BROWSER_AUTH_CI !== "1",
    "Disposable staging only",
  );
  test.setTimeout(60_000);
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  const origin = "https://127.0.0.1:4443";
  const email = `browser-${randomUUID()}@example.test`;
  const pool = stagingPool();
  try {
    await pool.execute(
      "INSERT INTO users (id,email,display_name,password_hash) VALUES (?,?,'Browser Operator',?)",
      [randomUUID(), email, await passwordHash(`Initial-${randomUUID()}`)],
    );
  } finally {
    await pool.end();
  }
  await page.goto(`${origin}/#forgot-password`);
  await page.getByLabel("Email", { exact: true }).fill(email);
  const forgot = page.waitForResponse(
    (response) => response.url() === `${origin}/api/v1/auth/forgot-password`,
  );
  await page.getByRole("button", { name: "Kirim tautan" }).click();
  expect((await forgot).status()).toBe(202);
  let resetUrl = "";
  await expect
    .poll(
      async () => {
        const search = new URL("http://127.0.0.1:8025/api/v1/search");
        search.searchParams.set("query", `to:${email}`);
        try {
          const { messages } = (await (
            await fetch(search, { signal: AbortSignal.timeout(2000) })
          ).json()) as {
            messages?: { ID: string; To: { Address: string }[] }[];
          };
          const match = messages?.find((message) =>
            message.To.some((to) => to.Address === email),
          );
          if (!match) return false;
          const { Text } = (await (
            await fetch(
              `http://127.0.0.1:8025/api/v1/message/${encodeURIComponent(match.ID)}`,
              { signal: AbortSignal.timeout(2000) },
            )
          ).json()) as { Text: string };
          resetUrl =
            Text.split(/\s+/).find((line) =>
              line.startsWith(`${origin}/#reset-password?token=`),
            ) ?? "";
          return !!resetUrl;
        } catch {
          return false;
        }
      },
      { timeout: 15000 },
    )
    .toBe(true);
  const password = `Updated-${randomUUID()}`;
  const reset = async () => {
    await page.goto(resetUrl);
    await expect(page).toHaveURL(/#reset-password$/);
    await page.getByLabel("Kata sandi baru").fill(password);
    const result = page.waitForResponse(
      (response) => response.url() === `${origin}/api/v1/auth/reset-password`,
    );
    await page.getByRole("button", { name: "Simpan kata sandi" }).click();
    return (await result).status();
  };
  expect(await reset()).toBe(204);
  await expect(page.getByRole("status")).toContainText("berhasil diperbarui");
  expect(await reset()).toBe(400);
  await expect(page.getByRole("alert")).toContainText("Tautan tidak valid");
  await page.goto(`${origin}/#authView`);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Kata sandi", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await page
    .getByRole("button", { name: "Aktifkan autentikasi dua langkah" })
    .click();
  await page.getByLabel("Kata sandi saat ini").fill(password);
  const begin = page.waitForResponse(
    (response) => response.url() === `${origin}/api/v1/account/totp/begin`,
  );
  await page.getByRole("button", { name: "Lanjutkan", exact: true }).click();
  const started = await begin;
  expect(started.status()).toBe(204);
  const secret = Buffer.from(
    started.request().postDataJSON().seed,
    "base64url",
  );
  await expect(page.getByText(base32(secret), { exact: true })).toBeVisible();
  await page
    .getByLabel("Kode enam digit")
    .fill(totpAt(secret, Math.floor(Date.now() / 30000)));
  await page
    .getByRole("button", { name: "Konfirmasi autentikasi dua langkah" })
    .click();
  const codes = page.getByRole("region", { name: "Kode pemulihan" });
  await expect(codes.getByRole("listitem")).toHaveCount(10);
  const recovery = (
    await codes.getByRole("listitem").first().innerText()
  ).trim();
  await page.getByRole("button", { name: "Saya sudah menyimpan kode" }).click();
  await expect(codes).toHaveCount(0);
  await page.getByRole("button", { name: "Keluar", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Kata sandi", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Verifikasi dua langkah" }),
  ).toBeVisible();
  expect((await context.request.get(`${origin}/api/v1/account`)).status()).toBe(
    401,
  );
  await page.getByLabel("Kode autentikator atau pemulihan").fill(recovery);
  await page.getByRole("button", { name: "Verifikasi", exact: true }).click();
  await expect(page.getByText("Browser Operator")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Aktifkan autentikasi dua langkah" }),
  ).toHaveCount(0);
  const session = (await context.cookies()).find(
    (cookie) => cookie.name === "__Host-relay_session",
  );
  assert.ok(session?.httpOnly && session.secure);
  await page.reload();
  await expect(page.getByText("Browser Operator")).toBeVisible();
  await page.getByRole("button", { name: "Keluar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Masuk", exact: true }),
  ).toBeVisible();
  expect(
    (
      await context.request.get(`${origin}/api/v1/account`, {
        headers: { cookie: `${session.name}=${session.value}` },
      })
    ).status(),
  ).toBe(401);
});

test("staging server list shows only owned or shared rows and never falls back to demo", async ({
  page,
  context,
}) => {
  test.skip(
    process.env.RELAY_BROWSER_AUTH_CI !== "1",
    "Disposable staging only",
  );
  test.setTimeout(60_000);
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  const origin = "https://127.0.0.1:4443";
  const password = `Fixture-${randomUUID()}`;
  const ids = Array.from({ length: 3 }, () => randomUUID());
  const emails = ids.map((id) => `${id}@example.test`);
  const server = randomUUID();
  const pool = stagingPool();
  try {
    const hash = await passwordHash(password);
    for (const [i, id] of ids.entries())
      await pool.execute(
        "INSERT INTO users(id,email,display_name,password_hash) VALUES (?,?,?,?)",
        [id, emails[i], `Inventory operator ${i}`, hash],
      );
    const node = randomUUID(),
      nest = randomUUID(),
      egg = randomUUID();
    await pool.execute(
      "INSERT INTO nodes (id,name,origin,token_id,token_cipher) VALUES (?, 'Fixture node', ?, ?, X'00')",
      [node, `https://${node}.example.test`, node],
    );
    await pool.execute("INSERT INTO nests VALUES (?,?)", [nest, nest]);
    await pool.execute(
      "INSERT INTO eggs VALUES (?,?,'Fixture egg','PTDL_v2',X'00')",
      [egg, nest],
    );
    for (const [i, name] of [
      "Staging shared workload",
      "Staging private workload",
    ].entries()) {
      const allocation = randomUUID();
      await pool.execute(
        "INSERT INTO allocations (id,node_id,ip,port) VALUES (?,?,'127.0.0.1',?)",
        [allocation, node, 25500 + i],
      );
      await pool.execute(
        "INSERT INTO servers(id,name,node_id,owner_id,egg_id,allocation_id) VALUES (?,?,?,?,?,?)",
        [i === 0 ? server : randomUUID(), name, node, ids[0], egg, allocation],
      );
    }
    await pool.execute(
      "INSERT INTO server_grants VALUES (?,?,JSON_ARRAY('activity.read')), (?,?,JSON_ARRAY())",
      [server, ids[1], server, ids[2]],
    );
  } finally {
    await pool.end();
  }
  expect((await context.request.get(`${origin}/api/v1/servers`)).status()).toBe(
    401,
  );
  for (const [i, email] of emails.entries()) {
    await page.goto(`${origin}/#authView`);
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Kata sandi", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Masuk", exact: true }).click();
    await page.getByRole("button", { name: "Muat daftar server" }).click();
    const list = page.getByRole("list", { name: "Server yang dapat diakses" });
    if (i === 2) {
      await expect(
        page.getByText("Tidak ada server yang dapat diakses."),
      ).toBeVisible();
      await expect(list).toHaveCount(0);
    } else {
      await expect(list.getByRole("listitem")).toHaveCount(i === 0 ? 2 : 1);
      await expect(list.getByText("Staging shared workload")).toBeVisible();
      await expect(list.getByText("Staging private workload")).toHaveCount(
        i === 0 ? 1 : 0,
      );
    }

    expect(
      (
        await context.request.get(`${origin}/api/v1/servers/${server}/activity`)
      ).status(),
    ).toBe(i === 2 ? 404 : 200);
    await page.getByRole("button", { name: "Keluar", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Masuk", exact: true }),
    ).toBeVisible();
  }
});
