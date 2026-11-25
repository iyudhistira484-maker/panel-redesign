import WebSocket from "ws";
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
        {
          uuid,
          externalId: "fixture:Legacy A",
          ownerId: owner,
          nodeId,
          eggId: egg,
          nestId: nest,
          port: 25610,
        },
        {
          uuid: second,
          externalId: null,
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
        external_id: null,
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
        startServer(id: string): Promise<boolean>;
        stopServer(id: string): Promise<boolean>;
        restartServer(id: string): Promise<boolean>;
        sendServerCommand(id: string, command: string): Promise<boolean>;
        getServerUsages(id: string): Promise<{
          current_state: string;
          is_suspended: boolean;
          resources: Record<string, number>;
        }>;
      };
      const { NodeactylClient } = createRequire(import.meta.url)(
        "nodeactyl",
      ) as { NodeactylClient: new (url: string, key: string) => Integration };
      async function issueKey(
        session: typeof ownerSession,
        clientPower = false,
        clientConsole = false,
        clientStream = false,
        fileScopes: {
          clientListFiles?: boolean;
          clientDownload?: boolean;
          clientEditFile?: boolean;
          clientUploadFile?: boolean;
          clientDeleteFile?: boolean;
        } = {},
      ) {
        const key = `rly_${randomBytes(32).toString("base64url")}`;
        const result = await relay.inject({
          method: "POST",
          remoteAddress: fileScopes.clientDeleteFile
            ? "127.0.0.10"
            : fileScopes.clientUploadFile
              ? "127.0.0.9"
              : fileScopes.clientEditFile
                ? "127.0.0.8"
                : "127.0.0.1",
          url: "/api/v1/account/keys",
          headers: { ...headers, ...session },
          payload: {
            label: "Disposable client comparison",
            key,
            ...(clientPower ? { clientPower: true } : {}),
            ...(clientConsole ? { clientConsole: true } : {}),
            ...(clientStream ? { clientStream: true } : {}),
            ...fileScopes,
          },
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
      const identifier = uuid.slice(0, 8);
      const resourcesPath = `/api/client/servers/${identifier}/resources`;
      const checks = [
        [legacyBase, legacyKey],
        [relayBase, relayKey],
      ] as const;
      const signatures = await Promise.all(
        checks.map(async ([base, key]) => {
          try {
            const usage = await new NodeactylClient(base, key).getServerUsages(
              identifier,
            );
            const metricNames = Object.keys(usage.resources).sort();
            assert.deepEqual(metricNames, [
              "cpu_absolute",
              "disk_bytes",
              "memory_bytes",
              "network_rx_bytes",
              "network_tx_bytes",
              "uptime",
            ]);
            for (const value of Object.values(usage.resources))
              assert.ok(Number.isFinite(value) && value >= 0);
            assert.equal(usage.current_state, "running");
            assert.equal(usage.is_suspended, false);
            const raw = await fetch(`${base}${resourcesPath}`, {
              headers: auth(key),
            });
            assert.equal(raw.status, 200);
            const payload = (await raw.json()) as {
              object: string;
              attributes: object;
            };
            assert.equal(payload.object, "stats");
            return Object.keys(payload.attributes).sort();
          } catch {
            throw new Error(
              `Nodeactyl resources contract failed on loopback port ${new URL(base).port}`,
            );
          }
        }),
      );
      assert.deepEqual(signatures[0], signatures[1]);
      assert.equal(
        (await relay.inject({ url: resourcesPath, headers: auth(sharedKey) }))
          .statusCode,
        200,
      );
      assert.equal(
        (await relay.inject({ url: resourcesPath, headers: auth(outsiderKey) }))
          .statusCode,
        404,
      );
      assert.equal(
        (await relay.inject({ url: resourcesPath, headers: ownerSession }))
          .statusCode,
        401,
      );
      await docker("docker", ["pause", "relay-wings-contract"], {
        timeout: 5000,
      });
      try {
        const failed = await relay.inject({
          url: resourcesPath,
          headers: auth(relayKey),
        });
        assert.equal(failed.statusCode, 502);
        assert.equal(failed.json().errors[0].status, "502");
        assert.equal(failed.json().attributes, undefined);
      } finally {
        await docker("docker", ["unpause", "relay-wings-contract"], {
          timeout: 5000,
        });
      }
      assert.equal(
        (await relay.inject({ url: resourcesPath, headers: auth(relayKey) }))
          .statusCode,
        200,
      );
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
      type FilterPage = {
        data: { attributes: { uuid: string } }[];
        meta: {
          pagination: {
            total: number;
            count: number;
            per_page: number;
            current_page: number;
            total_pages: number;
            links: { next?: string };
          };
        };
      };
      const filteredPath = (params: Record<string, string>) =>
        `/api/client?${new URLSearchParams(params)}`;
      const filtered = async (
        base: string,
        key: string,
        params: Record<string, string>,
      ) => {
        const result = await fetch(`${base}${filteredPath(params)}`, {
          headers: auth(key),
        });
        assert.equal(result.status, 200);
        return (await result.json()) as FilterPage;
      };
      for (const params of [
        { "filter[name]": "STAGING WORKLOAD" },
        { "filter[uuid]": uuid },
        { type: "owner", "filter[name]": "staging", "filter[uuid]": uuid },
        { "filter[name]": "zzzz fixture not present" },
      ] as Record<string, string>[]) {
        const [native, compat] = await Promise.all([
          filtered(legacyBase, legacyKey, params),
          filtered(relayBase, relayKey, params),
        ]);
        const ids = (value: FilterPage) =>
          value.data.map((item) => item.attributes.uuid).sort();
        assert.deepEqual(ids(compat), ids(native));
        assert.deepEqual(pageInfo(compat), pageInfo(native));
      }
      const filteredPage = await filtered(relayBase, relayKey, {
        type: "owner",
        "filter[name]": "staging",
        per_page: "1",
      });
      assert.equal(filteredPage.meta.pagination.total, 2);
      const next = filteredPage.meta.pagination.links.next;
      assert.ok(next);
      assert.equal(new URL(next).searchParams.get("filter[name]"), "staging");
      assert.equal(new URL(next).searchParams.get("type"), "owner");
      assert.equal(new URL(next).searchParams.get("page"), "2");
      const nextPage = await filtered(
        relayBase,
        relayKey,
        Object.fromEntries(new URL(next).searchParams),
      );
      assert.equal(nextPage.meta.pagination.total, 2);
      assert.notEqual(
        nextPage.data[0].attributes.uuid,
        filteredPage.data[0].attributes.uuid,
      );
      const sharedName = await filtered(relayBase, sharedKey, {
        "filter[name]": "staging",
      });
      assert.deepEqual(
        sharedName.data.map((row) => row.attributes.uuid),
        [uuid],
      );
      assert.equal(sharedName.meta.pagination.total, 1);
      assert.ok(second);
      for (const params of [
        { "filter[uuid]": second },
        { type: "owner", "filter[name]": "staging" },
        { "filter[name]": "%" },
      ] as Record<string, string>[]) {
        const scoped = await filtered(relayBase, sharedKey, params);
        assert.equal(scoped.meta.pagination.total, 0);
        assert.deepEqual(scoped.data, []);
      }
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
          permission?:
            | "control.start"
            | "control.stop"
            | "control.restart"
            | "control.console"
            | "websocket.connect"
            | "file.read"
            | "file.read-content",
        ) =>
          relay.inject({
            method: "POST",
            url: `/api/v1/servers/${id}/activity-access`,
            remoteAddress: permission?.startsWith("file.")
              ? "127.0.0.7"
              : "127.0.0.6",
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
        const [ownerPowerKey, sharedPowerKey] = await Promise.all([
          issueKey(ownerSession, true),
          issueKey(collaborator, true),
        ]);
        const clientPath = `/api/client/servers/${identifier}/power`;
        const requestPower = (key: string, signal: string) =>
          relay.inject({
            method: "POST",
            remoteAddress: "127.0.0.4",
            url: clientPath,
            headers: auth(key),
            payload: { signal },
          });
        assert.equal((await requestPower(relayKey, "start")).statusCode, 403);
        assert.equal(
          (await requestPower(ownerPowerKey, "kill")).statusCode,
          400,
        );
        assert.equal(
          (
            await relay.inject({
              method: "POST",
              remoteAddress: "127.0.0.4",
              url: clientPath,
              headers: { ...headers, ...ownerSession },
              payload: { signal: "start" },
            })
          ).statusCode,
          401,
        );
        assert.equal(
          (
            await relay.inject({
              method: "POST",
              remoteAddress: "127.0.0.4",
              url: clientPath,
              headers: {
                ...auth(ownerPowerKey),
                origin: "https://other.example.test",
              },
              payload: { signal: "start" },
            })
          ).statusCode,
          403,
        );
        async function sdkPower(
          base: string,
          key: string,
          signal: "start" | "stop" | "restart",
        ) {
          const sdk = new NodeactylClient(base, key);
          try {
            return signal === "start"
              ? await sdk.startServer(identifier)
              : signal === "stop"
                ? await sdk.stopServer(identifier)
                : await sdk.restartServer(identifier);
          } catch (error) {
            const status =
              typeof error === "number" && Number.isFinite(error)
                ? ` (HTTP ${error})`
                : "";
            throw new Error(
              `Nodeactyl ${signal} failed at loopback port ${new URL(base).port}${status}`,
            );
          }
        }
        const observed = async (expected: string) =>
          until(
            `Client API power ${expected}`,
            async () => (await clientFor(uuid).state(uuid)) === expected,
          );
        const restarted = async (before: string) =>
          until(
            "Wings process replaced by restart",
            async () =>
              (await inspect()) !== before &&
              (await clientFor(uuid).state(uuid)) === "running",
          );
        const [ownerConsoleKey, sharedConsoleKey] = await Promise.all([
          issueKey(ownerSession, false, true),
          issueKey(collaborator, false, true),
        ]);
        const marker = () => randomBytes(12).toString("hex");
        const commandPath = `/api/client/servers/${identifier}/command`;
        const commandRequest = (key: string, command: string) =>
          relay.inject({
            method: "POST",
            remoteAddress: "127.0.0.5",
            url: commandPath,
            headers: auth(key),
            payload: { command },
          });
        const sendMarker = async (
          base: string,
          key: string,
          nonce = marker(),
        ) => {
          try {
            assert.equal(
              await new NodeactylClient(base, key).sendServerCommand(
                identifier,
                `relay-marker ${nonce}`,
              ),
              true,
            );
          } catch (error) {
            throw new Error(
              `Nodeactyl command failed at loopback port ${new URL(base).port}${typeof error === "number" ? ` (${error})` : ""}`,
            );
          }
        };
        const offline = await commandRequest(
          ownerConsoleKey,
          `relay-marker ${marker()}`,
        );
        assert.equal(offline.statusCode, 502);
        const [ownerStreamKey, sharedStreamKey] = await Promise.all([
          issueKey(ownerSession, false, false, true),
          issueKey(collaborator, false, false, true),
        ]);
        const streamPath = `/api/client/servers/${identifier}/websocket`;
        const getStream = (base: string, key: string) =>
          fetch(`${base}${streamPath}`, { headers: auth(key) });
        async function ticket(base: string, key: string) {
          const response = await getStream(base, key);
          assert.equal(response.status, 200);
          const body = (await response.json()) as {
            data: { token: string; socket: string };
          };
          assert.deepEqual(Object.keys(body.data).sort(), ["socket", "token"]);
          assert.equal(typeof body.data.token, "string");
          const url = new URL(body.data.socket);
          if (base === relayBase) {
            assert.equal(url.protocol, "wss:");
            assert.equal(url.host, new URL(origin).host);
            assert.equal(url.pathname, `/api/client/streams/${uuid}`);
            url.protocol = "ws:";
            url.host = new URL(relayBase).host;
          } else assert.equal(url.pathname, `/api/servers/${uuid}/ws`);
          return { url, token: body.data.token };
        }
        function connect(ticket: { url: URL; token: string }) {
          const peer = new WebSocket(ticket.url, {
            origin,
            handshakeTimeout: 3000,
            maxPayload: 32768,
          });
          const frames: { event: string; args?: string[] }[] = [];
          let stopped = false;
          peer.on("error", () => {
            stopped = true;
          });
          const closed = new Promise<number>((resolve) =>
            peer.once("close", (code) => {
              stopped = true;
              resolve(code);
            }),
          );
          const send = (event: string, args: string[] = []) =>
            peer.send(JSON.stringify({ event, args }));
          peer.once("open", () => send("auth", [ticket.token]));
          peer.on("message", (data) =>
            frames.push(JSON.parse(data.toString())),
          );
          const expectFrame = async (event: string, arg?: string) => {
            for (let i = 0; i < 60; i++) {
              if (
                frames.some(
                  (frame) =>
                    frame.event === event &&
                    (arg === undefined || frame.args?.[0] === arg),
                )
              )
                return;
              if (stopped) break;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            throw new Error(`Missing WebSocket event: ${event}`);
          };
          const expectClosed = async (timeout = 3000) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              assert.equal(
                await Promise.race([
                  closed,
                  new Promise((resolve) => {
                    timer = setTimeout(() => resolve(0), timeout);
                  }),
                ]),
                1008,
              );
            } finally {
              clearTimeout(timer);
            }
          };
          return { peer, send, expectFrame, expectClosed, frames };
        }
        async function streamMarker(base: string, key: string) {
          const relaySide = base === relayBase;
          const issued = await ticket(base, relaySide ? ownerStreamKey : key);
          const stream = connect(issued);
          try {
            await stream.expectFrame("auth success");
            const nonce = marker();
            await sendMarker(base, relaySide ? ownerConsoleKey : key, nonce);
            await stream.expectFrame(
              "console output",
              `RELAY_COMMAND_ACK ${nonce}`,
            );
            if (relaySide) {
              assert.deepEqual(
                stream.frames
                  .filter((frame) => frame.event === "console output")
                  .map((frame) => frame.args),
                [[`RELAY_COMMAND_ACK ${nonce}`]],
              );
              const rejected = connect(issued);
              try {
                await rejected.expectClosed();
              } finally {
                rejected.peer.terminate();
              }
              const wrong = await ticket(base, ownerStreamKey);
              wrong.url.pathname = `/api/client/streams/${second}`;
              const other = connect(wrong);
              try {
                await other.expectClosed();
              } finally {
                other.peer.terminate();
              }
              stream.send("send command", [`relay-marker ${marker()}`]);
              await stream.expectClosed();
              const expiring = connect(await ticket(base, ownerStreamKey));
              try {
                await expiring.expectFrame("auth success");
                await expiring.expectClosed(17_000);
              } finally {
                expiring.peer.terminate();
              }
            }
          } finally {
            stream.peer.terminate();
          }
        }
        for (const [base, key] of [
          [legacyBase, legacyKey],
          [relayBase, ownerPowerKey],
        ] as const) {
          assert.equal(await sdkPower(base, key, "start"), true);
          await observed("running");
          await streamMarker(base, key);
          if (base === relayBase) {
            assert.equal(
              (await commandRequest(ownerPowerKey, `relay-marker ${marker()}`))
                .statusCode,
              403,
            );
            assert.equal(
              (
                await commandRequest(
                  ownerConsoleKey,
                  `relay-marker ${marker()}\n`,
                )
              ).statusCode,
              400,
            );
            assert.equal(
              (await commandRequest(ownerConsoleKey, "echo arbitrary"))
                .statusCode,
              400,
            );
            assert.equal(
              (await requestPower(ownerConsoleKey, "stop")).statusCode,
              403,
            );
            for (const denied of [relayKey, ownerPowerKey, ownerConsoleKey])
              assert.equal((await getStream(relayBase, denied)).status, 403);
            assert.equal(
              (await commandRequest(ownerStreamKey, `relay-marker ${marker()}`))
                .statusCode,
              403,
            );
            assert.equal(
              (await requestPower(ownerStreamKey, "stop")).statusCode,
              403,
            );
            try {
              assert.equal((await mutate(uuid, "grant")).statusCode, 204);
              assert.equal(
                (await mutate(uuid, "grant", "control.start")).statusCode,
                204,
              );
              assert.equal(
                (
                  await commandRequest(
                    sharedConsoleKey,
                    `relay-marker ${marker()}`,
                  )
                ).statusCode,
                404,
              );
              assert.equal(
                (await mutate(uuid, "grant", "control.console")).statusCode,
                204,
              );
              assert.equal(
                (await getStream(relayBase, sharedStreamKey)).status,
                403,
              );
              assert.equal(
                (await mutate(uuid, "grant", "websocket.connect")).statusCode,
                204,
              );
              const sharedStream = connect(
                await ticket(relayBase, sharedStreamKey),
              );
              try {
                await sharedStream.expectFrame("auth success");
                const nonce = marker();
                await sendMarker(relayBase, sharedConsoleKey, nonce);
                await sharedStream.expectFrame(
                  "console output",
                  `RELAY_COMMAND_ACK ${nonce}`,
                );
                const stale = await ticket(relayBase, sharedStreamKey);
                assert.equal(
                  (await mutate(uuid, "revoke", "websocket.connect"))
                    .statusCode,
                  204,
                );
                await sharedStream.expectClosed();
                assert.equal(
                  (await getStream(relayBase, sharedStreamKey)).status,
                  403,
                );
                const staleStream = connect(stale);
                try {
                  await staleStream.expectClosed();
                } finally {
                  staleStream.peer.terminate();
                }
              } finally {
                sharedStream.peer.terminate();
              }
              assert.equal(
                (await mutate(uuid, "revoke", "control.console")).statusCode,
                204,
              );
              assert.equal(
                (
                  await commandRequest(
                    sharedConsoleKey,
                    `relay-marker ${marker()}`,
                  )
                ).statusCode,
                404,
              );
            } finally {
              await pool.execute(
                "DELETE FROM server_grants WHERE server_id=? AND user_id=(SELECT id FROM users WHERE email='collaborator@example.test')",
                [uuid],
              );
            }
          }
          const before = await inspect();
          assert.equal(await sdkPower(base, key, "restart"), true);
          await restarted(before);
          assert.equal(await sdkPower(base, key, "stop"), true);
          await observed("offline");
        }
        try {
          assert.equal((await mutate(uuid, "grant")).statusCode, 204);
          assert.equal(
            (await requestPower(sharedPowerKey, "start")).statusCode,
            404,
          );
          assert.equal(
            (await mutate(uuid, "grant", "control.start")).statusCode,
            204,
          );
          assert.equal(
            (await requestPower(sharedKey, "start")).statusCode,
            403,
          );
          assert.equal(
            (await requestPower(sharedPowerKey, "start")).statusCode,
            204,
          );
          await observed("running");
          assert.equal(
            (await requestPower(sharedPowerKey, "stop")).statusCode,
            404,
          );
          assert.equal(
            (await mutate(uuid, "grant", "control.stop")).statusCode,
            204,
          );
          assert.equal(
            (await requestPower(sharedPowerKey, "restart")).statusCode,
            404,
          );
          assert.equal(
            (await mutate(uuid, "grant", "control.restart")).statusCode,
            204,
          );
          assert.equal(
            (await requestPower(sharedKey, "restart")).statusCode,
            403,
          );
          const before = await inspect();
          assert.equal(
            await sdkPower(relayBase, sharedPowerKey, "restart"),
            true,
          );
          await restarted(before);
          assert.equal(
            (await mutate(uuid, "revoke", "control.restart")).statusCode,
            204,
          );
          assert.equal(
            (await requestPower(sharedPowerKey, "restart")).statusCode,
            404,
          );
          assert.equal(
            (await mutate(uuid, "revoke", "control.stop")).statusCode,
            204,
          );
          assert.equal(
            (await mutate(uuid, "revoke", "control.start")).statusCode,
            204,
          );
          assert.equal(
            (await requestPower(sharedPowerKey, "start")).statusCode,
            404,
          );
          assert.equal(
            (
              await relay.inject({
                url: resourcesPath,
                headers: auth(sharedPowerKey),
              })
            ).statusCode,
            200,
          );
          assert.equal(await sdkPower(relayBase, ownerPowerKey, "stop"), true);
          await observed("offline");
        } finally {
          await pool.execute(
            "DELETE FROM server_grants WHERE server_id=? AND user_id=(SELECT id FROM users WHERE email='collaborator@example.test')",
            [uuid],
          );
        }
        const restartAudit = async () =>
          rows<{ event: string }>(
            pool,
            "SELECT event FROM audit_log WHERE subject_id=? AND event IN ('wings.power_restart_requested','wings.power_restart_uncertain') ORDER BY id",
            [uuid],
          );
        const priorAudit = (await restartAudit()).length;
        await docker("docker", ["pause", "relay-wings-contract"], {
          timeout: 5000,
        });
        try {
          const failed = await requestPower(ownerPowerKey, "restart");
          assert.equal(failed.statusCode, 502);
          assert.equal(
            failed.json().errors[0].detail,
            "Power outcome unknown.",
          );
          assert.deepEqual((await restartAudit()).slice(priorAudit), [
            { event: "wings.power_restart_requested" },
            { event: "wings.power_restart_uncertain" },
          ]);
        } finally {
          await docker("docker", ["unpause", "relay-wings-contract"], {
            timeout: 5000,
          });
        }
        // A request that timed out at Relay can still be processed after Wings resumes.
        await sdkPower(relayBase, ownerPowerKey, "stop");
        await observed("offline");
        const [listKey, downloadKey, sharedFileKey] = await Promise.all([
          issueKey(ownerSession, false, false, false, {
            clientListFiles: true,
          }),
          issueKey(ownerSession, false, false, false, { clientDownload: true }),
          issueKey(collaborator, false, false, false, {
            clientListFiles: true,
            clientDownload: true,
          }),
        ]);
        const fileApi = (
          base: string,
          key: string,
          action: "list" | "download",
          path: string,
        ) =>
          fetch(
            `${base}/api/client/servers/${identifier}/files/${action}?${new URLSearchParams({ [action === "list" ? "directory" : "file"]: path })}`,
            { headers: auth(key) },
          );
        const directory = "/fixture-docs";
        const binaryFile = `${directory}/binary.txt`;
        const compatibleEntries = async (base: string, key: string) => {
          const response = await fileApi(base, key, "list", directory);
          assert.equal(response.status, 200);
          const body = (await response.json()) as {
            object: string;
            data: {
              object: string;
              attributes: {
                name: string;
                size: number;
                is_file: boolean;
                is_symlink: boolean;
              };
            }[];
          };
          assert.equal(body.object, "list");
          assert.ok(body.data.every((entry) => entry.object === "file_object"));
          if (base === relayBase)
            assert.ok(body.data.every((entry) => !entry.attributes.is_symlink));
          return body.data
            .filter((entry) => !entry.attributes.is_symlink)
            .map(({ attributes: { name, size, is_file } }) => ({
              name,
              size,
              is_file,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
        };
        assert.deepEqual(
          await compatibleEntries(relayBase, listKey),
          await compatibleEntries(legacyBase, legacyKey),
        );
        assert.equal(
          (await fileApi(relayBase, relayKey, "list", directory)).status,
          403,
        );
        assert.equal(
          (await fileApi(relayBase, downloadKey, "list", directory)).status,
          403,
        );
        assert.equal(
          (await fileApi(relayBase, listKey, "download", binaryFile)).status,
          403,
        );
        assert.equal(
          (await fileApi(relayBase, listKey, "list", "/fixture-docs/.."))
            .status,
          400,
        );
        assert.equal(
          (
            await fileApi(
              relayBase,
              downloadKey,
              "download",
              `${directory}/link.txt`,
            )
          ).status,
          404,
        );
        const downloadTicket = async (base: string, key: string) => {
          const response = await fileApi(base, key, "download", binaryFile);
          assert.equal(response.status, 200);
          const body = (await response.json()) as {
            object: string;
            attributes: { url: string };
          };
          assert.equal(body.object, "signed_url");
          const url = new URL(body.attributes.url);
          if (base === relayBase) {
            assert.equal(url.origin, origin);
            url.protocol = "http:";
            url.host = new URL(relayBase).host;
          }
          return url;
        };
        const legacyDownload = await fetch(
          await downloadTicket(legacyBase, legacyKey),
        );
        assert.equal(legacyDownload.status, 200);
        const expectedBytes = Buffer.from(await legacyDownload.arrayBuffer());
        assert.deepEqual(expectedBytes, Buffer.from("\0fixture"));
        const relayDownload = await downloadTicket(relayBase, downloadKey);
        const otherPath = new URL(relayDownload);
        otherPath.pathname = otherPath.pathname.replace(
          "binary.txt",
          "example.txt",
        );
        assert.equal((await fetch(otherPath)).status, 404);
        const otherServer = new URL(relayDownload);
        otherServer.pathname = otherServer.pathname.replace(uuid, second);
        assert.equal((await fetch(otherServer)).status, 404);
        const actualDownload = await fetch(relayDownload);
        assert.equal(actualDownload.status, 200);
        assert.equal(
          actualDownload.headers.get("content-disposition"),
          'attachment; filename="binary.txt"',
        );
        assert.deepEqual(
          Buffer.from(await actualDownload.arrayBuffer()),
          expectedBytes,
        );
        assert.equal((await fetch(relayDownload)).status, 404);
        const expiringDownload = await downloadTicket(relayBase, downloadKey);
        try {
          assert.equal((await mutate(uuid, "grant")).statusCode, 204);
          assert.equal(
            (await mutate(uuid, "grant", "file.read")).statusCode,
            204,
          );
          assert.equal(
            (await fileApi(relayBase, sharedFileKey, "list", directory)).status,
            200,
          );
          assert.equal(
            (await fileApi(relayBase, sharedFileKey, "download", binaryFile))
              .status,
            403,
          );
          assert.equal(
            (await mutate(uuid, "grant", "file.read-content")).statusCode,
            204,
          );
          const revoked = await downloadTicket(relayBase, sharedFileKey);
          assert.equal(
            (await mutate(uuid, "revoke", "file.read-content")).statusCode,
            204,
          );
          assert.equal((await fetch(revoked)).status, 404);
          assert.equal(
            (await fileApi(relayBase, sharedFileKey, "download", binaryFile))
              .status,
            403,
          );
          assert.equal(
            (await fileApi(relayBase, sharedFileKey, "list", directory)).status,
            200,
          );
          assert.equal(
            (await mutate(uuid, "revoke", "file.read")).statusCode,
            204,
          );
          assert.equal(
            (await fileApi(relayBase, sharedFileKey, "list", directory)).status,
            403,
          );
        } finally {
          await pool.execute(
            "DELETE FROM server_grants WHERE server_id=? AND user_id=(SELECT id FROM users WHERE email='collaborator@example.test')",
            [uuid],
          );
        }
        const editKey = await issueKey(ownerSession, false, false, false, {
          clientDownload: true,
          clientEditFile: true,
        });
        const editable = `${directory}/example.txt`;
        const textUrl = (
          base: string,
          action: "contents" | "write",
          file = editable,
        ) =>
          `${base}/api/client/servers/${identifier}/files/${action}?${new URLSearchParams({ file })}`;
        const readText = (base: string, key: string) =>
          fetch(textUrl(base, "contents"), { headers: auth(key) });
        const writeText = (
          base: string,
          key: string,
          body: string | Uint8Array,
          etag?: string,
          file?: string,
        ) =>
          fetch(textUrl(base, "write", file), {
            method: "POST",
            headers: {
              ...auth(key),
              "content-type": "text/plain; charset=utf-8",
              ...(etag === undefined ? {} : { "if-match": etag }),
            },
            body: typeof body === "string" ? body : new Uint8Array(body),
          });
        const readFixture = async (base: string, key: string) => {
          const response = await readText(base, key);
          assert.equal(response.status, 200);
          assert.ok(
            response.headers.get("content-type")?.startsWith("text/plain"),
          );
          return {
            bytes: Buffer.from(await response.arrayBuffer()),
            etag: response.headers.get("etag"),
          };
        };
        const originalText = await readFixture(legacyBase, legacyKey);
        assert.deepEqual(
          (await readFixture(relayBase, downloadKey)).bytes,
          originalText.bytes,
        );
        const legacyText = "Legacy edit via HTTP\r\n";
        assert.equal(
          (await writeText(legacyBase, legacyKey, legacyText)).status,
          204,
        );
        const current = await readFixture(relayBase, editKey);
        assert.deepEqual(current.bytes, Buffer.from(legacyText));
        assert.ok(current.etag);
        assert.equal(
          (await writeText(relayBase, downloadKey, "denied", current.etag))
            .status,
          403,
        );
        assert.equal(
          (await writeText(relayBase, editKey, "no version")).status,
          428,
        );
        assert.equal(
          (
            await writeText(
              relayBase,
              editKey,
              new Uint8Array([0xff]),
              current.etag,
            )
          ).status,
          400,
        );
        assert.equal(
          (
            await writeText(
              relayBase,
              editKey,
              "other file",
              current.etag,
              binaryFile,
            )
          ).status,
          400,
        );
        const edited = "\uFEFFRelay edit: café\r\n";
        assert.equal(
          (await writeText(relayBase, editKey, edited, current.etag)).status,
          204,
        );
        assert.equal(
          (await writeText(relayBase, editKey, "stale writer", current.etag))
            .status,
          412,
        );
        const saved = await readFixture(relayBase, editKey);
        assert.notEqual(saved.etag, current.etag);
        assert.deepEqual(saved.bytes, Buffer.from(edited));
        assert.deepEqual(
          (await readFixture(legacyBase, legacyKey)).bytes,
          saved.bytes,
        );
        assert.equal(
          (
            await writeText(
              relayBase,
              editKey,
              originalText.bytes,
              saved.etag ?? undefined,
            )
          ).status,
          204,
        );
        assert.deepEqual(
          (await readFixture(relayBase, editKey)).bytes,
          originalText.bytes,
        );
        const uploadKey = await issueKey(ownerSession, false, false, false, {
          clientUploadFile: true,
        });
        const getUpload = (base: string, key: string) =>
          fetch(`${base}/api/client/servers/${identifier}/files/upload`, {
            headers: auth(key),
          });
        async function uploadTicket(base: string, key: string) {
          const response = await getUpload(base, key);
          assert.equal(response.status, 200);
          const body = (await response.json()) as {
            object: string;
            attributes: { url: string };
          };
          assert.equal(body.object, "signed_url");
          const url = new URL(body.attributes.url);
          if (base === relayBase) {
            assert.equal(url.origin, origin);
            url.protocol = "http:";
            url.host = new URL(relayBase).host;
          }
          return url;
        }
        function sendUpload(
          url: URL,
          name: string,
          body: string,
          directoryPath = directory,
          multiple = false,
        ) {
          const target = new URL(url);
          target.searchParams.set("directory", directoryPath);
          const form = new FormData();
          form.append("files", new Blob([body], { type: "text/plain" }), name);
          if (multiple) form.append("files", new Blob(["other"]), "extra.txt");
          return fetch(target, { method: "POST", body: form });
        }
        for (const denied of [listKey, downloadKey, editKey])
          assert.equal((await getUpload(relayBase, denied)).status, 403);
        const expiredUpload = await uploadTicket(relayBase, uploadKey);
        const payload = "\uFEFFUploaded café\r\n";
        const legacyName = "legacy-upload.txt";
        const relayName = "relay-upload.txt";
        assert.equal(
          (
            await sendUpload(
              await uploadTicket(legacyBase, legacyKey),
              legacyName,
              payload,
            )
          ).status,
          200,
        );
        const relayUpload = await uploadTicket(relayBase, uploadKey);
        const wrongUpload = new URL(relayUpload);
        wrongUpload.pathname = wrongUpload.pathname.replace(uuid, second);
        assert.equal(
          (await sendUpload(wrongUpload, relayName, payload)).status,
          404,
        );
        assert.equal(
          (await sendUpload(relayUpload, relayName, payload, "/")).status,
          400,
        );
        assert.equal(
          (await sendUpload(relayUpload, relayName, payload)).status,
          200,
        );
        assert.equal(
          (await sendUpload(relayUpload, "replay.txt", payload)).status,
          404,
        );
        assert.equal(
          (
            await sendUpload(
              await uploadTicket(relayBase, uploadKey),
              relayName,
              "overwrite",
            )
          ).status,
          409,
        );
        assert.equal(
          (
            await sendUpload(
              await uploadTicket(relayBase, uploadKey),
              "link.txt",
              "overwrite symlink",
            )
          ).status,
          409,
        );
        assert.equal(
          (
            await sendUpload(
              await uploadTicket(relayBase, uploadKey),
              "large-upload.txt",
              "x".repeat(16_385),
            )
          ).status,
          400,
        );
        assert.equal(
          (
            await sendUpload(
              await uploadTicket(relayBase, uploadKey),
              "multi.txt",
              payload,
              directory,
              true,
            )
          ).status,
          400,
        );
        const wingClient = clientFor(uuid);
        const uploaded = await wingClient.fixtureDownload(
          uuid,
          ["fixture-docs"],
          relayName,
        );
        assert.deepEqual(uploaded, Buffer.from(payload));
        assert.deepEqual(
          await wingClient.fixtureDownload(uuid, ["fixture-docs"], legacyName),
          uploaded,
        );
        assert.deepEqual(
          (await readFixture(relayBase, editKey)).bytes,
          originalText.bytes,
        );
        const names = (
          await wingClient.fixtureDirectory(uuid, ["fixture-docs"])
        ).map((entry) => entry.name);
        for (const rejected of [
          "replay.txt",
          "large-upload.txt",
          "multi.txt",
          "extra.txt",
        ])
          assert.ok(!names.includes(rejected));
        const deleteKey = await issueKey(ownerSession, false, false, false, {
          clientDeleteFile: true,
        });
        const deleteFiles = (
          base: string,
          key: string,
          files: string[],
          root = directory,
        ) =>
          fetch(`${base}/api/client/servers/${identifier}/files/delete`, {
            method: "POST",
            headers: { ...auth(key), "content-type": "application/json" },
            body: JSON.stringify({ root, files }),
          });
        for (const denied of [uploadKey, editKey, downloadKey])
          assert.equal(
            (await deleteFiles(relayBase, denied, [relayName])).status,
            403,
          );
        for (const target of ["example.txt", "link.txt", legacyName])
          assert.equal(
            (await deleteFiles(relayBase, deleteKey, [target])).status,
            404,
          );
        assert.equal(
          (await deleteFiles(relayBase, deleteKey, [relayName, legacyName]))
            .status,
          400,
        );
        assert.equal(
          (await deleteFiles(relayBase, deleteKey, ["fixture-docs"], "/"))
            .status,
          400,
        );
        assert.equal(
          (await deleteFiles(relayBase, deleteKey, ["../example.txt"])).status,
          400,
        );
        const secondWings = clientFor(second);
        const isolated = "Other server must survive\r\n";
        await secondWings.uploadFixtureText(second, relayName, isolated);
        await wingClient.uploadFixtureText(
          uuid,
          relayName,
          "Externally changed",
        );
        assert.equal(
          (await deleteFiles(relayBase, deleteKey, [relayName])).status,
          409,
        );
        assert.deepEqual(
          await wingClient.fixtureDownload(uuid, ["fixture-docs"], relayName),
          Buffer.from("Externally changed"),
        );
        await wingClient.uploadFixtureText(uuid, relayName, payload);
        assert.equal(
          (await deleteFiles(legacyBase, legacyKey, [legacyName])).status,
          204,
        );
        assert.equal(
          await wingClient.fixtureUploadTargetExists(uuid, legacyName),
          false,
        );
        const neighboring = await wingClient.fixtureDownload(
          uuid,
          ["fixture-docs"],
          "binary.txt",
        );
        assert.equal(
          (await deleteFiles(relayBase, deleteKey, [relayName])).status,
          204,
        );
        assert.equal(
          await wingClient.fixtureUploadTargetExists(uuid, relayName),
          false,
        );
        assert.equal(
          (
            await fileApi(
              relayBase,
              downloadKey,
              "download",
              `${directory}/${relayName}`,
            )
          ).status,
          404,
        );
        assert.equal(
          (await deleteFiles(relayBase, deleteKey, [relayName])).status,
          404,
        );
        assert.deepEqual(
          (await readFixture(relayBase, editKey)).bytes,
          originalText.bytes,
        );
        assert.deepEqual(
          await wingClient.fixtureDownload(
            uuid,
            ["fixture-docs"],
            "binary.txt",
          ),
          neighboring,
        );
        assert.equal(
          await wingClient.fixtureUploadTargetExists(uuid, "link.txt"),
          true,
        );
        assert.deepEqual(
          await secondWings.fixtureDownload(
            second,
            ["fixture-docs"],
            relayName,
          ),
          Buffer.from(isolated),
        );
        await new Promise((resolve) => setTimeout(resolve, 15_100));
        assert.equal(
          (await sendUpload(expiredUpload, "expired.txt", payload)).status,
          404,
        );
        assert.equal((await fetch(expiringDownload)).status, 404);
        const applicationPath = "/api/application/servers";
        const managementPath = "/api/v1/account/application-keys";
        const mintApplication = (
          session: typeof ownerSession,
          readServers: boolean,
        ) =>
          relay.inject({
            method: "POST",
            remoteAddress: "127.0.0.11",
            url: managementPath,
            headers: { ...headers, ...session },
            payload: { label: "Disposable inventory comparison", readServers },
          });
        assert.equal(
          (await mintApplication(ownerSession, true)).statusCode,
          403,
        );
        await pool.execute(
          "UPDATE users SET is_admin=TRUE WHERE email='outsider@example.test'",
        );
        try {
          const [withRead, withoutRead, legacyAppResult] = await Promise.all([
            mintApplication(outsider, true),
            mintApplication(outsider, false),
            docker(
              "docker",
              [
                "exec",
                "relay-adoption-panel",
                "php",
                "/tmp/relay-fixture.php",
                "application-key",
              ],
              { timeout: 10000 },
            ),
          ]);
          assert.equal(withRead.statusCode, 201);
          assert.equal(withoutRead.statusCode, 201);
          const application = withRead.json<{ id: string; token: string }>(),
            denied = withoutRead.json<{ token: string }>();
          const legacyApplication = legacyAppResult.stdout.trim();
          assert.match(legacyApplication, /^ptla_[A-Za-z0-9]+$/);
          const inventory = (
            base: string,
            key: string,
            path = applicationPath,
          ) => fetch(`${base}${path}`, { headers: auth(key) });
          assert.equal((await inventory(relayBase, relayKey)).status, 401);
          assert.equal((await inventory(relayBase, denied.token)).status, 403);
          assert.equal(
            (
              await fetch(`${relayBase}/api/client`, {
                headers: auth(application.token),
              })
            ).status,
            401,
          );
          assert.equal(
            (await relay.inject({ url: applicationPath, headers: outsider }))
              .statusCode,
            401,
          );
          type Entry = {
            object: string;
            attributes: {
              id: number;
              external_id: string | null;
              uuid: string;
              identifier: string;
              name: string;
              status: string | null;
            };
          };
          async function snapshot(base: string, key: string) {
            const entries: Entry[] = [];
            const pagination = [];
            for (const page of [1, 2]) {
              const response = await inventory(
                base,
                key,
                `${applicationPath}?per_page=1&page=${page}`,
              );
              assert.equal(
                response.status,
                200,
                `Application list at ${new URL(base).port} returned ${response.status}`,
              );
              const body = (await response.json()) as {
                object: string;
                data: Entry[];
                meta: {
                  pagination: {
                    count: number;
                    total: number;
                    per_page: number;
                    current_page: number;
                    total_pages: number;
                    links: { next?: string; previous?: string };
                  };
                };
              };
              assert.equal(body.object, "list");
              const { links, ...meta } = body.meta.pagination;
              pagination.push(meta);
              const link = page === 1 ? links.next : links.previous;
              assert.ok(link);
              if (base === relayBase)
                assert.equal(new URL(link).searchParams.get("per_page"), "1");
              assert.equal(
                new URL(link).searchParams.get("page"),
                String(page === 1 ? 2 : 1),
              );
              const entry = body.data[0];
              assert.equal(entry.object, "server");
              assert.ok(
                Number.isSafeInteger(entry.attributes.id) &&
                  entry.attributes.id > 0,
              );
              const detail = await inventory(
                base,
                key,
                `${applicationPath}/${entry.attributes.id}`,
              );
              assert.equal(
                detail.status,
                200,
                `Application detail at ${new URL(base).port} returned ${detail.status}`,
              );
              assert.deepEqual(await detail.json(), entry);
              if (base === relayBase)
                assert.deepEqual(Object.keys(entry.attributes).sort(), [
                  "external_id",
                  "id",
                  "identifier",
                  "name",
                  "status",
                  "uuid",
                ]);
              entries.push(entry);
            }
            return {
              pagination,
              records: entries
                .map(
                  ({
                    attributes: {
                      id: _,
                      uuid,
                      identifier,
                      name,
                      status,
                      external_id,
                    },
                  }) => ({ uuid, identifier, name, status, external_id }),
                )
                .sort((a, b) => a.uuid.localeCompare(b.uuid)),
            };
          }
          assert.deepEqual(
            await snapshot(relayBase, application.token),
            await snapshot(legacyBase, legacyApplication),
          );
          const externalId = "fixture:Legacy A";
          const externalPath = `${applicationPath}/external/${encodeURIComponent(externalId)}`;
          for (const [base, key] of [
            [legacyBase, legacyApplication],
            [relayBase, application.token],
          ] as const) {
            const found = await inventory(base, key, externalPath);
            assert.equal(found.status, 200);
            const entry = (await found.json()) as Entry;
            assert.equal(entry.attributes.external_id, externalId);
            assert.equal(entry.attributes.uuid, uuid);
            assert.deepEqual(
              await (
                await inventory(
                  base,
                  key,
                  `${applicationPath}/${entry.attributes.id}`,
                )
              ).json(),
              entry,
            );
            assert.equal(
              (
                await inventory(
                  base,
                  key,
                  `${applicationPath}/external/missing-external-id`,
                )
              ).status,
              404,
            );
            const query = (part: string, page = 1) =>
              `${applicationPath}?${new URLSearchParams({ "filter[uuid]": part, per_page: "1", page: String(page) })}`;
            const filtered = async (part: string, page = 1) => {
              const response = await inventory(base, key, query(part, page));
              assert.equal(response.status, 200);
              return (await response.json()) as {
                data: Entry[];
                meta: {
                  pagination: {
                    total: number;
                    count: number;
                    current_page: number;
                    links: { next?: string; previous?: string };
                  };
                };
              };
            };
            const one = await filtered(uuid.toUpperCase());
            assert.equal(one.meta.pagination.total, 1);
            assert.deepEqual(
              one.data.map((row) => row.attributes.uuid),
              [uuid],
            );
            const empty = await filtered(
              "00000000-0000-4000-8000-000000000000",
            );
            assert.equal(empty.meta.pagination.total, 0);
            assert.deepEqual(empty.data, []);
            const first = await filtered("-"),
              secondPage = await filtered("-", 2);
            assert.equal(first.meta.pagination.total, 2);
            assert.equal(secondPage.meta.pagination.total, 2);
            assert.deepEqual(
              [
                first.data[0].attributes.uuid,
                secondPage.data[0].attributes.uuid,
              ].sort(),
              [uuid, second].sort(),
            );
            if (base === relayBase) {
              const next = first.meta.pagination.links.next;
              assert.ok(next);
              const link = new URL(next);
              assert.equal(link.searchParams.get("filter[uuid]"), "-");
              assert.equal(link.searchParams.get("per_page"), "1");
              const followed = await inventory(
                base,
                key,
                `${link.pathname}${link.search}`,
              );
              assert.equal(followed.status, 200);
              assert.deepEqual(await followed.json(), secondPage);
            }
          }
          assert.equal(
            (await inventory(relayBase, denied.token, externalPath)).status,
            403,
          );
          assert.equal(
            (await inventory(relayBase, relayKey, externalPath)).status,
            401,
          );
          assert.equal(
            (
              await inventory(
                relayBase,
                application.token,
                `${applicationPath}?filter%5Buuid%5D=%25`,
              )
            ).status,
            400,
          );
          assert.equal(
            (
              await inventory(
                relayBase,
                application.token,
                `${applicationPath}/${uuid}`,
              )
            ).status,
            404,
          );
          assert.equal(
            (
              await inventory(
                relayBase,
                application.token,
                `${applicationPath}?include=node`,
              )
            ).status,
            400,
          );
          assert.equal(
            (
              await fetch(`${relayBase}${applicationPath}`, {
                method: "POST",
                headers: { ...headers, ...auth(application.token) },
              })
            ).status,
            404,
          );
          await pool.execute(
            "UPDATE users SET is_admin=FALSE WHERE email='outsider@example.test'",
          );
          assert.equal(
            (await inventory(relayBase, application.token)).status,
            401,
          );
          await pool.execute(
            "UPDATE users SET is_admin=TRUE WHERE email='outsider@example.test'",
          );
          assert.equal(
            (
              await relay.inject({
                method: "DELETE",
                url: `${managementPath}/${application.id}`,
                headers: { ...headers, ...outsider },
              })
            ).statusCode,
            204,
          );
          assert.equal(
            (await inventory(relayBase, application.token)).status,
            401,
          );
        } finally {
          await pool.execute(
            "UPDATE users SET is_admin=FALSE WHERE email='outsider@example.test'",
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
  const location =
    error instanceof Error
      ? error.stack?.match(/live-adoption\.ts:\d+:\d+/)?.[0]
      : undefined;
  const message =
    error instanceof Error
      ? error.message.split("\n")[0]
      : "Adoption contract failed";
  const comparison = error as { actual?: unknown; expected?: unknown };
  const statuses =
    typeof comparison.actual === "number" &&
    typeof comparison.expected === "number"
      ? ` (${comparison.actual}, expected ${comparison.expected})`
      : "";
  console.error(
    `::error::${location ?? "live adoption"}: ${message}${statuses}`,
  );
  process.exitCode = 1;
});
