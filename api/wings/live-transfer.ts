import { mumbleEgg } from "../eggs/upstream-workload";
import { createApp } from "../app";
import type { FixtureTransfer } from "../catalog/routes";
import type { Pool } from "mysql2/promise";
import { reviewedHttpEggs } from "../eggs/reviewed-workload";
import { transferProfile } from "./transfer-profile";
import { cryptoContext, passwordHash } from "../security";
import { fixtureTransferService } from "./transfer-service";
import { createServer, request, type ClientRequest } from "node:http";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { rows, stagingPool } from "../db";
import { migrate } from "../migrate";
import { transferLedger } from "../catalog/transfer";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { WingsClient, type WingsNode } from "./client";

import { registerRemote } from "./remote";
import { signTransferCapability } from "./transfer-token";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const issuer = "http://127.0.0.1:13201";
const panelOrigin = "https://transfer.relay.example.test";
const browserHeaders = { origin: panelOrigin, "x-relay-request": "1" };
const panel = (
  pool: Pool,
  source: WingsNode,
  fixtureTransfer: FixtureTransfer,
) =>
  createApp({
    pool,
    origin: panelOrigin,
    key: randomBytes(32),
    pepper: randomBytes(32),
    catalogNodeKey: randomBytes(32),
    enableDisposableProvisioning: true,
    wingsTestNode: source,
    allowedCatalogNodeOrigins: [source.origin],
    fixtureTransfer,
    deliverReset: async () => {},
  });
