import { applyLegacyFixture } from "../import/legacy-fixture-apply";
import { readLegacySnapshot } from "../import/legacy-snapshot";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import Fastify from "fastify";
import { createApp } from "../app";
import { rows, stagingPool } from "../db";
import { canServer } from "../policy";
import { migrate } from "../migrate";
import { cryptoContext } from "../security";
import { WingsClient } from "./client";
import { lifecycleFixture } from "./lifecycle-fixture";
import { disposableEgg } from "./provision";
import { registerRemote } from "./remote";

async function until(label: string, action: () => Promise<boolean>) {
  for (let i = 0; i < 40; i++) {
    try {
      if (await action()) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`Adoption fixture did not reach ${label}`);
}
async function main() {
  const config = process.env.RELAY_ADOPTION_FIXTURE_CONFIG;
  if (
    process.env.RELAY_DISPOSABLE_WINGS_CI !== "1" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    process.env.GITHUB_EVENT_NAME !== "push" ||
    !process.env.RELAY_STAGING_DATABASE_URL?.endsWith("/relay_test") ||
    !config ||
    !/^\/tmp\/tmp\.[A-Za-z0-9]+\/config\/config\.yml$/.test(config)
  )
    throw new Error("Disposable CI only");
  const node = {
    origin: "http://127.0.0.1:18080",
    tokenId: process.env.RELAY_WINGS_TEST_TOKEN_ID ?? "",
    token: process.env.RELAY_WINGS_TEST_TOKEN ?? "",
  };
  const client = new WingsClient(node);
  const pool = stagingPool(),
    pepper = randomBytes(32),
    key = randomBytes(32);
  const actual = process.env.RELAY_BOOTSTRAP_SCENARIO === "legacy-panel";
  const legacyId = (name: string) => {
    const value = actual
      ? process.env[`RELAY_ADOPTION_${name}_UUID`]
      : randomUUID();
    assert.match(value ?? "", /^[0-9a-f-]{36}$/);
    return value as string;
  };
  const uuid = legacyId("SERVER"),
    egg = legacyId("EGG"),
    owner = legacyId("OWNER"),
    nest = legacyId("NEST");
  const nodeId = "3ab63670-f83b-4a2c-adeb-5b2852859319",
    allocation = randomUUID();
  const second = actual ? legacyId("SECOND") : undefined;
  const secondEgg = actual ? legacyId("SECOND_EGG") : undefined;
  const secondNodeId = "33113cc5-78fb-4cd0-881b-326c3888b38b";
  const secondNode = {
    origin: "http://127.0.0.1:18081",
    tokenId: process.env.RELAY_SECOND_NODE_TOKEN_ID ?? "",
    token: process.env.RELAY_SECOND_NODE_TOKEN ?? "",
  };
  const secondConfig = process.env.RELAY_ADOPTION_SECOND_CONFIG;
  if (
    actual &&
    secondConfig !== config.replace("/config/config.yml", "/config2/config.yml")
  )
    throw new Error("Invalid second fixture config");
  const secondClient = actual ? new WingsClient(secondNode) : undefined;
  const clientFor = (id: string) =>
    id === second && secondClient ? secondClient : client;
  const secondAllocation = randomUUID();
  const workloadIds = second ? [uuid, second] : [uuid];
  const name = "Existing staging workload";
  let installed = 0,
    ready = false,
    legacyCalls = 0;
  const fixture = lifecycleFixture(
    (result) => {
      assert.equal(result.successful, true);
      assert.equal(result.reinstall, false);
      installed++;
      ready = true;
    },
    { uuid, eggId: egg, name, port: 25610 },
  );
  // Separate source-controller simulation; no legacy PHP application or production data.
  const legacy = Fastify({ logger: false });
  await legacy.register(
    async (instance) => {
      instance.addHook("onRequest", async () => {
        legacyCalls++;
      });
      await registerRemote(instance, node, fixture, {
        lookup: async (id) => (id === uuid ? fixture : undefined),
        list: async () =>
          ready
            ? { total: 1, data: [{ uuid, ...fixture.configuration }] }
            : { total: 0, data: [] },
      });
    },
    { prefix: "/api/remote" },
  );
  const relayFor = (configured: typeof node) =>
    createApp({
      pool,
      origin: "https://relay.example.test",
      key: randomBytes(32),
      pepper,
      catalogNodeKey: key,
      allowedCatalogNodeOrigins: [configured.origin],
      wingsTestNode: configured,
      enableDisposableProvisioning: true,
      deliverReset: async () => {},
    });
  const relay = await relayFor(node);
  const relay2 = actual ? await relayFor(secondNode) : undefined;
  const docker = promisify(execFile);
  const legacyStatus = async (which = "first") =>
    JSON.parse(
      (
        await docker(
          "docker",
          [
            "exec",
            "relay-adoption-panel",
            "php",
            "/tmp/relay-fixture.php",
            "status",
            which,
          ],
          { timeout: 5000 },
        )
      ).stdout,
    ) as { status: string | null; installed_at: string | null };
  const inspect = async (id = uuid) =>
    (
      await docker(
        "docker",
        ["inspect", "--format", "{{.Id}} {{.State.StartedAt}}", "--", id],
        { timeout: 5000 },
      )
    ).stdout.trim();
  const restart = async () => {
    for (const container of actual
      ? ["relay-wings-contract", "relay-wings-adoption-second"]
      : ["relay-wings-contract"]) {
      await docker("docker", ["restart", "--time", "10", container], {
        timeout: 20000,
      });
    }
    await until("running workload rediscovery", async () =>
      (
        await Promise.all(workloadIds.map((id) => clientFor(id).state(id)))
      ).every((state) => state === "running"),
    );
  };
  const checksum = async (id = uuid) =>
    createHash("sha256")
      .update(await clientFor(id).readFixtureFile(id, "relay-start.sh"))
      .digest("hex");
  try {
    await migrate(pool, "up");
    if (!actual) await legacy.listen({ host: "127.0.0.1", port: 13202 });
    await relay.listen({ host: "127.0.0.1", port: 13200 });
    if (relay2) await relay2.listen({ host: "127.0.0.1", port: 13201 });
    await until(
      "source Wings health",
      async () =>
        Boolean(await client.health()) &&
        (!secondClient || Boolean(await secondClient.health())),
    );
    for (const [index, id] of workloadIds.entries()) {
      if (actual) await clientFor(id).reinstall(id);
      else await client.create(id);
      await until("legacy fixture installation", async () => {
        if (!actual) return ready;
        const status = await legacyStatus(index === 0 ? "first" : "second");
        return Boolean(status.installed_at && status.status === null);
      });
    }
    const legacyBefore = actual
      ? await Promise.all([legacyStatus(), legacyStatus("second")])
      : undefined;
    let manifest: unknown;
    if (actual) {
      // Copy the real Panel database after both installs settle. Keep the dump in the pipe.
      await docker("bash", ["scripts/legacy-snapshot-ci.sh"], {
        timeout: 30000,
      });
      const snapshot = await readLegacySnapshot(
        process.env.RELAY_LEGACY_SNAPSHOT_URL ?? "",
      );
      manifest = snapshot.manifest;
      const { report } = snapshot;
      assert.deepEqual(report.counts, {
        servers: 2,
        users: 3,
        nodes: 2,
        nests: 1,
        eggs: 2,
        allocations: 2,
        subusers: 1,
      });
      assert.deepEqual(report.servers, [
        { uuid, ownerId: owner, nodeId, eggId: egg, nestId: nest, port: 25610 },
        {
          uuid: second,
          ownerId: owner,
          nodeId: secondNodeId,
          eggId: secondEgg,
          nestId: nest,
          port: 25611,
        },
      ]);
    }
    for (const id of workloadIds) await clientFor(id).power(id, "start");
    await until("source running", async () =>
      (
        await Promise.all(workloadIds.map((id) => clientFor(id).state(id)))
      ).every((state) => state === "running"),
    );
    const before = await Promise.all(workloadIds.map(inspect)),
      hash = await Promise.all(workloadIds.map(checksum));
    if (actual) {
      assert.ok(second);
      const collaborator = process.env.RELAY_ADOPTION_COLLABORATOR_UUID;
      const outsider = process.env.RELAY_ADOPTION_OUTSIDER_UUID;
      assert.ok(collaborator && outsider);
      const credentials = {
        collaborator,
        outsider,
        nodes: new Map([
          [nodeId, node],
          [secondNodeId, secondNode],
        ]),
        key,
        pepper,
        allocations: new Map([
          [uuid, allocation],
          [second, secondAllocation],
        ]),
      };
      await assert.rejects(
        applyLegacyFixture(pool, manifest, {
          ...credentials,
          allocations: new Map([
            [uuid, allocation],
            [second, allocation],
          ]),
        }),
        { code: "ER_DUP_ENTRY" },
      );
      for (const table of [
        "users",
        "nests",
        "eggs",
        "nodes",
        "allocations",
        "servers",
        "wings_provisions",
        "server_grants",
      ])
        assert.deepEqual(
          await rows(pool, `SELECT COUNT(*) AS total FROM ${table}`),
          [{ total: 0 }],
        );
      assert.equal(
        (await applyLegacyFixture(pool, manifest, credentials)).applied,
        true,
      );
      assert.equal(
        (await applyLegacyFixture(pool, manifest, credentials)).applied,
        false,
      );
      const [saved] = await rows<{
        user: string;
        server: string;
        permissions: string[] | string;
      }>(
        pool,
        "SELECT user_id AS user,server_id AS server,permissions FROM server_grants",
      );
      const grant = {
        ...saved,
        permissions:
          typeof saved.permissions === "string"
            ? JSON.parse(saved.permissions)
            : saved.permissions,
      };
      const actor = {
        id: collaborator,
        admin: false,
        channel: "session" as const,
      };
      assert.ok(canServer(actor, { id: uuid, owner }, grant, "control.start"));
      assert.equal(
        canServer(actor, { id: uuid, owner }, grant, "control.stop"),
        false,
      );
      assert.equal(
        canServer(actor, { id: second, owner }, grant, "control.start"),
        false,
      );
      assert.equal(
        canServer(
          { ...actor, id: outsider },
          { id: uuid, owner },
          grant,
          "control.start",
        ),
        false,
      );
      await assert.rejects(
        applyLegacyFixture(pool, manifest, {
          ...credentials,
          allocations: new Map([
            [uuid, allocation],
            [second, randomUUID()],
          ]),
        }),
        /conflicts with import/,
      );
      for (const table of [
        "users",
        "nests",
        "eggs",
        "nodes",
        "allocations",
        "servers",
        "wings_provisions",
        "server_grants",
      ])
        assert.deepEqual(
          await rows(pool, `SELECT COUNT(*) AS total FROM ${table}`),
          [
            {
              total:
                table === "users"
                  ? 3
                  : ["nests", "server_grants"].includes(table)
                    ? 1
                    : 2,
            },
          ],
        );
    } else {
      await pool.execute(
        "INSERT INTO users (id,email,display_name,password_hash) VALUES (?,'adoption@example.test','Fixture','disabled')",
        [owner],
      );
      await pool.execute(
        "INSERT INTO nests (id,name) VALUES (?,'Adoption fixture')",
        [nest],
      );
      await pool.execute(
        "INSERT INTO eggs (id,nest_id,name,version,document) VALUES (?,?,'Fixture','PTDL_v2',?)",
        [egg, nest, Buffer.from(disposableEgg)],
      );
      await pool.execute(
        "INSERT INTO nodes (id,name,origin,token_id,token_cipher) VALUES (?,'Existing node',?,?,?)",
        [
          nodeId,
          node.origin,
          node.tokenId,
          cryptoContext(key, pepper, "node-token").seal(
            Buffer.from(node.token),
            nodeId,
          ),
        ],
      );
      await pool.execute(
        "INSERT INTO allocations (id,node_id,ip,port) VALUES (?,?,'127.0.0.1',25610)",
        [allocation, nodeId],
      );
      await pool.execute(
        "INSERT INTO servers (id,name,node_id,owner_id,egg_id,allocation_id) VALUES (?,?,?,?,?,?)",
        [uuid, name, nodeId, owner, egg, allocation],
      );
      await pool.execute(
        "INSERT INTO wings_provisions (server_id,phase) VALUES (?,'installed')",
        [uuid],
      );
    }
    const setRemote = async (file: string, port: number) => {
      const original = await readFile(file, "utf8");
      assert.equal(original.split("remote: http://127.0.0.1:13202").length, 2);
      await copyFile(file, `${file}.backup`);
      await writeFile(
        file,
        original.replace(
          "remote: http://127.0.0.1:13202",
          `remote: http://127.0.0.1:${port}`,
        ),
      );
    };
    await setRemote(config, 13200);
    if (actual && secondConfig && relay2) {
      await setRemote(secondConfig, 13201);
      const auth = (n: typeof node) => ({
        authorization: `Bearer ${n.tokenId}.${n.token}`,
      });
      for (const [app, own, other, server, foreign] of [
        [relay, node, secondNode, uuid, second],
        [relay2, secondNode, node, second, uuid],
      ] as const) {
        const list = await app.inject({
          url: "/api/remote/servers?page=0",
          headers: auth(own),
        });
        assert.equal(list.statusCode, 200);
        assert.deepEqual(
          list.json().data.map((item: { uuid: string }) => item.uuid),
          [server],
        );
        assert.equal(
          (
            await app.inject({
              url: `/api/remote/servers/${foreign}`,
              headers: auth(own),
            })
          ).statusCode,
          404,
        );
        assert.equal(
          (
            await app.inject({
              url: `/api/remote/servers/${server}`,
              headers: auth(other),
            })
          ).statusCode,
          401,
        );
      }
    }
    const calls = legacyCalls;
    await restart();
    assert.equal(legacyCalls, calls);
    assert.deepEqual(await Promise.all(workloadIds.map(inspect)), before);
    assert.deepEqual(await Promise.all(workloadIds.map(checksum)), hash);
    assert.deepEqual(
      await rows(pool, "SELECT phase FROM wings_provisions WHERE server_id=?", [
        uuid,
      ]),
      [{ phase: "installed" }],
    );
    assert.deepEqual(
      await rows(pool, "SELECT event FROM audit_log WHERE subject_id=?", [
        uuid,
      ]),
      [],
    );
    await copyFile(`${config}.backup`, config);
    if (actual && secondConfig)
      await copyFile(`${secondConfig}.backup`, secondConfig);
    await restart();
    if (actual)
      assert.deepEqual(
        await Promise.all([legacyStatus(), legacyStatus("second")]),
        legacyBefore,
      );
    else assert.ok(legacyCalls > calls);
    assert.deepEqual(await Promise.all(workloadIds.map(inspect)), before);
    assert.deepEqual(await Promise.all(workloadIds.map(checksum)), hash);
    if (!actual) assert.equal(installed, 1);
    for (const id of workloadIds) {
      await clientFor(id).power(id, "stop");
      await until(
        "fixture stop",
        async () => (await clientFor(id).state(id)) === "offline",
      );
      await clientFor(id).remove(id);
    }
    console.log(
      "Remote cutover and rollback preserved existing UUID, file and running container",
    );
  } finally {
    await relay.close();
    await relay2?.close();
    await legacy.close();
    await pool.end();
  }
}
void main().catch((error) => {
  console.error(
    `::error::${error instanceof Error ? error.message : "Adoption contract failed"}`,
  );
  process.exitCode = 1;
});
