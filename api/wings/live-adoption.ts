import { applyLegacyFixture } from "../import/legacy-fixture-apply";
import { legacyPreflight } from "../import/legacy-preflight";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import Fastify from "fastify";
import { createApp } from "../app";
import { rows, stagingPool } from "../db";
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
  const relay = await createApp({
    pool,
    origin: "https://relay.example.test",
    key: randomBytes(32),
    pepper,
    catalogNodeKey: key,
    allowedCatalogNodeOrigins: [node.origin],
    wingsTestNode: node,
    enableDisposableProvisioning: true,
    deliverReset: async () => {},
  });
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
    await docker(
      "docker",
      ["restart", "--time", "10", "relay-wings-contract"],
      { timeout: 20000 },
    );
    await until("running workload rediscovery", async () =>
      (await Promise.all(workloadIds.map((id) => client.state(id)))).every(
        (state) => state === "running",
      ),
    );
  };
  const checksum = async (id = uuid) =>
    createHash("sha256")
      .update(await client.readFixtureFile(id, "relay-start.sh"))
      .digest("hex");
  try {
    await migrate(pool, "up");
    if (!actual) await legacy.listen({ host: "127.0.0.1", port: 13202 });
    await relay.listen({ host: "127.0.0.1", port: 13200 });
    await until("source Wings health", async () =>
      Boolean(await client.health()),
    );
    for (const [index, id] of workloadIds.entries()) {
      if (actual) await client.reinstall(id);
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
      const { stdout } = await docker(
        "docker",
        [
          "exec",
          "relay-adoption-panel",
          "php",
          "/tmp/relay-fixture.php",
          "manifest",
        ],
        { timeout: 5000, maxBuffer: 65536 },
      );
      manifest = JSON.parse(stdout);
      const report = legacyPreflight(manifest);
      assert.deepEqual(report.counts, {
        servers: 2,
        users: 1,
        nodes: 1,
        nests: 1,
        eggs: 2,
        allocations: 2,
        subusers: 0,
      });
      assert.deepEqual(report.servers, [
        { uuid, ownerId: owner, nodeId, eggId: egg, nestId: nest, port: 25610 },
        {
          uuid: second,
          ownerId: owner,
          nodeId,
          eggId: secondEgg,
          nestId: nest,
          port: 25611,
        },
      ]);
    }
    for (const id of workloadIds) await client.power(id, "start");
    await until("source running", async () =>
      (await Promise.all(workloadIds.map((id) => client.state(id)))).every(
        (state) => state === "running",
      ),
    );
    const before = await Promise.all(workloadIds.map(inspect)),
      hash = await Promise.all(workloadIds.map(checksum));
    if (actual) {
      assert.ok(second);
      const credentials = {
        node,
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
      ])
        assert.deepEqual(
          await rows(pool, `SELECT COUNT(*) AS total FROM ${table}`),
          [
            {
              total: [
                "eggs",
                "allocations",
                "servers",
                "wings_provisions",
              ].includes(table)
                ? 2
                : 1,
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
    const original = await readFile(config, "utf8");
    assert.equal(original.split("remote: http://127.0.0.1:13202").length, 2);
    await copyFile(config, `${config}.backup`);
    await writeFile(
      config,
      original.replace(
        "remote: http://127.0.0.1:13202",
        "remote: http://127.0.0.1:13200",
      ),
    );
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
      await client.power(id, "stop");
      await until(
        "fixture stop",
        async () => (await client.state(id)) === "offline",
      );
      await client.remove(id);
    }
    console.log(
      "Remote cutover and rollback preserved existing UUID, file and running container",
    );
  } finally {
    await relay.close();
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
