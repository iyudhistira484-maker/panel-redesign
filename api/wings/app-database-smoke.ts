import assert from "node:assert/strict";
import Fastify from "fastify";
import { createPool, type Pool } from "mysql2/promise";
import { rows, transaction } from "../db";

async function smoke() {
  const port = Number(process.env.RELAY_APP_DB_RECOVERY_PORT);
  const expected = process.env.RELAY_EXPECTED_RECOVERY_UUID ?? "";
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    process.env.GITHUB_WORKFLOW !== "Foundation" ||
    process.env.RELAY_ENV !== "staging" ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !/^[0-9a-f-]{36}$/.test(expected)
  )
    throw new Error("Disposable application recovery fixture required");
  const connect = () =>
    createPool({
      host: "127.0.0.1",
      port,
      user: "fixture_app_runtime",
      password: "disposable-app-runtime",
      database: "relay_app_recovery",
      connectionLimit: 2,
      connectTimeout: 4000,
    });
  async function start(db: Pool) {
    const [server] = await rows<{ uuid: string }>(
      db,
      "SELECT @@server_uuid AS uuid",
    );
    assert.equal(server.uuid, expected);
    const app = Fastify({ bodyLimit: 256 });
    app.get("/ledger", async () => ({
      accounts: await rows(
        db,
        "SELECT id,balance,label FROM accounts ORDER BY id",
      ),
      entries: await rows(
        db,
        "SELECT id,account_id AS accountId,amount,CAST(HEX(payload) AS CHAR CHARACTER SET utf8mb4) AS payload,CAST(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.reason')) AS CHAR CHARACTER SET utf8mb4) AS reason FROM ledger ORDER BY id",
      ),
    }));
    app.post("/transfers", async (req, reply) => {
      const body = req.body as { id?: unknown; amount?: unknown } | null;
      if (!body || body.id !== 3 || body.amount !== 7)
        return reply.code(400).send({ error: "invalid_fixture_transfer" });
      try {
        await transaction(db, async (trx) => {
          await trx.execute("UPDATE accounts SET balance=balance-7 WHERE id=1");
          await trx.execute("UPDATE accounts SET balance=balance+7 WHERE id=2");
          await trx.execute(
            "INSERT INTO ledger VALUES (3,1,-7,?,JSON_OBJECT('reason','recovered transfer')),(4,2,7,?,JSON_OBJECT('reason','recovered transfer'))",
            [Buffer.from([0, 255]), Buffer.from([0, 255])],
          );
        });
      } catch (error) {
        if ((error as { code?: string }).code === "ER_DUP_ENTRY")
          return reply.code(409).send({ error: "transfer_exists" });
        throw error;
      }
      return reply.code(201).send({ id: 3 });
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    return { address, close: () => app.close() };
  }
  const get = async (address: string) => {
    const response = await fetch(`${address}/ledger`, {
      redirect: "error",
      signal: AbortSignal.timeout(4000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const initial = connect();
  try {
    const app = await start(initial);
    try {
      assert.deepEqual(await get(app.address), {
        accounts: [
          { id: 1, balance: 80, label: "Kopi • Surabaya" },
          { id: 2, balance: 20, label: "Cadangan" },
        ],
        entries: [
          {
            id: 1,
            accountId: 1,
            amount: 80,
            payload: "000A0D80FF",
            reason: "checkpoint",
          },
          {
            id: 2,
            accountId: 2,
            amount: 20,
            payload: "00FF",
            reason: "checkpoint",
          },
        ],
      });
      const transfer = () =>
        fetch(`${app.address}/transfers`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: 3, amount: 7 }),
          redirect: "error",
          signal: AbortSignal.timeout(4000),
        });
      const written = await transfer();
      assert.equal(written.status, 201);
      await written.body?.cancel();
      const duplicate = await transfer();
      assert.equal(duplicate.status, 409);
      await duplicate.body?.cancel();
    } finally {
      await app.close();
    }
  } finally {
    await initial.end();
  }
  const reopened = connect();
  try {
    const app = await start(reopened);
    try {
      const after = await get(app.address);
      assert.deepEqual(after.accounts, [
        { id: 1, balance: 73, label: "Kopi • Surabaya" },
        { id: 2, balance: 27, label: "Cadangan" },
      ]);
      assert.deepEqual(after.entries.slice(2), [
        {
          id: 3,
          accountId: 1,
          amount: -7,
          payload: "00FF",
          reason: "recovered transfer",
        },
        {
          id: 4,
          accountId: 2,
          amount: 7,
          payload: "00FF",
          reason: "recovered transfer",
        },
      ]);
      assert.equal(after.entries.length, 4);
    } finally {
      await app.close();
    }
  } finally {
    await reopened.end();
  }
}
void smoke().catch((error) => {
  const detail =
    error instanceof assert.AssertionError
      ? error.message.slice(0, 1200)
      : error instanceof Error
        ? error.message.split("\n")[0]
        : "Unknown error";
  console.error(
    `::error title=Application HTTP recovery smoke failed::${detail.replaceAll("%", "%25").replaceAll("\n", "%0A").replaceAll("\r", "%0D")}`,
  );
  process.exitCode = 1;
});
