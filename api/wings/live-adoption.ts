import { createRequire } from "node:module";
import { legacyPreflight } from "../import/legacy-preflight";
import { stagingMail } from "../staging-mail";
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
  const browser = actual && process.env.RELAY_WINGS_BROWSER === "1";
  const origin = browser
    ? "https://127.0.0.1:4443"
    : "https://relay.example.test";
  const mail = stagingMail(origin);
  const relayFor = (configured: typeof node) =>
    createApp({
      pool,
      origin,
      key: randomBytes(32),
      pepper,
      catalogNodeKey: key,
      allowedCatalogNodeOrigins: [configured.origin],
      wingsTestNode: configured,
      enableDisposableProvisioning: true,
      deliverReset: mail.deliverReset,
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
        allocations: 3,
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
      const { secondaryAllocations } = legacyPreflight(manifest);
      assert.equal(secondaryAllocations.length, 1);
      const secondaryId = randomUUID();
      const credentials = {
        secondaryAllocations: new Map([
          [secondaryAllocations[0].legacyId, secondaryId],
        ]),
        accounts: new Map([
          [owner, "adoption@example.test"],
          [collaborator, "collaborator@example.test"],
          [outsider, "outsider@example.test"],
        ]),
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
      // Exercise a larger catalog batch without claiming a third live Wings workload.
      const expanded = structuredClone(manifest) as Record<
        string,
        Record<string, unknown>[]
      >;
      const extra = randomUUID();
      const template = expanded.servers[0];
      const otherOwner = expanded.users.find((row) => row.uuid === outsider);
      const otherGrant = expanded.users.find(
        (row) => row.uuid === collaborator,
      );
      assert.ok(otherOwner && otherGrant);
      const nextId = (table: string) =>
        Math.max(0, ...expanded[table].map((row) => Number(row.id))) + 1;
      const extraId = nextId("servers"),
        extraAllocation = nextId("allocations");
      expanded.servers.push({
        ...template,
        id: extraId,
        uuid: extra,
        owner_id: otherOwner.id,
        allocation_id: extraAllocation,
      });
      expanded.allocations.push({
        id: extraAllocation,
        node_id: template.node_id,
        server_id: extraId,
        ip: "127.0.0.1",
        port: 25612,
      });
      expanded.subusers.push({
        id: nextId("subusers"),
        user_id: otherGrant.id,
        server_id: extraId,
        permissions: ["activity.read"],
      });
      const expandedCredentials = {
        ...credentials,
        allocations: new Map([
          ...credentials.allocations,
          [extra, randomUUID()],
        ]),
      };
      assert.equal(
        (await applyLegacyFixture(pool, expanded, expandedCredentials)).applied,
        true,
      );
      assert.equal(
        (await applyLegacyFixture(pool, expanded, expandedCredentials)).applied,
        false,
      );
      assert.deepEqual(
        await rows(pool, "SELECT owner_id FROM servers WHERE id=?", [extra]),
        [{ owner_id: outsider }],
      );
      assert.deepEqual(
        await rows(
          pool,
          "SELECT user_id FROM server_grants WHERE server_id=?",
          [extra],
        ),
        [{ user_id: collaborator }],
      );
      for (const table of [
        "server_secondary_allocations",
        "server_grants",
        "wings_provisions",
        "servers",
        "allocations",
        "eggs",
        "nests",
        "nodes",
        "users",
      ])
        await pool.execute(`DELETE FROM ${table}`);
      await assert.rejects(
        applyLegacyFixture(pool, manifest, {
          ...credentials,
          secondaryAllocations: new Map([
            [secondaryAllocations[0].legacyId, allocation],
          ]),
        }),
        { code: "ER_DUP_ENTRY" },
      );
      assert.deepEqual(
        await rows(pool, "SELECT COUNT(*) AS total FROM servers"),
        [{ total: 0 }],
      );
      assert.deepEqual(
        await rows(pool, "SELECT COUNT(*) AS total FROM allocations"),
        [{ total: 0 }],
      );
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
        "server_secondary_allocations",
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
      assert.deepEqual(
        await rows(
          pool,
          "SELECT x.server_id,a.ip,a.port FROM server_secondary_allocations x JOIN allocations a ON a.id=x.allocation_id WHERE x.allocation_id=?",
          [secondaryId],
        ),
        [{ server_id: uuid, ip: "127.0.0.2", port: 25616 }],
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
      await pool.execute(
        "UPDATE server_grants SET permissions=JSON_ARRAY('control.stop') WHERE server_id=? AND user_id=?",
        [uuid, collaborator],
      );
      await assert.rejects(
        applyLegacyFixture(pool, manifest, credentials),
        /grants conflict/,
      );
      const [changed] = await rows<{ matches: number }>(
        pool,
        "SELECT JSON_CONTAINS(permissions, JSON_QUOTE('control.stop')) AS matches FROM server_grants WHERE server_id=? AND user_id=?",
        [uuid, collaborator],
      );
      assert.equal(changed.matches, 1);
      await pool.execute(
        "UPDATE server_grants SET permissions=JSON_ARRAY('activity.read','control.start') WHERE server_id=? AND user_id=?",
        [uuid, collaborator],
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
        "server_secondary_allocations",
        "server_grants",
      ])
        assert.deepEqual(
          await rows(pool, `SELECT COUNT(*) AS total FROM ${table}`),
          [
            {
              total: ["users", "allocations"].includes(table)
                ? 3
                : [
                      "nests",
                      "server_grants",
                      "server_secondary_allocations",
                    ].includes(table)
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
        const settings = list.json().data[0].settings.allocations;
        assert.deepEqual(settings.default, {
          ip: "127.0.0.1",
          port: own === node ? 25610 : 25611,
        });
        assert.deepEqual(
          settings.mappings["127.0.0.2"],
          own === node ? [25616] : undefined,
        );

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
    let verifyPower: (() => Promise<void>) | undefined;
    if (actual) {
      const headers = {
        origin,
        "x-relay-request": "1",
      };
      const password = `Relay-ci-${randomUUID()}!`;
      const post = (path: string, payload: object) =>
        relay.inject({
          method: "POST",
          url: `/api/v1/auth/${path}`,
          headers,
          payload,
        });
      async function activate(email: string) {
        assert.equal(
          (await post("login", { email, password })).statusCode,
          401,
        );
        assert.equal(
          (await post("forgot-password", { email })).statusCode,
          202,
        );
        let token: string | undefined;
        let messageId: string | undefined;
        await until("Mailpit reset message", async () => {
          const search = new URL("http://127.0.0.1:8025/api/v1/search");
          search.searchParams.set("query", `to:${email}`);
          const list = await fetch(search, {
            signal: AbortSignal.timeout(1500),
          });
          if (!list.ok) return false;
          const { messages } = (await list.json()) as {
            messages?: { ID: string; To: { Address: string }[] }[];
          };
          const entry = messages?.find((row) =>
            row.To.some((recipient) => recipient.Address === email),
          );
          if (!entry) return false;
          const response = await fetch(
            `http://127.0.0.1:8025/api/v1/message/${encodeURIComponent(entry.ID)}`,
            { signal: AbortSignal.timeout(1500) },
          );
          if (!response.ok) return false;
          const { Text } = (await response.json()) as { Text: string };
          token = Text.split(/\s+/)
            .find((line) => line.startsWith(`${origin}/#reset-password?token=`))
            ?.match(/#reset-password\?token=([A-Za-z0-9_-]{43})$/)?.[1];
          messageId = entry.ID;
          return !!token;
        });
        assert.ok(token && messageId);
        assert.equal(
          (await post("reset-password", { token, password })).statusCode,
          204,
        );
        assert.equal(
          (await post("reset-password", { token, password })).statusCode,
          400,
        );
        const result = await post("login", { email, password });
        assert.equal(result.statusCode, 200);
        const cookie = result.cookies.find(
          (value) => value.name === "__Host-relay_session",
        );
        assert.ok(cookie?.secure && cookie.httpOnly);
        return { cookie: `${cookie.name}=${cookie.value}` };
      }
      const collaborator = await activate("collaborator@example.test");
      const outsider = await activate("outsider@example.test");
      const ownerSession = await activate("adoption@example.test");
      type Integration = {
        getAllServers(): Promise<{
          object: string;
          data: {
            object: string;
            attributes: {
              uuid: string;
              name: string;
              identifier: string;
              server_owner: boolean;
            };
          }[];
          meta: { pagination: { total: number } };
        }>;
        getServerDetails(id: string): Promise<{ uuid: string; name: string }>;
        getServerPage(page: number): Promise<unknown[]>;
      };
      const { NodeactylClient } = createRequire(import.meta.url)(
        "nodeactyl",
      ) as { NodeactylClient: new (url: string, key: string) => Integration };
      async function issueKey(session: typeof ownerSession) {
        const key = `rly_${randomBytes(32).toString("base64url")}`;
        const result = await relay.inject({
          method: "POST",
          url: "/api/v1/account/keys",
          headers: { ...headers, ...session },
          payload: { label: "Disposable client comparison", key },
        });
        assert.equal(result.statusCode, 201);
        return `${key}.${result.json<{ suffix: string }>().suffix}`;
      }
      const [relayKey, sharedKey, outsiderKey, legacyKeyResult] =
        await Promise.all([
          issueKey(ownerSession),
          issueKey(collaborator),
          issueKey(outsider),
          docker(
            "docker",
            [
              "exec",
              "relay-adoption-panel",
              "php",
              "/tmp/relay-fixture.php",
              "client-key",
            ],
            { timeout: 10000 },
          ),
        ]);
      const legacyKey = legacyKeyResult.stdout.trim();
      assert.match(legacyKey, /^ptlc_[A-Za-z0-9]+$/);
      const legacyBase = "http://127.0.0.1:13202",
        relayBase = "http://127.0.0.1:13200";
      async function probe(url: string, key: string) {
        // The exact same upstream SDK calls run against either configured panel.
        const client = new NodeactylClient(url, key);
        let stage = "list";
        try {
          const result = await client.getAllServers();
          assert.equal(result.object, "list");
          const records = result.data
            .map(({ object, attributes }) => ({
              object,
              uuid: attributes.uuid,
              name: attributes.name,
              identifier: attributes.identifier,
              owner: attributes.server_owner,
            }))
            .sort((a, b) => a.uuid.localeCompare(b.uuid));
          stage = "detail";
          const detail = await client.getServerDetails(uuid.slice(0, 8));
          return {
            records,
            total: result.meta.pagination.total,
            detail: { uuid: detail.uuid, name: detail.name },
            emptyPage: await (async () => {
              stage = "page 2";
              return client.getServerPage(2);
            })(),
          };
        } catch {
          throw new Error(
            `Nodeactyl read-only contract failed at ${stage} on loopback port ${new URL(url).port}`,
          );
        }
      }
      assert.deepEqual(
        await probe(relayBase, relayKey),
        await probe(legacyBase, legacyKey),
      );
      const auth = (key: string) => ({
        authorization: `Bearer ${key}`,
        accept: "application/vnd.pterodactyl.v1+json",
      });
      const listPath = "/api/client?per_page=1&page=1";
      const [nativePage, compatPage] = await Promise.all([
        fetch(`${legacyBase}${listPath}`, { headers: auth(legacyKey) }),
        fetch(`${relayBase}${listPath}`, { headers: auth(relayKey) }),
      ]);
      assert.equal(nativePage.status, 200);
      assert.equal(compatPage.status, 200);
      const pageInfo = (value: {
        meta: {
          pagination: {
            links: unknown;
            total: number;
            count: number;
            per_page: number;
            current_page: number;
            total_pages: number;
          };
        };
      }) => {
        const { links, ...numbers } = value.meta.pagination;
        return { numbers, links: Object.keys(links as object) };
      };
      assert.deepEqual(
        pageInfo(await compatPage.json()),
        pageInfo(await nativePage.json()),
      );
      for (const [token, allowed, denied] of [
        [sharedKey, uuid, second],
        [outsiderKey, undefined, uuid],
      ] as const) {
        assert.ok(denied);
        const index = await relay.inject({
          url: "/api/client",
          headers: auth(token),
        });
        assert.equal(index.statusCode, 200);
        const data = index.json<{ data: { attributes: { uuid: string } }[] }>()
          .data;
        assert.ok(!data.some((item) => item.attributes.uuid === denied));
        if (allowed)
          assert.ok(data.some((item) => item.attributes.uuid === allowed));
        const deniedResult = await relay.inject({
          url: `/api/client/servers/${denied}`,
          headers: auth(token),
        });
        assert.equal(deniedResult.statusCode, 404);
        assert.equal(deniedResult.json().errors[0].status, "404");
      }
      assert.equal(
        (await relay.inject({ url: "/api/client", headers: ownerSession }))
          .statusCode,
        401,
      );
      await pool.execute(
        "INSERT INTO audit_log (actor_id,event,subject_id) VALUES (?,'catalog.fixture_checked',?)",
        [owner, uuid],
      );
      const activity = (id: string, session?: { cookie: string }) =>
        relay.inject({
          url: `/api/v1/servers/${id}/activity`,
          headers: session,
        });
      const allowed = await activity(uuid, collaborator);
      assert.equal(allowed.statusCode, 200);
      assert.equal(allowed.headers["cache-control"], "no-store");
      assert.deepEqual(
        allowed.json<{ event: string }[]>().map((row) => row.event),
        ["catalog.fixture_checked"],
      );
      assert.equal((await activity(uuid, ownerSession)).statusCode, 200);
      assert.equal((await activity(uuid, outsider)).statusCode, 404);
      assert.ok(second);
      assert.equal((await activity(second, collaborator)).statusCode, 404);
      assert.equal((await activity(uuid)).statusCode, 401);
      verifyPower = async () => {
        const power = (
          id: string,
          action: "start" | "stop",
          session = collaborator,
        ) =>
          relay.inject({
            method: "POST",
            remoteAddress: "127.0.0.2", // Keep API-only checks out of the Chromium rate bucket.
            url: `/api/v1/servers/${id}/power`,
            headers: { ...headers, ...session },
            payload: { confirm: true, action },
          });
        const runtime = (session: typeof collaborator) =>
          relay.inject({
            method: "GET",
            url: `/api/v1/servers/${uuid}/runtime`,
            headers: session,
          });
        assert.equal((await runtime(outsider)).statusCode, 404);
        const shared = await runtime(collaborator);
        assert.equal(shared.statusCode, 200);
        assert.equal(shared.json().presence, "present");
        const powerEvents = () =>
          rows(
            pool,
            "SELECT event, subject_id FROM audit_log WHERE event IN ('wings.power_start_requested','wings.power_stop_requested') ORDER BY id",
          );
        assert.equal((await power(uuid, "stop")).statusCode, 404);
        assert.equal((await power(second, "stop")).statusCode, 404);
        assert.equal((await power(second, "start")).statusCode, 404);
        assert.equal((await power(uuid, "start", outsider)).statusCode, 404);
        assert.deepEqual(await powerEvents(), []);
        await clientFor(uuid).power(uuid, "stop");
        await until(
          "pre-start offline",
          async () => (await clientFor(uuid).state(uuid)) === "offline",
        );
        assert.equal((await power(uuid, "start")).statusCode, 202);
        await until(
          "subuser power running",
          async () => (await clientFor(uuid).state(uuid)) === "running",
        );
        await pool.execute("DELETE FROM server_grants WHERE server_id=?", [
          uuid,
        ]);
        assert.equal((await activity(uuid, collaborator)).statusCode, 404);
        await clientFor(uuid).power(uuid, "stop");
        await until(
          "post-revocation offline",
          async () => (await clientFor(uuid).state(uuid)) === "offline",
        );
        assert.equal((await power(uuid, "start")).statusCode, 404);
        assert.equal(await clientFor(uuid).state(uuid), "offline");
        assert.equal((await runtime(collaborator)).statusCode, 404);
        assert.equal((await runtime(ownerSession)).json().state, "offline");
        assert.equal(
          (await power(uuid, "start", ownerSession)).statusCode,
          202,
        );
        await until(
          "owner sees running through user API",
          async () => (await runtime(ownerSession)).json().state === "running",
        );
        assert.equal((await power(uuid, "stop", ownerSession)).statusCode, 202);
        await until(
          "owner sees offline through user API",
          async () => (await runtime(ownerSession)).json().state === "offline",
        );
        assert.deepEqual(await powerEvents(), [
          { event: "wings.power_start_requested", subject_id: uuid },
          { event: "wings.power_start_requested", subject_id: uuid },
          { event: "wings.power_stop_requested", subject_id: uuid },
        ]);
        const secondRelay = relay2;
        assert.ok(secondRelay);
        const mutate = (
          id: string,
          action: "grant" | "revoke",
          permission?: "control.start" | "control.stop",
        ) =>
          relay.inject({
            method: "POST",
            url: `/api/v1/servers/${id}/activity-access`,
            headers: { ...headers, ...ownerSession },
            payload: {
              email: "collaborator@example.test",
              action,
              ...(permission ? { permission } : {}),
            },
          });
        const dispatchGrantedPower = (
          id: string,
          action: "start" | "stop",
          session = collaborator,
        ) =>
          (id === uuid ? relay : secondRelay).inject({
            method: "POST",
            remoteAddress: "127.0.0.3",
            url: `/api/v1/servers/${id}/power`,
            headers: { ...headers, ...session },
            payload: { action, confirm: true },
          });
        try {
          for (const id of [uuid, second])
            assert.equal((await mutate(id, "grant")).statusCode, 204);
          assert.equal(
            (await mutate(uuid, "grant", "control.start")).statusCode,
            204,
          );
          assert.equal(
            (await mutate(second, "grant", "control.stop")).statusCode,
            204,
          );
          if ((await clientFor(second).state(second)) === "offline")
            assert.equal(
              (await dispatchGrantedPower(second, "start", ownerSession))
                .statusCode,
              202,
            );
          await until(
            "server B running before isolation test",
            async () => (await clientFor(second).state(second)) === "running",
          );
          assert.equal(
            (await dispatchGrantedPower(uuid, "stop")).statusCode,
            404,
          );
          assert.equal(
            (await dispatchGrantedPower(second, "start")).statusCode,
            404,
          );
          assert.equal(
            (await dispatchGrantedPower(uuid, "start")).statusCode,
            202,
          );
          await until(
            "server A running with delegated Start",
            async () => (await clientFor(uuid).state(uuid)) === "running",
          );
          assert.equal(
            (await mutate(uuid, "revoke", "control.start")).statusCode,
            204,
          );
          assert.equal(
            (await dispatchGrantedPower(uuid, "start")).statusCode,
            404,
          );
          await docker(
            "docker",
            [
              "exec",
              second,
              "sh",
              "-c",
              "printf '\\357\\273\\277second fixture\\r\\n' > /home/container/fixture-docs/example.txt",
            ],
            { timeout: 5000 },
          );
          assert.equal(
            (await dispatchGrantedPower(second, "stop")).statusCode,
            202,
          );
          await until(
            "server B offline with unchanged delegated Stop",
            async () => (await clientFor(second).state(second)) === "offline",
          );
          assert.equal(await clientFor(uuid).state(uuid), "running");

          const download = (app: typeof relay, id: string) =>
            app.inject({
              url: `/api/v1/servers/${id}/files?directory=%2Ffixture-docs&preview=example.txt&download=1`,
              remoteAddress: "127.0.0.3", // Check cross-node API separately from Chromium rate limits.
              headers: ownerSession,
            });
          const first = await download(relay, uuid);
          const other = await download(secondRelay, second);
          for (const result of [first, other]) {
            assert.equal(result.statusCode, 200);
            assert.equal(
              result.headers["content-disposition"],
              'attachment; filename="example.txt"',
            );
          }
          assert.deepEqual(
            first.rawPayload,
            Buffer.from("<strong>fixture preview</strong>\n"),
          );
          assert.deepEqual(
            other.rawPayload,
            Buffer.from("\uFEFFsecond fixture\r\n"),
          );
          assert.equal((await download(relay, second)).statusCode, 422);

          assert.equal(
            (await dispatchGrantedPower(uuid, "stop", ownerSession)).statusCode,
            202,
          );
          await until(
            "server A offline before browser rehearsal",
            async () => (await clientFor(uuid).state(uuid)) === "offline",
          );
        } finally {
          for (const id of [uuid, second])
            await pool.execute(
              "DELETE FROM server_grants WHERE server_id=? AND user_id=(SELECT id FROM users WHERE email='collaborator@example.test')",
              [id],
            );
        }
        if (browser) {
          await pool.execute(
            "INSERT INTO server_grants (server_id,user_id,permissions) SELECT ?,id,JSON_ARRAY('activity.read') FROM users WHERE email='collaborator@example.test'",
            [uuid],
          );
          await pool.execute(
            "INSERT INTO server_grants (server_id,user_id,permissions) SELECT ?,id,JSON_ARRAY('activity.read','control.stop') FROM users WHERE email='outsider@example.test'",
            [uuid],
          );
          try {
            const run = await docker(
              "./node_modules/.bin/playwright",
              [
                "test",
                "tests/wings-browser-live.spec.ts",
                "--reporter=line,github",
              ],
              {
                env: {
                  ...process.env,
                  RELAY_BROWSER_FIXTURE_ID: uuid,
                  RELAY_BROWSER_FIXTURE_PASSWORD: password,
                },
                timeout: 110_000,
              },
            );
            const readAfter = (app: typeof relay, id: string) =>
              app.inject({
                url: `/api/v1/servers/${id}/files?directory=%2Ffixture-docs&preview=example.txt&download=1`,
                remoteAddress: "127.0.0.3",
                headers: ownerSession,
              });
            const afterA = await readAfter(relay, uuid);
            const afterB = await readAfter(secondRelay, second);
            assert.equal(afterA.statusCode, 200);
            assert.equal(afterB.statusCode, 200);
            assert.deepEqual(
              afterA.rawPayload,
              Buffer.from("Saved from Chromium\n"),
            );
            assert.deepEqual(
              afterB.rawPayload,
              Buffer.from("\uFEFFsecond fixture\r\n"),
            );
            console.log(run.stdout);
          } catch (error) {
            // Playwright reporter annotations are captured by execFile; forward
            // only sanitized output from this credential-isolated fixture.
            const failure = error as { stdout?: string; stderr?: string };
            for (const output of [failure.stdout, failure.stderr])
              if (output)
                console.log(output.replaceAll(password, "[redacted]"));
            throw new Error("Disposable Wings browser contract failed");
          } finally {
            await pool.execute("DELETE FROM server_grants WHERE server_id=?", [
              uuid,
            ]);
          }
        }
      };
    }
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
    await verifyPower?.();
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
    mail.close();
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
