import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../app";
import { rows, stagingPool } from "../db";
import { migrate } from "../migrate";
import { cryptoContext } from "../security";
import {
  appDbMaxDump,
  type FixtureAppDatabaseDriver,
} from "./app-database-api";

async function main() {
  const src = process.env.RELAY_APP_DB_CI_SERVICE ?? "";
  const dst = process.env.RELAY_APP_DB_RECOVERY_SERVICE ?? "";
  const port = Number(process.env.RELAY_APP_DB_CONTROL_PORT);
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    process.env.GITHUB_WORKFLOW !== "Foundation" ||
    process.env.RELAY_ENV !== "staging" ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !/^[a-f0-9]{64}$/.test(src) ||
    !/^[a-f0-9]{64}$/.test(dst) ||
    src === dst
  )
    throw new Error("Disposable app database API fixture only");
  const pool = stagingPool(
    `mysql://fixture_app_control:disposable-app-control@127.0.0.1:${port}/relay_test_appdb`,
  );
  const key = randomBytes(32),
    pepper = randomBytes(32),
    origin = "https://relay.example.test";
  function execute(container: string, command: string, input?: Buffer) {
    return new Promise<Buffer>((resolve, reject) => {
      const child = execFile(
        "docker",
        ["exec", "-i", container, "sh", "-ec", command],
        { encoding: "buffer", timeout: 12000, maxBuffer: appDbMaxDump },
        (error, result) =>
          error
            ? reject(new Error("Fixture database command failed"))
            : resolve(result),
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
  }
  const interruptedId = randomUUID();
  const id = randomUUID(),
    server = randomUUID(),
    neighbor = randomUUID(),
    owner = randomUUID(),
    outsider = randomUUID();
  let restores = 0;
  let interruptedAttempts = 0;
  const driver: FixtureAppDatabaseDriver = {
    bound: (database) => database === id || database === interruptedId,
    async snapshot(database) {
      assert.ok(database === id || database === interruptedId);
      return execute(
        src,
        "MYSQL_PWD=disposable-app-reader exec mysqldump -ufixture_app_reader --default-character-set=utf8mb4 --single-transaction --no-tablespaces --set-gtid-purged=OFF --skip-lock-tables --skip-triggers --hex-blob relay_app_source",
      );
    },
    async restore(database, dump) {
      if (database === interruptedId) {
        interruptedAttempts++;
        const sql = dump.toString("utf8");
        const cut = sql.indexOf("-- Table structure for table `ledger`");
        assert.ok(cut > 0);
        // Import the first table, then fail after its rows committed. Earlier
        // MySQL DDL is not transactional with the remainder of the dump.
        await execute(
          dst,
          "MYSQL_PWD=disposable-app-restore exec mysql -ufixture_app_restore --default-character-set=utf8mb4 relay_app_interrupted",
          Buffer.from(
            `${sql.slice(0, cut)}\nSIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture import interrupted';\n`,
          ),
        );
        throw new Error("Expected partial import to terminate");
      }
      assert.equal(database, id);
      const empty = await execute(
        dst,
        "MYSQL_PWD=disposable-app-restore exec mysql -ufixture_app_restore -NBr relay_app_ownerrecovery -e 'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()'",
      );
      assert.equal(empty.toString().trim(), "0");
      restores++;
      await execute(
        dst,
        "MYSQL_PWD=disposable-app-restore exec mysql -ufixture_app_restore --default-character-set=utf8mb4 relay_app_ownerrecovery",
        dump,
      );
    },
  };
  const launch = () =>
    createApp({
      pool,
      origin,
      key,
      pepper,
      deliverReset: async () => {},
      fixtureAppDatabase: driver,
    });
  const cookie = async (user: string) => {
    const raw = randomBytes(32).toString("base64url");
    await pool.execute(
      "INSERT INTO sessions(digest,user_id,authenticated,expires_at) VALUES (?,?,TRUE,UTC_TIMESTAMP(3)+INTERVAL 1 HOUR)",
      [cryptoContext(key, pepper).digest("session", raw), user],
    );
    return `__Host-relay_session=${raw}`;
  };
  try {
    await migrate(pool, "up");
    for (const [user, email] of [
      [owner, "db-owner@example.test"],
      [outsider, "db-outsider@example.test"],
    ])
      await pool.execute(
        "INSERT INTO users(id,email,display_name,password_hash) VALUES (?,?,'Fixture','login-disabled')",
        [user, email],
      );
    const node = randomUUID(),
      nest = randomUUID(),
      egg = randomUUID();
    await pool.execute(
      "INSERT INTO nodes(id,name,origin,token_id,token_cipher) VALUES (?,'Fixture','http://127.0.0.1:19999','fixturedbnode',?)",
      [node, Buffer.alloc(32)],
    );
    await pool.execute("INSERT INTO nests(id,name) VALUES (?,'Fixture')", [
      nest,
    ]);
    await pool.execute(
      "INSERT INTO eggs(id,nest_id,name,version,document) VALUES (?,?,'Fixture','PTDL_v2',?)",
      [egg, nest, Buffer.from("{}")],
    );
    for (const [index, s] of [server, neighbor].entries()) {
      const alloc = randomUUID();
      await pool.execute(
        "INSERT INTO allocations(id,node_id,ip,port) VALUES (?,?,'127.0.0.1',?)",
        [alloc, node, 25700 + index],
      );
      await pool.execute(
        "INSERT INTO servers(id,name,node_id,owner_id,egg_id,allocation_id) VALUES (?,'Database fixture',?,?,?,?)",
        [s, node, owner, egg, alloc],
      );
    }
    await pool.execute(
      "INSERT INTO app_database_bindings(id,server_id,label) VALUES (?,?,'Ledger MySQL')",
      [id, server],
    );
    await pool.execute(
      "INSERT INTO app_database_bindings(id,server_id,label) VALUES (?,?,'Interrupted ledger MySQL')",
      [interruptedId, server],
    );
    const auth = {
      cookie: await cookie(owner),
      origin,
      "x-relay-request": "1",
    };
    const foreign = { ...auth, cookie: await cookie(outsider) };
    const root = `/api/v1/servers/${server}/databases`,
      path = `${root}/${id}/backups`;
    const app = await launch();
    let backup: string;
    try {
      assert.equal((await app.inject({ url: root })).statusCode, 401);
      assert.equal(
        (await app.inject({ url: root, headers: foreign })).statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ method: "POST", url: path, headers: foreign }))
          .statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: path,
            headers: { cookie: auth.cookie },
          })
        ).statusCode,
        403,
      );
      const created = await app.inject({
        method: "POST",
        url: path,
        headers: auth,
      });
      assert.equal(created.statusCode, 201);
      backup = created.json().id;
    } finally {
      await app.close();
    }
    const fresh = await launch();
    try {
      const list = await fresh.inject({ url: path, headers: auth });
      assert.equal(list.statusCode, 200);
      const [item] = list.json().items;
      assert.equal(item.id, backup);
      assert.equal(item.state, "ready");
      assert.equal(item.dump, undefined);
      assert.match(item.sha256, /^[a-f0-9]{64}$/);
      const restore = `${path}/${backup}/restore`;
      const submit = (
        url = restore,
        headers = auth,
        payload: object = { confirm: true },
      ) => fresh.inject({ method: "POST", url, headers, payload });
      assert.equal(
        (await submit(restore.replace(server, neighbor))).statusCode,
        404,
      );
      assert.equal((await submit(restore, foreign)).statusCode, 404);
      assert.equal(
        (
          await submit(restore, auth, {
            confirm: true,
            target: "relay_app_source",
          })
        ).statusCode,
        400,
      );
      const [saved] = await rows<{ dump: Buffer }>(
        pool,
        "SELECT dump FROM app_database_backups WHERE id=?",
        [backup],
      );
      assert.equal(
        createHash("sha256").update(saved.dump).digest("hex"),
        item.sha256,
      );
      const corrupt = Buffer.from(saved.dump);
      corrupt[0] ^= 1;
      await pool.execute("UPDATE app_database_backups SET dump=? WHERE id=?", [
        corrupt,
        backup,
      ]);
      assert.equal((await submit()).statusCode, 422);
      assert.equal(restores, 0);
      await pool.execute("UPDATE app_database_backups SET dump=? WHERE id=?", [
        saved.dump,
        backup,
      ]);
      const race = await Promise.all([submit(), submit()]);
      assert.deepEqual(
        race.map((reply) => reply.statusCode).sort(),
        [200, 409],
      );
      assert.equal(restores, 1);
      assert.equal(
        (await fresh.inject({ url: root, headers: auth }))
          .json()
          .items.find((item: { id: string }) => item.id === id).recoveryState,
        "restored",
      );
      assert.equal(
        (
          await rows(
            pool,
            "SELECT id FROM audit_log WHERE actor_id=? AND subject_id=? AND event LIKE 'app_database.%'",
            [owner, backup],
          )
        ).length,
        3,
      );
      console.log(
        "::notice::App database owner API: session_scope=true cross_server_denied=true corrupt_backup_denied=true competing_restore_single_import=true audit_verified=true",
      );
    } finally {
      await fresh.close();
    }
    const interruptedPath = `${root}/${interruptedId}/backups`;
    let partialBackup: string;
    const beforeRestart = await launch();
    try {
      const created = await beforeRestart.inject({
        method: "POST",
        url: interruptedPath,
        headers: auth,
      });
      assert.equal(created.statusCode, 201);
      partialBackup = created.json().id;
      const request = {
        method: "POST" as const,
        url: `${interruptedPath}/${partialBackup}/restore`,
        headers: auth,
        payload: { confirm: true },
      };
      const interrupted = await beforeRestart.inject(request);
      assert.equal(interrupted.statusCode, 502);
      assert.equal(interrupted.json().error, "database_restore_unconfirmed");
    } finally {
      await beforeRestart.close();
    }
    const readPartial = async () =>
      (
        await execute(
          dst,
          "MYSQL_PWD=disposable-app-restore exec mysql -ufixture_app_restore -NBr relay_app_interrupted -e 'SELECT balance FROM accounts ORDER BY id; SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=\"ledger\"' ",
        )
      )
        .toString()
        .trim();
    assert.equal(await readPartial(), "70\n30\n0");
    await execute(
      dst,
      "MYSQL_PWD=disposable-app-restore exec mysql -ufixture_app_restore relay_app_interrupted -e 'UPDATE accounts SET balance=71 WHERE id=1'",
    );
    const afterRestart = await launch();
    try {
      const get = async () => {
        const result = await afterRestart.inject({ url: root, headers: auth });
        assert.equal(result.statusCode, 200);
        return result
          .json()
          .items.find((item: { id: string }) => item.id === interruptedId);
      };
      const observation = await get();
      assert.equal(observation.recoveryState, "needs_review");
      assert.equal(observation.recoveryNeedsReview, 1);
      assert.equal(observation.recoveryBackupId, partialBackup);
      assert.ok(
        observation.recoveryStartedAt && observation.recoveryFinishedAt,
      );
      const retry = () =>
        afterRestart.inject({
          method: "POST",
          url: `${interruptedPath}/${partialBackup}/restore`,
          headers: auth,
          payload: { confirm: true },
        });
      assert.equal((await retry()).statusCode, 409);
      assert.equal(await readPartial(), "71\n30\n0");
      assert.equal(interruptedAttempts, 1);
      assert.equal(
        (
          await rows(
            pool,
            "SELECT id FROM audit_log WHERE actor_id=? AND subject_id=? AND event='app_database.restore_unconfirmed'",
            [owner, partialBackup],
          )
        ).length,
        1,
      );
      // Simulate the lost response window: durable claim, no terminal update.
      await pool.execute(
        "UPDATE app_database_bindings SET recovery_state='restoring',recovery_started_at=UTC_TIMESTAMP(3)-INTERVAL 3 MINUTE,recovery_finished_at=NULL WHERE id=?",
        [interruptedId],
      );
      const unknown = await get();
      assert.equal(unknown.recoveryState, "restoring");
      assert.equal(unknown.recoveryNeedsReview, 1);
      assert.equal((await retry()).statusCode, 409);
      assert.equal(await readPartial(), "71\n30\n0");
      console.log(
        "::notice::Application database partial restore: real_partial_import=true review_survived_restart=true lost_result_flagged=true retry_blocked=true newer_target_write_preserved=true",
      );
    } finally {
      await afterRestart.close();
    }
  } finally {
    await pool.end();
  }
}
void main().catch((error) => {
  const location =
    error instanceof Error
      ? error.stack?.match(/app-database-api-fixture\.ts:\d+:\d+/)?.[0]
      : undefined;
  console.error(
    `::error::${location ?? "Application owner DB fixture"}: ${error instanceof Error ? error.message.split("\n")[0] : "unknown failure"}`,
  );
  process.exitCode = 1;
});
