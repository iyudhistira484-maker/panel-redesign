import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "mysql2/promise";
import { rows, transaction, type Executor } from "../db";
import { UUID_V4 } from "./client";

// This driver is supplied only by the CI harness. A request cannot select a host,
// credential, schema, path or SQL payload to execute.
export type FixtureAppDatabaseDriver = {
  bound: (id: string) => boolean;
  snapshot: (id: string) => Promise<Buffer>;
  restore: (id: string, dump: Buffer) => Promise<void>;
};
export const appDbMaxDump = 1024 * 1024;
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
export function registerAppDatabase(
  app: FastifyInstance,
  pool: Pool,
  driver: FixtureAppDatabaseDriver,
  sessionUser: (req: FastifyRequest) => Promise<string | null>,
) {
  type Params = { server: string; database?: string; backup?: string };
  const root = "/api/v1/servers/:server/databases";
  const config = { rateLimit: { max: 12, timeWindow: "1 minute" } };
  const source = async (
    db: Executor,
    owner: string,
    server: string,
    id: string,
    lock = false,
  ) => {
    if (!driver.bound(id)) return null;
    return (
      await rows<{ id: string; recovery_state: string }>(
        db,
        `SELECT d.id,d.recovery_state FROM app_database_bindings d JOIN servers s ON s.id=d.server_id WHERE d.id=? AND s.id=? AND s.owner_id=?${lock ? " FOR UPDATE" : ""}`,
        [id, server, owner],
      )
    )[0];
  };
  for (const [method, path, kind] of [
    ["GET", root, "databases"],
    ["GET", `${root}/:database/backups`, "backups"],
    ["POST", `${root}/:database/backups`, "snapshot"],
    ["POST", `${root}/:database/backups/:backup/restore`, "restore"],
  ] as const) {
    app.route<{ Params: Params }>({
      method,
      url: path,
      config,
      bodyLimit: 1024,
      handler: async (req, reply) => {
        reply.header("cache-control", "no-store");
        const owner = await sessionUser(req);
        if (!owner) return reply.code(401).send({ error: "unauthenticated" });
        const { server, database = "", backup = "" } = req.params;
        if (
          !UUID_V4.test(server) ||
          (kind !== "databases" && !UUID_V4.test(database)) ||
          (kind === "restore" && !UUID_V4.test(backup))
        )
          return reply.code(404).send({ error: "not_found" });
        if (kind === "databases") {
          if (
            !(
              await rows(
                pool,
                "SELECT id FROM servers WHERE id=? AND owner_id=?",
                [server, owner],
              )
            ).length
          )
            return reply.code(404).send({ error: "not_found" });
          const items = await rows<{
            id: string;
            label: string;
            recoveryState: string;
          }>(
            pool,
            "SELECT id,label,recovery_state AS recoveryState FROM app_database_bindings WHERE server_id=? ORDER BY id LIMIT 20",
            [server],
          );
          return { items: items.filter((item) => driver.bound(item.id)) };
        }
        if (kind === "backups") {
          if (!(await source(pool, owner, server, database)))
            return reply.code(404).send({ error: "not_found" });
          return {
            items: await rows(
              pool,
              "SELECT id,state,size_bytes AS sizeBytes,sha256,created_at AS createdAt FROM app_database_backups WHERE database_id=? ORDER BY created_at DESC,id",
              [database],
            ),
          };
        }
        if (kind === "snapshot") {
          if (req.body !== undefined)
            return reply.code(400).send({ error: "invalid_request" });
          const id = randomUUID();
          const status = await transaction(pool, async (db) => {
            if (!(await source(db, owner, server, database, true))) return 404;
            const existing = await rows<{ state: string }>(
              db,
              "SELECT state FROM app_database_backups WHERE database_id=?",
              [database],
            );
            if (
              existing.length >= 3 ||
              existing.some((row) => row.state === "creating")
            )
              return 409;
            await db.execute(
              "INSERT INTO app_database_backups(id,database_id,state) VALUES (?,?,'creating')",
              [id, database],
            );
            return 201;
          });
          if (status !== 201)
            return reply.code(status).send({
              error: status === 404 ? "not_found" : "backup_conflict",
            });
          try {
            const dump = await driver.snapshot(database);
            if (!dump.length || dump.length > appDbMaxDump)
              throw new Error("Dump outside staging bounds");
            await transaction(pool, async (db) => {
              await db.execute(
                "UPDATE app_database_backups SET state='ready',size_bytes=?,sha256=?,dump=? WHERE id=? AND state='creating'",
                [dump.length, sha(dump), dump, id],
              );
              await db.execute(
                "INSERT INTO audit_log(actor_id,event,subject_id) VALUES (?,'app_database.backup_created',?)",
                [owner, id],
              );
            });
            return reply.code(201).send({ id });
          } catch {
            await pool.execute(
              "UPDATE app_database_backups SET state='failed' WHERE id=? AND state='creating'",
              [id],
            );
            return reply
              .code(502)
              .send({ error: "database_backup_failed", id });
          }
        }
        const body = req.body as { confirm?: unknown } | undefined;
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).length !== 1 ||
          body.confirm !== true
        )
          return reply.code(400).send({ error: "confirmation_required" });
        const claim = await transaction(pool, async (db) => {
          const binding = await source(db, owner, server, database, true);
          if (!binding) return { status: 404 } as const;
          const [item] = await rows<{
            state: string;
            dump: Buffer | null;
            sha256: string | null;
            size_bytes: number | null;
          }>(
            db,
            "SELECT state,dump,sha256,size_bytes FROM app_database_backups WHERE id=? AND database_id=?",
            [backup, database],
          );
          if (!item) return { status: 404 } as const;
          if (binding.recovery_state !== "empty" || item.state !== "ready")
            return { status: 409 } as const;
          if (
            !item.dump ||
            !item.dump.length ||
            item.dump.length !== item.size_bytes ||
            item.dump.length > appDbMaxDump ||
            sha(item.dump) !== item.sha256
          )
            return { status: 422 } as const;
          await db.execute(
            "UPDATE app_database_bindings SET recovery_state='restoring' WHERE id=?",
            [database],
          );
          await db.execute(
            "INSERT INTO audit_log(actor_id,event,subject_id) VALUES (?,'app_database.restore_requested',?)",
            [owner, backup],
          );
          return { status: 200, dump: item.dump } as const;
        });
        if (claim.status !== 200)
          return reply.code(claim.status).send({
            error:
              claim.status === 404
                ? "not_found"
                : claim.status === 422
                  ? "backup_integrity_failed"
                  : "restore_conflict",
          });
        try {
          await driver.restore(database, claim.dump);
        } catch {
          await pool.execute(
            "UPDATE app_database_bindings SET recovery_state='needs_review' WHERE id=? AND recovery_state='restoring'",
            [database],
          );
          return reply
            .code(502)
            .send({ error: "database_restore_unconfirmed" });
        }
        await transaction(pool, async (db) => {
          await db.execute(
            "UPDATE app_database_bindings SET recovery_state='restored' WHERE id=? AND recovery_state='restoring'",
            [database],
          );
          await db.execute(
            "INSERT INTO audit_log(actor_id,event,subject_id) VALUES (?,'app_database.restore_confirmed',?)",
            [owner, backup],
          );
        });
        return { id: backup, recoveryState: "restored" };
      },
    });
  }
}
