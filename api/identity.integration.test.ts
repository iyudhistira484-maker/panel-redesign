import { transferLedger } from "./catalog/transfer";
import { disposableEgg } from "./wings/provision";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import bcrypt from "bcryptjs";
import { createApp, type ResetMessage } from "./app";
import { stagingPool, rows } from "./db";
import { migrate } from "./migrate";
import { totpAt } from "./security";

const enabled = process.env.RELAY_RUN_MYSQL_TESTS === "1";
test(
  "MySQL: migration, session rotation, 2FA, password reset and account isolation",
  { skip: !enabled },
  async () => {
    assert.match(
      process.env.RELAY_STAGING_DATABASE_URL ?? "",
      /\/relay_test$/,
      "Use the disposable relay_test database",
    );
    const pool = stagingPool();
    const origin = "https://relay.example.test";
    const deliveries: ResetMessage[] = [];
    const token = randomBytes(32).toString("hex");
    let creates = 0;
    const daemon = createServer((req, res) => {
      if (
        req.url === "/api/servers" &&
        req.method === "POST" &&
        req.headers.authorization === `Bearer ${token}`
      ) {
        creates++;
        req.resume();
        res.writeHead(502).end();
        return;
      }
      if (
        req.url !== "/api/system" ||
        req.headers.authorization !== `Bearer ${token}`
      ) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          version: "v1.13.5",
          architecture: "amd64",
          cpu_count: 2,
          os: "linux",
        }),
      );
    });
    await new Promise<void>((resolve) =>
      daemon.listen(0, "127.0.0.1", resolve),
    );
    const addr = daemon.address();
    assert.ok(addr && typeof addr !== "string");
    const daemonOrigin = `http://127.0.0.1:${addr.port}`;
    const app = await createApp({
      pool,
      origin,
      key: randomBytes(32),
      catalogNodeKey: randomBytes(32),
      enableDisposableProvisioning: true,
      wingsTestNode: { origin: daemonOrigin, tokenId: "fixture-test", token },
      allowedCatalogNodeOrigins: [daemonOrigin, "http://127.0.0.1:18081"],
      pepper: randomBytes(32),
      deliverReset: async (message) => {
        deliveries.push(message);
      },
    });
    const request = (
      method: "GET" | "POST" | "DELETE" | "PATCH",
      path: string,
      body?: object,
      cookie?: string,
      authorization?: string,
    ) =>
      app.inject({
        method,
        url: `/api/v1/${path}`,
        headers: {
          origin,
          "x-relay-request": "1",
          ...(cookie ? { cookie } : {}),
          ...(authorization ? { authorization } : {}),
        },
        payload: body,
      });
    type Result = Awaited<ReturnType<typeof request>>;
    function ok(result: Result, status: number) {
      assert.equal(
        result.statusCode,
        status,
        `${status} expected: ${result.body}`,
      );
      return result;
    }
    function session(result: Result) {
      const cookie = result.cookies.find(
        (c) => c.name === "__Host-relay_session",
      );
      assert.ok(cookie?.secure && cookie.httpOnly);
      assert.equal(cookie.sameSite, "Strict");
      return `${cookie.name}=${cookie.value}`;
    }
    const pw = "fixture password for staging only";
    try {
      await migrate(pool, "up");
      await migrate(pool, "up");
      const alice = randomUUID(),
        bob = randomUUID();
      const old = (await bcrypt.hash(pw, 4)).replace(/^\$2b\$/, "$2y$");
      for (const [id, name] of [
        [alice, "alice"],
        [bob, "bob"],
      ])
        await pool.execute(
          "INSERT INTO users (id,email,display_name,password_hash) VALUES (?,?,?,?)",
          [id, `${name}@example.test`, name, old],
        );
      const login = (user: string, password = pw, cookie?: string) =>
        request(
          "POST",
          "auth/login",
          { email: `${user}@example.test`, password },
          cookie,
        );
      ok(await login("alice", "wrong"), 401);
      const first = session(ok(await login("alice"), 200));
      const a = session(ok(await login("alice", pw, first), 200));
      assert.notEqual(first, a);
      ok(await request("GET", "account", undefined, first), 401);
      const b = session(ok(await login("bob"), 200));
      const admin = randomUUID();
      await pool.execute(
        "INSERT INTO users (id,email,display_name,password_hash,is_admin) VALUES (?,?,?,?,1)",
        [admin, "admin@example.test", "Admin", old],
      );
      const operator = session(ok(await login("admin"), 200));
      const getAdmin = (path: string, cookie?: string) =>
        request("GET", `admin/${path}`, undefined, cookie);
      const postAdmin = (path: string, body: object, cookie = operator) =>
        request("POST", `admin/${path}`, body, cookie);
      const createdId = (result: Result) =>
        ok(result, 201).json<{ id: string }>().id;
      ok(await getAdmin("nodes"), 401);
      ok(await getAdmin("nodes", a), 403);
      ok(await postAdmin("nests", { name: "Not allowed" }, b), 403);
      const nodeBody = {
        name: "Fixture",
        origin: daemonOrigin,
        tokenId: "fixture-test",
        token,
      };
      ok(
        await postAdmin("nodes", { ...nodeBody, origin: "http://127.0.0.1:1" }),
        422,
      );
      const nodeId = createdId(await postAdmin("nodes", nodeBody));
      const anotherNode = createdId(
        await postAdmin("nodes", {
          ...nodeBody,
          origin: "http://127.0.0.1:18081",
          tokenId: "other-fixture",
        }),
      );
      ok(await postAdmin("nodes", nodeBody), 409);
      const nodes = ok(await getAdmin("nodes", operator), 200).json();
      assert.equal(nodes.length, 2);
      assert.equal(nodes[0].token, undefined);
      assert.equal(nodes[0].token_id, undefined);
      assert.equal(nodes[0].token_cipher, undefined);
      const encrypted = (
        await rows<{ token_cipher: Buffer }>(
          pool,
          "SELECT token_cipher FROM nodes WHERE id=?",
          [nodeId],
        )
      )[0].token_cipher;
      assert.ok(!encrypted.includes(Buffer.from(token)));
      assert.equal(
        ok(await getAdmin(`nodes/${nodeId}/health`, operator), 200).json()
          .version,
        "1.13.5",
      );
      const nestId = createdId(await postAdmin("nests", { name: "Fixtures" }));
      const eggText = `${JSON.stringify({ meta: { version: "PTDL_v1" }, name: "Tiny shell", image: "alpine:3.22.2", config: {}, scripts: { installation: {} }, variables: [] }, null, 2)}\n`;
      const eggId = createdId(
        await postAdmin("eggs", { nestId, document: eggText }),
      );
      const attachment = ok(
        await getAdmin(`eggs/${eggId}/document`, operator),
        200,
      );
      assert.equal(attachment.body, eggText);
      assert.match(
        String(attachment.headers["content-disposition"]),
        /^attachment/,
      );
      ok(await postAdmin("eggs", { nestId, document: "invalid" }), 422);
      ok(
        await postAdmin("allocations", {
          nodeId,
          ip: "192.0.2.10",
          port: 25610,
        }),
        422,
      );
      const allocation = { nodeId, ip: "127.0.0.1", port: 25610 };
      const allocationId = createdId(
        await postAdmin("allocations", allocation),
      );
      ok(await postAdmin("allocations", allocation), 409);
      const draft = {
        name: "Draft",
        nodeId,
        ownerId: alice,
        eggId,
        allocationId,
      };
      ok(await postAdmin("servers", { ...draft, nodeId: anotherNode }), 409);
      const serverId = createdId(await postAdmin("servers", draft));
      ok(await postAdmin("servers", draft), 409);
      await migrate(pool, "up");
      assert.deepEqual(ok(await getAdmin("servers", operator), 200).json(), [
        { ...draft, id: serverId, status: "draft" },
      ]);
      assert.ok(
        (
          await rows<{ event: string }>(
            pool,
            "SELECT event FROM audit_log WHERE subject_id=?",
            [serverId],
          )
        ).some((entry) => entry.event === "catalog.server_draft_created"),
      );
      ok(
        await postAdmin(`servers/${serverId}/provision`, { confirm: true }),
        422,
      );
      assert.equal(creates, 0);
      const approvedEggId = createdId(
        await postAdmin("eggs", { nestId, document: disposableEgg }),
      );
      const spareAllocationId = createdId(
        await postAdmin("allocations", { ...allocation, port: 25611 }),
      );
      const approvedId = createdId(
        await postAdmin("servers", {
          ...draft,
          eggId: approvedEggId,
          allocationId: spareAllocationId,
        }),
      );
      const action = `servers/${approvedId}/provision`;
      ok(await postAdmin(action, { confirm: true }, a), 403);
      assert.equal(
        ok(await postAdmin(action, { confirm: true }), 202).json().phase,
        "uncertain",
      );
      ok(await postAdmin(action, { confirm: true }), 409);
      assert.equal(creates, 1);
      const reconcile = `servers/${approvedId}/reconcile`;
      ok(await postAdmin(reconcile, { confirm: true }, a), 403);
      ok(await postAdmin(reconcile, { confirm: false }), 400);
      assert.deepEqual(
        ok(await postAdmin(reconcile, { confirm: true }), 200).json(),
        { phase: "uncertain", presence: "unreachable", state: null },
      );
      ok(
        await postAdmin(`servers/${approvedId}/power`, {
          action: "start",
          confirm: true,
        }),
        409,
      );
      assert.equal(creates, 1);
      ok(
        await postAdmin(`servers/${approvedId}/delete`, { confirm: true }, a),
        403,
      );
      ok(
        await postAdmin(`servers/${approvedId}/delete`, { confirm: true }),
        409,
      );
      ok(
        await postAdmin(`servers/${approvedId}/reinstall`, { confirm: true }),
        409,
      );
      ok(await getAdmin(`servers/${approvedId}/console`, a), 403);
      ok(await getAdmin(`servers/${approvedId}/console`, operator), 409);
      ok(await getAdmin(`servers/${approvedId}/stats`, a), 403);
      ok(await getAdmin(`servers/${approvedId}/stats`, operator), 409);
      const callback = `/api/remote/servers/${approvedId}/install`;
      ok(
        await app.inject({
          method: "POST",
          url: callback,
          payload: { successful: false, reinstall: false },
        }),
        401,
      );
      ok(
        await app.inject({
          method: "POST",
          url: callback,
          headers: { authorization: `Bearer fixture-test.${token}` },
          payload: { successful: false, reinstall: false },
        }),
        204,
      );
      assert.equal(
        ok(await getAdmin(action, operator), 200).json().phase,
        "install_failed",
      );
      ok(await postAdmin(action, { confirm: true }), 409);
      assert.equal(creates, 1);
      const operatorKey = `rly_${randomBytes(32).toString("base64url")}`;
      const operatorSuffix = ok(
        await request(
          "POST",
          "account/keys",
          { label: "readonly", key: operatorKey },
          operator,
        ),
        201,
      ).json<{ suffix: string }>().suffix;
      ok(
        await request(
          "GET",
          "admin/servers",
          undefined,
          undefined,
          `Bearer ${operatorKey}.${operatorSuffix}`,
        ),
        403,
      );

      assert.match(
        (
          await rows<{ password_hash: string }>(
            pool,
            "SELECT password_hash FROM users WHERE id=?",
            [alice],
          )
        )[0].password_hash,
        /^\$argon2id\$/,
      );
      ok(await request("PATCH", "account", { locale: "en" }, a), 204);
      const clientKey = `rly_${randomBytes(32).toString("base64url")}`;
      const key = ok(
        await request(
          "POST",
          "account/keys",
          { label: "fixture", key: clientKey },
          a,
        ),
        201,
      ).json<{ id: string; suffix: string }>();
      const bearer = `Bearer ${clientKey}.${key.suffix}`;
      assert.equal(
        ok(
          await request("GET", "account", undefined, undefined, bearer),
          200,
        ).json().id,
        alice,
      );
      ok(await request("DELETE", `account/keys/${key.id}`, undefined, b), 404);
      assert.deepEqual(
        ok(await request("GET", "account/keys", undefined, b), 200).json(),
        [],
      );
      ok(await request("DELETE", `account/keys/${key.id}`, undefined, a), 204);
      ok(await request("GET", "account", undefined, undefined, bearer), 401);
      const seed = randomBytes(20),
        recoveryCodes = Array.from({ length: 10 }, () =>
          randomBytes(12).toString("base64url"),
        );
      ok(
        await request(
          "POST",
          "account/totp/begin",
          { seed: seed.toString("base64url"), password: pw },
          a,
        ),
        204,
      );
      const confirmation = totpAt(seed, Math.floor(Date.now() / 30000));
      const enrolled = session(
        ok(
          await request(
            "POST",
            "account/totp/confirm",
            { code: confirmation, recoveryCodes },
            a,
          ),
          204,
        ),
      );
      ok(await request("GET", "account", undefined, a), 401);
      const pendingResult = ok(await login("alice"), 200);
      assert.equal(pendingResult.json().twoFactorRequired, true);
      const pending = session(pendingResult);
      ok(await request("GET", "account", undefined, pending), 401);
      ok(
        await request(
          "POST",
          "auth/challenge",
          { code: confirmation },
          pending,
        ),
        401,
      );
      const elevated = session(
        ok(
          await request(
            "POST",
            "auth/challenge",
            { code: recoveryCodes[0] },
            pending,
          ),
          200,
        ),
      );
      ok(await request("GET", "account", undefined, pending), 401);
      const pending2 = session(ok(await login("alice"), 200));
      ok(
        await request(
          "POST",
          "auth/challenge",
          { code: recoveryCodes[0] },
          pending2,
        ),
        401,
      );
      ok(
        await request("POST", "auth/forgot-password", {
          email: "missing@example.test",
        }),
        202,
      );
      ok(
        await request("POST", "auth/forgot-password", {
          email: "alice@example.test",
        }),
        202,
      );
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].locale, "en");
      const reset = {
        token: deliveries[0].token,
        password: "new staging fixture password",
      };
      ok(await request("POST", "auth/reset-password", reset), 204);
      ok(await request("POST", "auth/reset-password", reset), 400);
      for (const c of [enrolled, elevated, pending2])
        ok(await request("GET", "account", undefined, c), 401);
      ok(await login("alice"), 401);
      const fresh = session(ok(await login("alice", reset.password), 200));
      const step = Math.floor(Date.now() / 30000) + 1;
      const live = session(
        ok(
          await request(
            "POST",
            "auth/challenge",
            { code: totpAt(seed, step) },
            fresh,
          ),
          200,
        ),
      );
      assert.ok(
        ok(await request("GET", "account/activity", undefined, live), 200)
          .json()
          .some(
            (event: { event: string }) =>
              event.event === "identity.password_reset",
          ),
      );
      ok(await request("POST", "auth/logout", undefined, live), 204);
      ok(await request("GET", "account", undefined, live), 401);
      ok(await app.inject("/health/ready"), 200);
      const targetAllocation = createdId(
        await postAdmin("allocations", { ...allocation, nodeId: anotherNode }),
      );
      await pool.execute(
        "INSERT INTO wings_provisions (server_id,phase) VALUES (?,'installed')",
        [serverId],
      );
      const ledger = transferLedger(pool);
      assert.equal(
        await ledger.reserve(serverId, nodeId, allocationId),
        undefined,
      );
      const attempts = await Promise.all([
        ledger.reserve(serverId, anotherNode, targetAllocation),
        ledger.reserve(serverId, anotherNode, targetAllocation),
      ]);
      assert.equal(attempts.filter(Boolean).length, 1);
      const firstTransfer = attempts[0] ?? attempts[1];
      assert.ok(firstTransfer);
      const destinationDraft = {
        ...draft,
        nodeId: anotherNode,
        allocationId: targetAllocation,
      };
      ok(await postAdmin("servers", destinationDraft), 409);
      assert.equal(
        await ledger.settle(firstTransfer, {
          kind: "verified_destination",
          node: nodeId,
          server: serverId,
        }),
        false,
      );
      assert.equal(
        await ledger.settle(firstTransfer, { kind: "not_dispatched" }),
        true,
      );
      const move = await ledger.reserve(
        serverId,
        anotherNode,
        targetAllocation,
      );
      assert.ok(move);
      assert.deepEqual(
        (
          await Promise.all([
            ledger.claim(move, "a".repeat(64)),
            ledger.claim(move, "a".repeat(64)),
          ])
        ).sort(),
        [false, true],
      );
      assert.equal(
        await ledger.settle(move, { kind: "not_dispatched" }),
        false,
      );
      assert.equal(
        await ledger.settle(move, {
          kind: "verified_destination",
          node: anotherNode,
          server: serverId,
        }),
        false,
      );
      assert.equal(await ledger.reportDestination(serverId, nodeId), false);
      assert.equal(await ledger.reportDestination(serverId, anotherNode), true);

      assert.equal(
        await ledger.settle(move, {
          kind: "verified_destination",
          node: anotherNode,
          server: serverId,
        }),
        true,
      );
      assert.equal(
        await ledger.settle(move, {
          kind: "verified_destination",
          node: anotherNode,
          server: serverId,
        }),
        false,
      );
      assert.deepEqual(
        await rows(
          pool,
          "SELECT node_id,allocation_id FROM servers WHERE id=?",
          [serverId],
        ),
        [{ node_id: anotherNode, allocation_id: targetAllocation }],
      );
      const reverse = await ledger.reserve(serverId, nodeId, allocationId);
      assert.ok(reverse);
      assert.equal(await ledger.claim(reverse, "a".repeat(64)), true);
      const endpoint = `servers/${serverId}/transfer`;
      ok(await getAdmin(endpoint), 401);
      ok(await getAdmin(endpoint, b), 403);
      ok(await getAdmin(`servers/${randomUUID()}/transfer`, operator), 404);
      const active = ok(await getAdmin(endpoint, operator), 200);
      assert.equal(active.headers["cache-control"], "no-store");
      assert.deepEqual(active.json(), {
        id: reverse,
        phase: "reserved",
        sourceNodeId: anotherNode,
        targetNodeId: nodeId,
        targetAllocationId: allocationId,
        claimed: 1,
        destinationReported: 0,
      });
      ok(await postAdmin(`${endpoint}/reconcile`, { confirm: false }), 400);
      ok(await postAdmin(`${endpoint}/reconcile`, { confirm: true }, b), 403);
      ok(await postAdmin(`${endpoint}/reconcile`, { confirm: true }), 409);
      await pool.execute(
        "UPDATE wings_transfers SET dispatched_at=UTC_TIMESTAMP(3)-INTERVAL 6 MINUTE WHERE id=?",
        [reverse],
      );
      assert.deepEqual(
        ok(
          await postAdmin(`${endpoint}/reconcile`, { confirm: true }),
          200,
        ).json(),
        { phase: "uncertain" },
      );
      ok(await postAdmin(`${endpoint}/reconcile`, { confirm: true }), 409);
      assert.equal(
        ok(await getAdmin(endpoint, operator), 200).json().phase,
        "uncertain",
      );
      assert.deepEqual(
        await rows(
          pool,
          "SELECT actor_id FROM audit_log WHERE event='catalog.transfer_quarantined' AND subject_id=?",
          [serverId],
        ),
        [{ actor_id: admin }],
      );
      assert.equal(await ledger.claim(reverse, "a".repeat(64)), false);
      assert.equal(await ledger.reportDestination(serverId, nodeId), false);
      assert.equal(
        await ledger.settle(reverse, { kind: "not_dispatched" }),
        false,
      );
      ok(await postAdmin("servers", draft), 409);
      assert.deepEqual(
        await rows(
          pool,
          "SELECT node_id,allocation_id FROM servers WHERE id=?",
          [serverId],
        ),
        [{ node_id: anotherNode, allocation_id: targetAllocation }],
      );
      await migrate(pool, "down");
      ok(await app.inject("/health/ready"), 503);
      await migrate(pool, "up");
      assert.deepEqual(await rows(pool, "SELECT id FROM users"), []);
    } finally {
      await app.close();
      await pool.end();
      await new Promise<void>((resolve, reject) =>
        daemon.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