async function login(app: Awaited<ReturnType<typeof panel>>, password: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: browserHeaders,
    payload: { email: "transfer@example.test", password },
  });
  assert.equal(response.statusCode, 200);
  const cookie = response.cookies.find(
    (cookie) => cookie.name === "__Host-relay_session",
  );
  assert.ok(cookie?.secure && cookie.httpOnly);
  return { ...browserHeaders, cookie: `${cookie.name}=${cookie.value}` };
}
async function eventually(
  label: string,
  fn: () => boolean | Promise<boolean>,
  attempts = 45,
) {
  for (let i = 0; i < attempts; i++) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`Transfer contract did not reach ${label}`);
}
async function main() {
  if (
    process.env.RELAY_DISPOSABLE_WINGS_CI !== "1" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    process.env.GITHUB_EVENT_NAME !== "push"
  )
    throw new Error("Disposable CI only");
  const node = (
    port: number,
    tokenId: string,
    token: string | undefined,
  ): WingsNode => ({
    origin: `http://127.0.0.1:${port}`,
    tokenId,
    token: token ?? "",
  });
  const source = node(
    18180,
    "relaytransfersource",
    process.env.RELAY_TRANSFER_SOURCE_TOKEN,
  );
  const target = node(
    18181,
    "relaytransfertarget",
    process.env.RELAY_TRANSFER_TARGET_TOKEN,
  );
  let installed: boolean | undefined;
  const interrupted = ["sender-killed", "partial-target"].includes(
    process.env.RELAY_TRANSFER_SCENARIO ?? "",
  );
  const mumble = process.env.RELAY_TRANSFER_SCENARIO?.startsWith("mumble-");
  const corrupt = process.env.RELAY_TRANSFER_SCENARIO === "corrupt-archive";
  const dropReport = ["missing-report", "mumble-missing-report"].includes(
    process.env.RELAY_TRANSFER_SCENARIO ?? "",
  );
  const pair = process.env.RELAY_TRANSFER_SCENARIO === "same-pair";
  const partial = process.env.RELAY_TRANSFER_SCENARIO === "partial-target";
  let targetFetched = false;
  let upstream: ClientRequest | undefined;
  let uploadStarted = false;
  let corruptStatus: number | undefined;
  let uploads = 0;
  const sink = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/transfers") {
      res.writeHead(404).end();
      return;
    }
    if (corrupt) {
      uploads++;
      void (async () => {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024 * 1024)
            throw new Error("Fixture upload exceeds bound");
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);
        const divider = body.indexOf("\r\n\r\n");
        assert.ok(divider >= 0 && divider < 1024);
        assert.match(body.subarray(0, divider).toString(), /name="archive"/);
        const start = divider + 4;
        assert.equal(body.subarray(start, start + 3).toString("hex"), "1f8b08");
        assert.equal(body[start + 3] & 2, 0); // No optional gzip header CRC.
        body[start + 4] ^= 1; // MTIME byte: extraction still succeeds, checksum must not.
        const response = await fetch(`${target.origin}/api/transfers`, {
          method: "POST",
          headers: {
            "content-type": req.headers["content-type"] ?? "",
            authorization: req.headers.authorization ?? "",
          },
          body: new Uint8Array(body),
          signal: AbortSignal.timeout(15000),
        });
        corruptStatus = response.status;
        await response.body?.cancel();
        res.writeHead(response.status).end();
      })().catch(() => res.writeHead(502).end());
      return;
    }
    // Hold the transfer open after its first body chunk: no acknowledgement or destination write.
    req.once("data", (chunk: Buffer) => {
      uploadStarted = chunk.length > 0;
      req.pause();
      if (partial) {
        upstream = request(
          `${target.origin}/api/transfers`,
          {
            method: "POST",
            headers: {
              "content-type": req.headers["content-type"],
              authorization: req.headers.authorization,
            },
          },
          (response) => response.resume(),
        );
        upstream.on("error", () => {});
        upstream.write(chunk);
      }
    });
    req.on("error", () => {});
  });
  let reportDropped = false;
  let completion: boolean | undefined;
  let failure = false;
  const pool = stagingPool();
  const ledger = transferLedger(pool);
  const [
    sourceId,
    targetId,
    sourceAllocation,
    targetAllocation,
    owner,
    nest,
    egg,
  ] = Array.from({ length: 7 }, () => randomUUID());
  let transferId: string | undefined;
  const document = Buffer.from(mumble ? mumbleEgg : reviewedHttpEggs[1]);
  const profile = transferProfile(document);
  assert.ok(profile);
  const workloadId = mumble
    ? process.env.RELAY_MUMBLE_TRANSFER_UUID
    : randomUUID();
  assert.ok(workloadId);
  const selected = profile.workload(
    (result) => {
      installed = result.successful;
    },
    {
      uuid: workloadId,
      name: mumble ? "Mumble transfer" : "HTTP transfer",
      eggId: egg,
      port: 25610,
    },
    "beta",
    mumble ? "37" : null,
  );
  assert.ok(selected);
  const fixture = selected;
  const destination = profile.workload(
    () => {},
    { uuid: fixture.uuid, name: "HTTP transfer", eggId: egg, port: 25611 },
    "beta",
    mumble ? "37" : null,
  );
  assert.ok(destination);
  let siblingInstalled: boolean | undefined;
  let siblingDropped = false;
  const siblingId = randomUUID(),
    siblingFrom = randomUUID(),
    siblingTo = randomUUID();
  const siblingSource = pair
    ? profile.workload(
        (result) => {
          siblingInstalled = result.successful;
        },
        { uuid: siblingId, name: "Sibling transfer", eggId: egg, port: 25612 },
        "alpha",
      )
    : undefined;
  const siblingDestination = pair
    ? profile.workload(
        () => {},
        { uuid: siblingId, name: "Sibling transfer", eggId: egg, port: 25613 },
        "alpha",
      )
    : undefined;
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  await app.register(
    (instance) =>
      registerRemote(
        instance,
        source,
        fixture,
        {
          lookup: async (id) =>
            id === fixture.uuid
              ? fixture
              : id === siblingId
                ? siblingSource
                : undefined,
          list: async () =>
            installed === true
              ? {
                  data: [{ uuid: fixture.uuid, ...fixture.configuration }],
                  total: 1,
                }
              : { data: [], total: 0 },
        },
        async (id, ok) => {
          if (
            id !== fixture.uuid ||
            ok ||
            !(await ledger.placement(id, targetId))
          )
            return false;
          failure = true;
          return true;
        },
      ),
    { prefix: "/source/api/remote" },
  );
  await app.register(
    (instance) =>
      registerRemote(
        instance,
        target,
        undefined,
        {
          lookup: async (id) => {
            if (
              pair &&
              id === siblingId &&
              (await ledger.placement(id, targetId))
            )
              return siblingDestination;
            if (pair && id === fixture.uuid && completion === true)
              return destination;
            if (id !== fixture.uuid || !(await ledger.placement(id, targetId)))
              return undefined;
            targetFetched = true;
            return destination;
          },
          list: async () => ({ data: [], total: 0 }),
        },
        async (id, ok) => {
          if (
            pair &&
            id === siblingId &&
            ok &&
            (await ledger.placement(id, targetId))
          ) {
            siblingDropped = true;
            return false;
          }
          if (pair && id === fixture.uuid && ok && receiver) {
            const result = await receiver.inject({
              method: "POST",
              url: `/api/remote/servers/${id}/transfer/success`,
              headers: {
                authorization: `Bearer ${target.tokenId}.${target.token}`,
              },
            });
            return result.statusCode === 204;
          }
          if (id !== fixture.uuid || !(await ledger.placement(id, targetId)))
            return false;
          if (ok && dropReport) {
            reportDropped = true;
            return false;
          }
          if (ok && !(await ledger.reportDestination(id, targetId)))
            return false;
          completion ??= ok;
          return true;
        },
      ),
    { prefix: "/target/api/remote" },
  );
  const password = randomBytes(32).toString("hex");
  const uploadNode =
    interrupted || corrupt
      ? { ...target, origin: "http://127.0.0.1:18182" }
      : target;
  const transfer = fixtureTransferService(
    pool,
    { id: sourceId, node: source },
    { id: targetId, node: uploadNode },
    issuer,
  );
  const fixtureTransfer = {
    server: fixture.uuid,
    source: sourceId,
    target: targetId,
    allocation: targetAllocation,
    dispatch: transfer.dispatch,
    finalize: transfer.finalize,
  };
  const receiverKey = randomBytes(32),
    receiverPepper = randomBytes(32);
  const standalone = !interrupted && !dropReport && !corrupt;
  async function startInstance(
    role: "source" | "destination",
    node: WingsNode,
    port: number,
  ) {
    const processChild = spawn(
      process.execPath,
      ["--import", "tsx", "api/server.ts"],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          RELAY_API_PORT: String(port),
          RELAY_ORIGIN: panelOrigin,
          RELAY_TOTP_KEY: randomBytes(32).toString("base64"),
          RELAY_TOKEN_PEPPER: receiverPepper.toString("base64"),
          RELAY_NODE_KEY: receiverKey.toString("base64"),
          RELAY_ENABLE_EMPTY_WINGS_TEST_NODE: "1",
          RELAY_ENABLE_DISPOSABLE_PROVISIONING: "1",
          RELAY_CATALOG_NODE_ORIGIN: node.origin,
          RELAY_WINGS_TEST_ORIGIN: node.origin,
          RELAY_WINGS_TEST_TOKEN_ID: node.tokenId,
          RELAY_WINGS_TEST_TOKEN: node.token,
          RELAY_FIXTURE_TRANSFER_ROLE: role,
          ...(pair
            ? {
                RELAY_FIXTURE_TRANSFER_SECOND_SERVER: siblingId,
                RELAY_FIXTURE_TRANSFER_SECOND_ALLOCATION: siblingTo,
              }
            : {}),
          RELAY_FIXTURE_TRANSFER_SERVER: fixture.uuid,
          RELAY_FIXTURE_TRANSFER_SOURCE: sourceId,
          RELAY_FIXTURE_TRANSFER_TARGET: targetId,
          RELAY_FIXTURE_TRANSFER_ALLOCATION: targetAllocation,
        },
      },
    );
    const url = `http://127.0.0.1:${port}`;
    const close = async () => {
      if (processChild.exitCode !== null || processChild.signalCode !== null)
        return;
      const stopped = once(processChild, "exit");
      processChild.kill("SIGTERM");
      const timer = setTimeout(() => processChild.kill("SIGKILL"), 5000);
      try {
        await stopped;
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      await eventually(`standalone ${role} readiness`, async () => {
        if (processChild.exitCode !== null)
          throw new Error(`Standalone ${role} process exited`);
        try {
          return (
            await fetch(`${url}/health/ready`, {
              signal: AbortSignal.timeout(1000),
            })
          ).ok;
        } catch {
          return false;
        }
      });
    } catch (error) {
      await close();
      throw error;
    }
    return {
      close,
      inject: async <T = unknown>(options: {
        method?: string;
        url: string;
        headers?: Record<string, string>;
        payload?: object;
      }) => {
        const result = await fetch(`${url}${options.url}`, {
          method: options.method ?? "GET",
          headers: {
            ...options.headers,
            ...(options.payload ? { "content-type": "application/json" } : {}),
          },
          body: options.payload ? JSON.stringify(options.payload) : undefined,
          signal: AbortSignal.timeout(12000),
        });
        const text = await result.text();
        return {
          statusCode: result.status,
          headers: result.headers,
          json: <R = T>() => JSON.parse(text) as R,
        };
      },
    };
  }
  let receiver: Awaited<ReturnType<typeof startInstance>> | undefined;
  let sourceApp: Awaited<ReturnType<typeof startInstance>> | undefined;
  const networkLogin = async (instance: NonNullable<typeof sourceApp>) => {
    const response = await instance.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: browserHeaders,
      payload: { email: "transfer@example.test", password },
    });
    assert.equal(response.statusCode, 200);
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-relay_session="));
    assert.ok(cookie);
    assert.ok(cookie.includes("Secure") && cookie.includes("HttpOnly"));
    return { ...browserHeaders, cookie: cookie.split(";", 1)[0] };
  };
  const adminApp = await panel(pool, source, fixtureTransfer);
  try {
    await migrate(pool, "up");
    await pool.execute(
      "INSERT INTO users (id,email,display_name,password_hash,is_admin) VALUES (?,'transfer@example.test','Fixture',?,1)",
      [owner, await passwordHash(password)],
    );
    await pool.execute("INSERT INTO nests (id,name) VALUES (?,'Fixture')", [
      nest,
    ]);
    await pool.execute(
      "INSERT INTO eggs (id,nest_id,name,version,document) VALUES (?,?,'Fixture','PTDL_v2',?)",
      [egg, nest, document],
    );
    for (const [id, n, a, port] of [
      [sourceId, source, sourceAllocation, 25610],
      [targetId, target, targetAllocation, 25611],
    ] as const) {
      await pool.execute(
        "INSERT INTO nodes (id,name,origin,token_id,token_cipher) VALUES (?,?,?,?,?)",
        [
          id,
          n.tokenId,
          n.origin,
          n.tokenId,
          cryptoContext(receiverKey, receiverPepper, "node-token").seal(
            Buffer.from(n.token),
            id,
          ),
        ],
      );
      await pool.execute(
        "INSERT INTO allocations (id,node_id,ip,port) VALUES (?,?,'127.0.0.1',?)",
        [a, id, port],
      );
    }
    await pool.execute(
      "INSERT INTO servers (id,name,node_id,owner_id,egg_id,allocation_id,fixture_mode,mumble_max_users) VALUES (?,'Fixture',?,?,?,?,?,?)",
      [
        fixture.uuid,
        sourceId,
        owner,
        egg,
        sourceAllocation,
        mumble ? null : "beta",
        mumble ? "37" : null,
      ],
    );
    if (pair) {
      await pool.execute(
        "INSERT INTO allocations (id,node_id,ip,port) VALUES (?,?,'127.0.0.1',25612),(?,?,'127.0.0.1',25613)",
        [siblingFrom, sourceId, siblingTo, targetId],
      );
      await pool.execute(
        "INSERT INTO servers (id,name,node_id,owner_id,egg_id,allocation_id,fixture_mode) VALUES (?,'Sibling',?,?,?,?,'alpha')",
        [siblingId, sourceId, owner, egg, siblingFrom],
      );
    }
    await app.listen({ port: 13201, host: "127.0.0.1" });
    if (standalone)
      receiver = await startInstance("destination", target, 13202);
    if (!interrupted) sourceApp = await startInstance("source", source, 13203);
    const from = new WingsClient(source),
      to = new WingsClient(target);
    for (const client of [from, to])
      await eventually("daemon health", async () => {
        try {
          await client.health();
          return true;
        } catch {
          return false;
        }
      });
    await from.create(fixture.uuid);
    await eventually(
      "source installation",
      () => installed !== undefined,
      mumble ? 160 : 45,
    );
    assert.equal(installed, true);
    assert.equal(await from.state(fixture.uuid), "offline");
    if (mumble) {
      await from.power(fixture.uuid, "start");
      await eventually(
        "existing Mumble running",
        async () => (await from.state(fixture.uuid)) === "running",
      );
      await from.power(fixture.uuid, "stop");
      await eventually(
        "existing Mumble offline",
        async () => (await from.state(fixture.uuid)) === "offline",
      );
    }
    let siblingDigest: string | undefined;
    if (pair) {
      assert.ok(siblingSource && siblingDestination);
      await from.create(siblingId);
      await eventually(
        "sibling installed",
        () => siblingInstalled !== undefined,
      );
      assert.equal(siblingInstalled, true);
      const sourceRoot = process.env.RELAY_TRANSFER_SOURCE_ROOT;
      assert.ok(sourceRoot);
      await promisify(execFile)(
        "sudo",
        ["-n", "touch", `${sourceRoot}/volumes/${siblingId}/.sibling-only`],
        { timeout: 5000 },
      );
      siblingDigest = await from.transferTreeDigest(siblingId);
      await pool.execute(
        "INSERT INTO wings_provisions (server_id,phase) VALUES (?,'installed')",
        [siblingId],
      );
    }
    const original = await from.readFixtureFile(fixture.uuid, profile.path);
    assert.ok(original.includes(profile.marker));
    const callbackPath = `/api/remote/servers/${fixture.uuid}/transfer/success`;
    const forged = await (receiver ?? app).inject({
      method: "POST",
      url: receiver ? callbackPath : `/target${callbackPath}`,
      headers: { authorization: `Bearer ${source.tokenId}.${source.token}` },
    });
    assert.equal(forged.statusCode, 401);
    const destinationAuth = {
      authorization: `Bearer ${target.tokenId}.${target.token}`,
    };
    if (receiver)
      assert.equal(
        (
          await receiver.inject({
            method: "POST",
            url: callbackPath,
            headers: destinationAuth,
          })
        ).statusCode,
        404,
      );
    await pool.execute(
      "INSERT INTO wings_provisions (server_id,phase) VALUES (?,'installed')",
      [fixture.uuid],
    );
    const sourceToken = signTransferCapability(source, issuer, fixture.uuid);
    const rejected = await fetch(`${target.origin}/api/transfers`, {
      method: "POST",
      headers: { authorization: `Bearer ${sourceToken}` },
      signal: AbortSignal.timeout(3000),
    });
    assert.ok(!rejected.ok);
    await rejected.body?.cancel();
    assert.equal(completion, undefined);
    if (interrupted || corrupt)
      await new Promise<void>((resolve, reject) => {
        sink.once("error", reject);
        sink.listen(18182, "127.0.0.1", resolve);
      });
    const url = `/api/v1/admin/servers/${fixture.uuid}/transfer`;
    const headers = sourceApp
      ? await networkLogin(sourceApp)
      : await login(adminApp, password);
    const request = sourceApp ?? adminApp;
    const payload = {
      confirm: true,
      nodeId: targetId,
      allocationId: targetAllocation,
    };
    assert.equal(
      (
        await request.inject({
          method: "POST",
          url,
          headers: browserHeaders,
          payload,
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await request.inject({
          method: "POST",
          url,
          headers,
          payload: { ...payload, nodeId: sourceId },
        })
      ).statusCode,
      404,
    );
    const siblingUrl = `/api/v1/admin/servers/${siblingId}/transfer`;
    const [response, siblingResponse] = await Promise.all([
      request.inject({
        method: "POST",
        url,
        headers,
        payload,
      }),
      pair
        ? request.inject({
            method: "POST",
            url: siblingUrl,
            headers,
            payload: { ...payload, allocationId: siblingTo },
          })
        : undefined,
    ]);
    const siblingTransfer = siblingResponse?.json<{ id: string }>().id;
    if (pair) {
      assert.equal(siblingResponse?.statusCode, 202);
      assert.ok(siblingTransfer);
    }
    assert.equal(response.statusCode, 202);
    transferId = response.json<{ id: string; phase: string }>().id;
    assert.ok(transferId);
    assert.equal(
      (await request.inject({ method: "POST", url, headers, payload }))
        .statusCode,
      409,
    );
    assert.deepEqual(
      await rows(
        pool,
        "SELECT actor_id FROM audit_log WHERE event='catalog.transfer_reserved' AND subject_id=?",
        [fixture.uuid],
      ),
      [{ actor_id: owner }],
    );
    if (interrupted) {
      await eventually(
        "first upload chunk",
        () => uploadStarted && (!partial || targetFetched),
      );
      await promisify(execFile)(
        "docker",
        ["kill", "--signal", "KILL", "relay-transfer-source"],
        { timeout: 10000 },
      );
      if (partial) {
        upstream?.destroy();
        await eventually(
          "destination failure callback",
          () => completion !== undefined,
        );
        assert.equal(completion, false);
        const path = process.env.RELAY_TRANSFER_FIXTURE_ROOT;
        assert.ok(path?.startsWith("/tmp/tmp."));
        const { stdout } = await promisify(execFile)(
          "sudo",
          ["-n", "stat", "--format=%F", "--", `${path}/volumes`],
          { timeout: 5000 },
        );
        assert.equal(stdout.trim(), "directory");
        await promisify(execFile)(
          "sudo",
          ["-n", "test", "!", "-e", `${path}/volumes/${fixture.uuid}`],
          { timeout: 5000 },
        );
      } else {
        assert.equal(completion, undefined);
      }
    } else if (corrupt) {
      await eventually(
        "corrupt upload refusal and destination failure",
        () => corruptStatus !== undefined && completion !== undefined,
      );
      assert.equal(corruptStatus, 500);
      assert.equal(completion, false);
      assert.equal(uploads, 1);
    } else if (receiver) {
      await eventually("application destination callback", async () =>
        Boolean(await ledger.reported(transferId ?? "")),
      );
      assert.equal(
        (
          await receiver.inject({
            method: "POST",
            url: callbackPath,
            headers: destinationAuth,
          })
        ).statusCode,
        404,
      );
      completion = true;
    } else {
      await eventually(
        "destination callback",
        () => failure || reportDropped || completion !== undefined,
      );
      assert.equal(failure, false);
    }
    if (dropReport || interrupted || corrupt) {
      assert.equal(completion, partial || corrupt ? false : undefined);
      if (interrupted || corrupt) {
        await assert.rejects(to.state(fixture.uuid), { reason: "not_found" });
      } else {
        assert.equal(reportDropped, true);
        assert.equal(await to.state(fixture.uuid), "offline");
        assert.equal(
          digest(await to.readFixtureFile(fixture.uuid, profile.path)),
          digest(original),
        );
      }
      await pool.execute(
        "UPDATE wings_transfers SET dispatched_at=UTC_TIMESTAMP(3)-INTERVAL 6 MINUTE WHERE id=?",
        [transferId],
      );
      const recoveredPool = stagingPool();
      try {
        await adminApp.close();
        if (sourceApp) {
          await sourceApp.close();
          sourceApp = await startInstance("source", source, 13203);
        }
        const recoveredApp = sourceApp
          ? undefined
          : await panel(recoveredPool, source, fixtureTransfer);
        try {
          const recoveryHeaders = sourceApp
            ? await networkLogin(sourceApp)
            : recoveredApp
              ? await login(recoveredApp, password)
              : undefined;
          const recoveryApi = sourceApp ?? recoveredApp;
          assert.ok(recoveryHeaders && recoveryApi);
          const status = await recoveryApi.inject({
            url,
            headers: recoveryHeaders,
          });
          assert.equal(status.statusCode, 200);
          assert.equal(status.json<{ phase: string }>().phase, "reserved");
          const response = await recoveryApi.inject({
            method: "POST",
            url: `${url}/reconcile`,
            headers: recoveryHeaders,
            payload: { confirm: true },
          });
          assert.equal(response.statusCode, 200);
          assert.equal(response.json<{ phase: string }>().phase, "uncertain");
        } finally {
          await recoveredApp?.close();
        }
        const recovered = transferLedger(recoveredPool);
        assert.equal(
          await recovered.claim(transferId, digest(original)),
          false,
        );
        assert.equal(
          await recovered.reportDestination(fixture.uuid, targetId),
          false,
        );
        assert.equal(
          await recovered.settle(transferId, {
            kind: "verified_destination",
            node: targetId,
            server: fixture.uuid,
          }),
          false,
        );
        assert.deepEqual(
          await rows(
            recoveredPool,
            "SELECT phase,active_allocation,destination_reported_at FROM wings_transfers WHERE id=?",
            [transferId],
          ),
          [
            {
              phase: "uncertain",
              active_allocation: targetAllocation,
              destination_reported_at: null,
            },
          ],
        );
        assert.deepEqual(
          await rows(
            recoveredPool,
            "SELECT node_id,allocation_id FROM servers WHERE id=?",
            [fixture.uuid],
          ),
          [{ node_id: sourceId, allocation_id: sourceAllocation }],
        );
      } finally {
        await recoveredPool.end();
      }
      if (interrupted) {
        await promisify(execFile)(
          "docker",
          ["start", "relay-transfer-source"],
          { timeout: 10000 },
        );
        await eventually("source rediscovery", async () => {
          try {
            return (await from.state(fixture.uuid)) === "offline";
          } catch {
            return false;
          }
        });
      }
      assert.equal(
        digest(await from.readFixtureFile(fixture.uuid, profile.path)),
        digest(original),
      );
      // Dispose both copies only after checking that reconciliation preserved them.
      if (!interrupted && !corrupt) await to.remove(fixture.uuid);
      if (corrupt) assert.equal(uploads, 1);
      await from.remove(fixture.uuid);
      console.log(
        "Missing destination report quarantined; source and reservation preserved before fixture teardown",
      );
      return;
    }
    assert.equal(completion, true);
    await adminApp.close();
    if (!pair) await app.close();
    assert.ok(sourceApp);
    await sourceApp.close();
    sourceApp = await startInstance("source", source, 13203);
    const recoveredHeaders = await networkLogin(sourceApp);
    if (pair) {
      assert.ok(siblingTransfer && siblingDigest);
      await eventually(
        "sibling destination report dropped",
        () => siblingDropped,
      );
      assert.equal(await to.transferTreeDigest(siblingId), siblingDigest);
      await pool.execute(
        "UPDATE wings_transfers SET dispatched_at=UTC_TIMESTAMP(3)-INTERVAL 6 MINUTE WHERE id=?",
        [siblingTransfer],
      );
      const quarantine = await sourceApp.inject({
        method: "POST",
        url: `${siblingUrl}/reconcile`,
        headers: recoveredHeaders,
        payload: { confirm: true },
      });
      assert.equal(quarantine.statusCode, 200);
      assert.equal(quarantine.json<{ phase: string }>().phase, "uncertain");
      assert.equal(await ledger.claim(siblingTransfer, siblingDigest), false);
      assert.deepEqual(
        await rows(
          pool,
          "SELECT phase,active_allocation,fixture_digest,destination_reported_at FROM wings_transfers WHERE id=?",
          [siblingTransfer],
        ),
        [
          {
            phase: "uncertain",
            active_allocation: siblingTo,
            fixture_digest: siblingDigest,
            destination_reported_at: null,
          },
        ],
      );
      assert.deepEqual(
        await rows(
          pool,
          "SELECT node_id,allocation_id FROM servers WHERE id=?",
          [siblingId],
        ),
        [{ node_id: sourceId, allocation_id: siblingFrom }],
      );
      assert.equal(await from.transferTreeDigest(siblingId), siblingDigest);
    }
    const finish = {
      method: "POST",
      url: `${url}/finalize`,
      headers: recoveredHeaders,
      payload: { confirm: true, transferId },
    };
    assert.equal(
      (
        await sourceApp.inject({
          ...finish,
          payload: { ...finish.payload, transferId: randomUUID() },
        })
      ).statusCode,
      409,
    );
    await pool.execute("UPDATE users SET is_admin=0 WHERE id=?", [owner]);
    assert.equal((await sourceApp.inject(finish)).statusCode, 403);
    await pool.execute("UPDATE users SET is_admin=1 WHERE id=?", [owner]);
    const treeRoot = process.env.RELAY_TRANSFER_FIXTURE_ROOT;
    assert.ok(treeRoot);
    const unexpectedFile = `${treeRoot}/volumes/${fixture.uuid}/.unexpected.bin`;
    await promisify(execFile)("sudo", ["-n", "touch", unexpectedFile], {
      timeout: 5000,
    });
    try {
      assert.equal((await sourceApp.inject(finish)).statusCode, 409);
      assert.deepEqual(
        await rows(pool, "SELECT node_id FROM servers WHERE id=?", [
          fixture.uuid,
        ]),
        [{ node_id: sourceId }],
      );
    } finally {
      await promisify(execFile)("sudo", ["-n", "rm", "--", unexpectedFile], {
        timeout: 5000,
      });
    }
    assert.equal((await sourceApp.inject(finish)).statusCode, 200);
    assert.equal((await sourceApp.inject(finish)).statusCode, 409);
    assert.deepEqual(
      await rows(
        pool,
        "SELECT actor_id FROM audit_log WHERE event='catalog.transfer_completed' AND subject_id=?",
        [fixture.uuid],
      ),
      [{ actor_id: owner }],
    );
    assert.deepEqual(
      await rows(pool, "SELECT node_id,allocation_id FROM servers WHERE id=?", [
        fixture.uuid,
      ]),
      [{ node_id: targetId, allocation_id: targetAllocation }],
    );
    assert.equal(await from.state(fixture.uuid), "offline");
    assert.equal(
      digest(await from.readFixtureFile(fixture.uuid, profile.path)),
      digest(original),
    );
    // Nested Docker can transfer files but some runners cannot delegate cgroup controllers.
    if (process.env.RELAY_TRANSFER_CHECK_DESTINATION_RUNTIME === "1") {
      await to.power(fixture.uuid, "start");
      await eventually(
        "transferred workload running",
        async () => (await to.state(fixture.uuid)) === "running",
      );
      if (mumble) {
        const ini = await to.readFixtureFile(fixture.uuid, "murmur.ini");
        assert.match(ini, /^users\s*=\s*37$/m);
        assert.match(ini, /^port\s*=\s*25611$/m);
      }
      await to.power(fixture.uuid, "stop");
      await eventually(
        "transferred workload offline",
        async () => (await to.state(fixture.uuid)) === "offline",
      );
    }
    if (pair) {
      await to.remove(siblingId);
      await from.remove(siblingId);
    }
    await to.remove(fixture.uuid);
    await from.remove(fixture.uuid);
    console.log(
      "Wings-to-Wings transfer verified on independent Docker engines; archive matched and source preserved before cleanup",
    );
  } finally {
    await sourceApp?.close();
    await receiver?.close();
    await adminApp.close();
    await app.close();
    upstream?.destroy();
    sink.closeAllConnections();
    sink.close();
    await pool.end();
  }
}
void main().catch((error) => {
  console.error(
    `::error::${error instanceof Error ? error.message : "Transfer contract failed"}`,
  );
  process.exitCode = 1;
});
