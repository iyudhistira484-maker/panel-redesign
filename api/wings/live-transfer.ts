import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { rows, stagingPool } from "../db";
import { migrate } from "../migrate";
import { transferLedger } from "../catalog/transfer";
import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { WingsClient, type WingsNode } from "./client";
import { lifecycleFixture } from "./lifecycle-fixture";
import { registerRemote } from "./remote";
import { signTransferCapability } from "./transfer-token";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const issuer = "http://127.0.0.1:13201";
async function eventually(label: string, fn: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 45; i++) {
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
  if (process.argv[2] === "recover") {
    const [, , , id, expected] = process.argv;
    assert.match(expected ?? "", /^[a-f0-9]{64}$/);
    const pool = stagingPool();
    try {
      const ledger = transferLedger(pool);
      const entry = await ledger.reported(id);
      assert.ok(entry);
      assert.equal(await ledger.claim(id), false);
      const to = new WingsClient(target),
        from = new WingsClient(source);
      assert.equal(await to.state(entry.server_id), "offline");
      assert.equal(
        digest(await to.readFixtureFile(entry.server_id, "relay-start.sh")),
        expected,
      );
      assert.equal(
        digest(await from.readFixtureFile(entry.server_id, "relay-start.sh")),
        expected,
      );
      assert.equal(
        await ledger.settle(id, {
          kind: "verified_destination",
          node: entry.target_node_id,
          server: entry.server_id,
        }),
        true,
      );
    } finally {
      await pool.end();
    }
    return;
  }
  let installed: boolean | undefined;
  const dropReport = process.env.RELAY_TRANSFER_SCENARIO === "missing-report";
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
  const fixture = lifecycleFixture((result) => {
    installed = result.successful;
  });
  const destination = lifecycleFixture(() => {}, {
    uuid: fixture.uuid,
    port: 25611,
    name: "Transfer destination fixture",
    eggId: "498aa323-143b-4ab2-ad9e-f3b711450fd0",
  });
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  await app.register(
    (instance) =>
      registerRemote(instance, source, fixture, undefined, async (id, ok) => {
        if (
          id !== fixture.uuid ||
          ok ||
          !(await ledger.placement(id, targetId))
        )
          return false;
        failure = true;
        return true;
      }),
    { prefix: "/source/api/remote" },
  );
  await app.register(
    (instance) =>
      registerRemote(
        instance,
        target,
        undefined,
        {
          lookup: async (id) =>
            id === fixture.uuid && (await ledger.placement(id, targetId))
              ? destination
              : undefined,
          list: async () => ({ data: [], total: 0 }),
        },
        async (id, ok) => {
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
  try {
    await migrate(pool, "up");
    await pool.execute(
      "INSERT INTO users (id,email,display_name,password_hash) VALUES (?,'transfer@example.test','Fixture','disabled')",
      [owner],
    );
    await pool.execute("INSERT INTO nests (id,name) VALUES (?,'Fixture')", [
      nest,
    ]);
    await pool.execute(
      "INSERT INTO eggs (id,nest_id,name,version,document) VALUES (?,?,'Fixture','PTDL_v2','{}')",
      [egg, nest],
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
          Buffer.from("unused fixture placeholder"),
        ],
      );
      await pool.execute(
        "INSERT INTO allocations (id,node_id,ip,port) VALUES (?,?,'127.0.0.1',?)",
        [a, id, port],
      );
    }
    await pool.execute(
      "INSERT INTO servers (id,name,node_id,owner_id,egg_id,allocation_id) VALUES (?,'Fixture',?,?,?,?)",
      [fixture.uuid, sourceId, owner, egg, sourceAllocation],
    );
    await app.listen({ port: 13201, host: "127.0.0.1" });
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
    await eventually("source installation", () => installed !== undefined);
    assert.equal(installed, true);
    assert.equal(await from.state(fixture.uuid), "offline");
    const original = await from.readFixtureFile(fixture.uuid, "relay-start.sh");
    assert.ok(original.includes("RELAY_CONTRACT_READY"));
    const forged = await app.inject({
      method: "POST",
      url: `/target/api/remote/servers/${fixture.uuid}/transfer/success`,
      headers: { authorization: `Bearer ${source.tokenId}.${source.token}` },
    });
    assert.equal(forged.statusCode, 401);
    await pool.execute(
      "INSERT INTO wings_provisions (server_id,phase) VALUES (?,'installed')",
      [fixture.uuid],
    );
    transferId = await ledger.reserve(fixture.uuid, targetId, targetAllocation);
    assert.ok(transferId);
    assert.equal(await ledger.claim(transferId), true);
    assert.equal(await transferLedger(pool).claim(transferId), false);
    const sourceToken = signTransferCapability(source, issuer, fixture.uuid);
    const rejected = await fetch(`${target.origin}/api/transfers`, {
      method: "POST",
      headers: { authorization: `Bearer ${sourceToken}` },
      signal: AbortSignal.timeout(3000),
    });
    assert.ok(!rejected.ok);
    await rejected.body?.cancel();
    assert.equal(completion, undefined);
    await from.transferTo(
      fixture.uuid,
      target,
      signTransferCapability(target, issuer, fixture.uuid),
    );
    await eventually(
      "destination callback",
      () => failure || reportDropped || completion !== undefined,
    );
    assert.equal(failure, false);
    if (dropReport) {
      assert.equal(reportDropped, true);
      assert.equal(completion, undefined);
      await app.close();
      assert.equal(await to.state(fixture.uuid), "offline");
      assert.equal(
        digest(await to.readFixtureFile(fixture.uuid, "relay-start.sh")),
        digest(original),
      );
      await pool.execute(
        "UPDATE wings_transfers SET dispatched_at=UTC_TIMESTAMP(3)-INTERVAL 6 MINUTE WHERE id=?",
        [transferId],
      );
      const recoveredPool = stagingPool();
      try {
        const recovered = transferLedger(recoveredPool);
        assert.equal(await recovered.expireUnconfirmedDispatches(), 1);
        assert.equal(await recovered.claim(transferId), false);
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
      assert.equal(
        digest(await from.readFixtureFile(fixture.uuid, "relay-start.sh")),
        digest(original),
      );
      // Dispose both copies only after checking that reconciliation preserved them.
      await to.remove(fixture.uuid);
      await from.remove(fixture.uuid);
      console.log(
        "Missing destination report quarantined; source and reservation preserved before fixture teardown",
      );
      return;
    }
    assert.equal(completion, true);
    await app.close();
    await promisify(execFile)(
      "./node_modules/.bin/tsx",
      ["api/wings/live-transfer.ts", "recover", transferId, digest(original)],
      { timeout: 15000 },
    );
    assert.deepEqual(
      await rows(pool, "SELECT node_id,allocation_id FROM servers WHERE id=?", [
        fixture.uuid,
      ]),
      [{ node_id: targetId, allocation_id: targetAllocation }],
    );
    await to.remove(fixture.uuid);
    await from.remove(fixture.uuid);
    console.log(
      "Wings-to-Wings transfer verified on independent Docker engines; archive matched and source preserved before cleanup",
    );
  } finally {
    await app.close();
    await pool.end();
  }
}
void main().catch((error) => {
  console.error(
    `::error::${error instanceof Error ? error.message : "Transfer contract failed"}`,
  );
  process.exitCode = 1;
});
