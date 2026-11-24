import { reviewedHttpEggs } from "../eggs/reviewed-workload";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WingsSocket } from "./socket";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../app";
import { rows, stagingPool } from "../db";
import { migrate } from "../migrate";
import { passwordHash } from "../security";
import { WingsClient, type WingsNode } from "./client";
import { disposableEgg } from "./provision";

async function until(
  label: string,
  condition: () => boolean | Promise<boolean>,
) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`::error::Contract did not reach ${label}`);
}
async function main() {
  if (
    process.env.RELAY_DISPOSABLE_WINGS_CI !== "1" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    !process.env.RELAY_STAGING_DATABASE_URL?.endsWith("/relay_test")
  )
    throw new Error("Disposable CI only");
  const node: WingsNode = {
    origin: "http://127.0.0.1:18080",
    tokenId: process.env.RELAY_WINGS_TEST_TOKEN_ID ?? "",
    token: process.env.RELAY_WINGS_TEST_TOKEN ?? "",
  };
  const pool = stagingPool();
  const origin = "https://relay.example.test";
  const app = await createApp({
    pool,
    origin,
    key: randomBytes(32),
    pepper: randomBytes(32),
    catalogNodeKey: randomBytes(32),
    allowedCatalogNodeOrigins: [node.origin],
    wingsTestNode: node,
    enableDisposableProvisioning: true,
    deliverReset: async () => {},
  });
  try {
    await migrate(pool, "up");
    const id = randomUUID(),
      password = randomBytes(24).toString("hex");
    await pool.execute(
      "INSERT INTO users (id,email,display_name,password_hash,is_admin) VALUES (?,?,?,?,1)",
      [
        id,
        "contract@example.test",
        "Contract operator",
        await passwordHash(password),
      ],
    );
    await app.listen({ host: "127.0.0.1", port: 13200 });
    const headers = { origin, "x-relay-request": "1" };
    const logged = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers,
      payload: { email: "contract@example.test", password },
    });
    assert.equal(logged.statusCode, 200, "admin fixture login");
    const session = logged.cookies.find(
      (cookie) => cookie.name === "__Host-relay_session",
    );
    assert.ok(session);
    const admin = (method: "GET" | "POST", path: string, payload?: object) =>
      app.inject({
        method,
        url: `/api/v1/admin/${path}`,
        headers: { ...headers, cookie: `${session.name}=${session.value}` },
        payload,
      });
    const add = async (path: string, payload: object) => {
      const result = await admin("POST", path, payload);
      assert.equal(result.statusCode, 201, `catalog ${path}: ${result.body}`);
      return result.json<{ id: string }>().id;
    };
    const nodeId = await add("nodes", { ...node, name: "Disposable Wings" });
    const nestId = await add("nests", { name: "Disposable fixture" });
    const eggId = await add("eggs", { nestId, document: disposableEgg });
    const allocationId = await add("allocations", {
      nodeId,
      ip: "127.0.0.1",
      port: 25610,
    });
    const uuid = await add("servers", {
      name: "Catalog contract workload",
      nodeId,
      eggId,
      allocationId,
      ownerId: id,
    });
    const client = new WingsClient(node);
    await until("Wings health", async () => {
      try {
        await client.health();
        return true;
      } catch {
        return false;
      }
    });
    const anonymous = await fetch(`${node.origin}/api/system`, {
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(anonymous.status, 401);
    await anonymous.body?.cancel();
    const phase = async () => {
      const result = await admin("GET", `servers/${uuid}/provision`);
      assert.equal(result.statusCode, 200);
      return result.json<{ phase: string }>().phase;
    };
    assert.equal(await phase(), "draft");
    const remoteAuth = {
      authorization: `Bearer ${node.tokenId}.${node.token}`,
    };
    const remote = (path: string) =>
      app.inject({ url: `/api/remote/${path}`, headers: remoteAuth });
    assert.equal((await remote(`servers/${uuid}`)).statusCode, 404);
    assert.equal(
      (await admin("POST", `servers/${uuid}/provision`, { confirm: false }))
        .statusCode,
      400,
    );
    // Concurrent requests may race, but only one may dispatch a create.
    const dispatch = await Promise.all([
      admin("POST", `servers/${uuid}/provision`, { confirm: true }),
      admin("POST", `servers/${uuid}/provision`, { confirm: true }),
    ]);
    assert.deepEqual(
      dispatch.map((r) => r.statusCode).sort(),
      [202, 409],
      dispatch.map((r) => r.body).join(" | "),
    );
    await until("persisted installation callback", async () => {
      const current = await phase();
      assert.notEqual(current, "install_failed");
      return current === "installed";
    });
    const listed = await remote("servers?page=0&per_page=50");
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(
      listed.json().data.map((server: { uuid: string }) => server.uuid),
      [uuid],
    );
    // A delayed negative callback must not overwrite an installed terminal result.
    const repeated = await app.inject({
      method: "POST",
      url: `/api/remote/servers/${uuid}/install`,
      headers: remoteAuth,
      payload: { successful: false, reinstall: false },
    });
    assert.equal(repeated.statusCode, 204);
    assert.equal(await phase(), "installed");
    const sample = await admin("GET", `servers/${uuid}/stats`);
    assert.equal(sample.statusCode, 200, sample.body);
    assert.deepEqual(
      Object.keys(sample.json()).sort(),
      [
        "cpuAbsolute",
        "diskBytes",
        "memoryBytes",
        "memoryLimitBytes",
        "rxBytes",
        "txBytes",
        "uptimeMs",
      ].sort(),
    );
    await assert.rejects(
      new WingsSocket(node, "https://rejected.example.test").stats(uuid, id),
      { reason: "transport" },
    );
    const runtime = async () => {
      const res = await admin("GET", `servers/${uuid}/runtime`);
      assert.equal(res.statusCode, 200);
      return res.json<{ state: string | null; presence: string }>();
    };
    const power = (action: "start" | "stop", confirm = true) =>
      admin("POST", `servers/${uuid}/power`, { action, confirm });
    const consoleSnapshot = async () => {
      const result = await admin("GET", `servers/${uuid}/console`);
      assert.equal(result.statusCode, 200, result.body);
      return result.json<{ lines: string[]; truncated: boolean }>();
    };
    assert.deepEqual(await consoleSnapshot(), { lines: [], truncated: false });
    assert.equal((await runtime()).state, "offline");
    assert.equal((await power("start", false)).statusCode, 400);
    assert.equal((await power("start")).statusCode, 202);
    await until(
      "running state via admin API",
      async () => (await runtime()).state === "running",
    );
    const replay = await consoleSnapshot();
    assert.ok(
      replay.lines.includes("RELAY_CONTRACT_READY"),
      "actual Wings console marker",
    );
    assert.ok(replay.lines.every((line) => line === "RELAY_CONTRACT_READY"));
    assert.equal(
      (await admin("POST", `servers/${uuid}/delete`, { confirm: true }))
        .statusCode,
      409,
    );
    assert.equal(
      (await admin("POST", `servers/${uuid}/reinstall`, { confirm: true }))
        .statusCode,
      409,
    );
    // The engine preserves the already-running workload. Restart only the Wings control container.
    const docker = promisify(execFile);
    const inspect = async () => {
      const result = await docker(
        "docker",
        [
          "inspect",
          "--type",
          "container",
          "--format",
          "{{.Id}} {{.State.StartedAt}}",
          uuid,
        ],
        { timeout: 5000 },
      );
      return result.stdout.trim();
    };
    const original = await inspect();
    await docker(
      "docker",
      ["restart", "--time", "10", "relay-wings-contract"],
      { timeout: 20000 },
    );
    await until("Wings to rediscover already-running workload", async () => {
      try {
        return (await client.state(uuid)) === "running";
      } catch {
        return false;
      }
    });
    assert.equal(
      await inspect(),
      original,
      "Wings restart must not recreate or restart the workload container",
    );
    assert.equal(await phase(), "installed");
    assert.deepEqual(
      await rows<{ total: number }>(
        pool,
        "SELECT COUNT(*) AS total FROM audit_log WHERE subject_id=? AND event='wings.installed'",
        [uuid],
      ),
      [{ total: 1 }],
    );
    assert.equal((await power("stop")).statusCode, 202);
    await until(
      "offline state via admin API",
      async () => (await runtime()).state === "offline",
    );
    const action = (name: "reinstall" | "delete", confirm = true) =>
      admin("POST", `servers/${uuid}/${name}`, { confirm });
    assert.equal((await action("reinstall", false)).statusCode, 400);
    const reinstall = await action("reinstall");
    assert.equal(reinstall.statusCode, 202, reinstall.body);
    await until("persisted reinstall callback", async () => {
      const current = await phase();
      assert.notEqual(current, "install_failed");
      return current === "installed";
    });
    assert.deepEqual(
      await rows<{ total: number }>(
        pool,
        "SELECT COUNT(*) AS total FROM audit_log WHERE subject_id=? AND event='wings.installed'",
        [uuid],
      ),
      [{ total: 2 }],
    );
    assert.equal((await runtime()).state, "offline");
    assert.equal((await action("delete", false)).statusCode, 400);
    const deletion = await action("delete");
    assert.equal(deletion.statusCode, 202, deletion.body);
    assert.equal(await phase(), "deleted");
    assert.equal((await action("delete")).statusCode, 409);
    await assert.rejects(client.state(uuid), { reason: "not_found" });
    assert.equal((await remote(`servers/${uuid}`)).statusCode, 404);
    const after = await remote("servers?page=0&per_page=50");
    assert.deepEqual(after.json().data, []);
    for (const [index, document] of reviewedHttpEggs.entries()) {
      const eggId = await add("eggs", { nestId, document });
      const attachment = await admin("GET", `eggs/${eggId}/document`);
      assert.equal(attachment.statusCode, 200);
      assert.equal(attachment.body, document);
      const port = 25611 + index;
      const allocationId = await add("allocations", {
        nodeId,
        ip: "127.0.0.1",
        port,
      });
      const serverId = await add("servers", {
        name: `Reviewed HTTP ${index + 1}`,
        nodeId,
        eggId,
        allocationId,
        ownerId: id,
      });
      const provision = await admin("POST", `servers/${serverId}/provision`, {
        confirm: true,
      });
      assert.equal(provision.statusCode, 202, provision.body);
      await until(`HTTP egg ${index + 1} installation`, async () => {
        const [record] = await rows<{ phase: string }>(
          pool,
          "SELECT phase FROM wings_provisions WHERE server_id=?",
          [serverId],
        );
        assert.notEqual(record?.phase, "install_failed");
        return record?.phase === "installed";
      });
      const start = await admin("POST", `servers/${serverId}/power`, {
        confirm: true,
        action: "start",
      });
      assert.equal(start.statusCode, 202, start.body);
      await until(`HTTP egg ${index + 1} response`, async () => {
        try {
          const { stdout } = await docker(
            "docker",
            ["exec", serverId, "wget", "-qO-", `http://127.0.0.1:${port}/`],
            { timeout: 2000 },
          );
          return stdout.trim() === "RELAY_REVIEWED_EGG_HTTP";
        } catch {
          return false;
        }
      });
      assert.equal(
        (
          await admin("POST", `servers/${serverId}/power`, {
            confirm: true,
            action: "stop",
          })
        ).statusCode,
        202,
      );
      await until(
        `HTTP egg ${index + 1} offline`,
        async () => (await client.state(serverId)) === "offline",
      );
      assert.equal(
        (await admin("POST", `servers/${serverId}/delete`, { confirm: true }))
          .statusCode,
        202,
      );
    }
    console.log(
      "Real Wings verified via admin: create, install, start, stop, reinstall and delete",
    );
  } finally {
    await app.close();
    await pool.end();
  }
}
void main().catch((error) => {
  console.error(
    `::error::${error instanceof Error ? error.message : "Wings integration failed"}`,
  );
  process.exitCode = 1;
});
