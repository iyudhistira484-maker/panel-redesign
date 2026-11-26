import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, ResultSetHeader } from "mysql2/promise";
import { rows, transaction, type Executor } from "../db";
import { cryptoContext } from "../security";
import { UUID_V4, WingsClient, type WingsNode } from "./client";
import { s3Fixture } from "./s3-fixture";
import type { FixtureBackupCallback } from "./remote";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_RECEIPTS = 3;
type Backup = {
  id: string;
  adapter: "wings" | "s3";
  state: string;
  locked: number;
  needsReview: number;
  sizeBytes: number | null;
  checksum: string | null;
  createdAt: string;
};
const columns =
  "b.id,b.adapter,b.state,b.locked,b.size_bytes AS sizeBytes,b.checksum,b.created_at AS createdAt, CASE WHEN b.state IN ('creating','restoring') AND b.operation_started_at <= CURRENT_TIMESTAMP(3) - INTERVAL 2 MINUTE THEN 1 ELSE 0 END AS needsReview";
type Target = { id: string; owner: string; nodeId: string; cipher: Buffer };

export function localBackupService(
  pool: Pool,
  node: WingsNode,
  key: Buffer,
  pepper: Buffer,
  origin: string,
  s3Enabled = false,
) {
  const client = new WingsClient(node);
  const crypt = cryptoContext(key, pepper, "node-token");
  const nodeMatches = (row: Target) => {
    try {
      const saved = crypt.open(row.cipher, row.nodeId);
      const token = Buffer.from(node.token);
      return saved.length === token.length && timingSafeEqual(saved, token);
    } catch {
      return false;
    }
  };
  const target = async (
    db: Executor,
    server: string,
    owner: string,
    lock = false,
  ) => {
    const [record] = await rows<Target>(
      db,
      `SELECT s.id,s.owner_id AS owner,n.id AS nodeId,n.token_cipher AS cipher FROM servers s
      JOIN nodes n ON n.id=s.node_id JOIN wings_provisions p ON p.server_id=s.id
      WHERE s.id=? AND s.owner_id=? AND p.phase='installed' AND n.origin=? AND n.token_id=?${lock ? " FOR UPDATE" : ""}`,
      [server, owner, node.origin, node.tokenId],
    );
    return record && nodeMatches(record) ? record : null;
  };
  const lookup = async (db: Executor, record: Target, backup: string) =>
    (
      await rows<Backup>(
        db,
        `SELECT ${columns} FROM local_server_backups b WHERE id=? AND server_id=? AND node_id=?`,
        [backup, record.id, record.nodeId],
      )
    )[0];
  const bound = async (id: string) => {
    const [record] = await rows<
      Target & { adapter: Backup["adapter"]; state: string }
    >(
      pool,
      `SELECT b.server_id AS id,s.owner_id AS owner,n.id AS nodeId,n.token_cipher AS cipher,b.adapter,b.state
      FROM local_server_backups b JOIN servers s ON s.id=b.server_id AND s.node_id=b.node_id JOIN nodes n ON n.id=b.node_id
      WHERE b.id=? AND n.origin=? AND n.token_id=?`,
      [id, node.origin, node.tokenId],
    );
    return record && nodeMatches(record) ? record : null;
  };
  const withS3 = async <T>(
    record: { id: string; nodeId: string },
    id: string,
    fn: (store: ReturnType<typeof s3Fixture>) => Promise<T>,
  ) => {
    if (!s3Enabled) throw new Error("S3 disabled");
    const store = s3Fixture(pool, record.id, record.nodeId, id);
    try {
      return await fn(store);
    } finally {
      store.dispose();
    }
  };
  const urls = async (id: string, size: number) => {
    if (!s3Enabled) return null;
    const record = await bound(id);
    if (record?.adapter !== "s3" || record.state !== "creating") return null;
    return withS3(record, id, (store) => store.urls(size));
  };
  const callback: FixtureBackupCallback = async (id, phase, event) => {
    const record = await bound(id);
    if (
      !record ||
      record.state !== (phase === "create" ? "creating" : "restoring")
    )
      return false;
    if (
      record.adapter === "s3" &&
      (!s3Enabled ||
        (phase === "create" &&
          event.successful &&
          !(await withS3(record, id, (store) => store.complete(event)))))
    )
      return false;
    const creating = phase === "create";
    const valid =
      event.successful &&
      (!creating ||
        (event.checksum_type === "sha1" &&
          /^[a-f0-9]{40}$/.test(event.checksum ?? "") &&
          Number.isSafeInteger(event.size) &&
          (event.size ?? 0) > 0 &&
          (event.size ?? 0) <= MAX_BYTES));
    const [result] = await pool.execute<ResultSetHeader>(
      creating
        ? "UPDATE local_server_backups SET state=?,size_bytes=?,checksum=?,operation_started_at=NULL WHERE id=? AND node_id=? AND state='creating'"
        : "UPDATE local_server_backups SET state=?,operation_started_at=NULL WHERE id=? AND node_id=? AND state='restoring'",
      creating
        ? [
            valid ? "ready" : "create_failed",
            valid ? (event.size ?? null) : null,
            valid ? (event.checksum ?? null) : null,
            id,
            record.nodeId,
          ]
        : [valid ? "ready" : "restore_failed", id, record.nodeId],
    );
    return result.affectedRows === 1;
  };
  const download = async (record: Target, backup: Backup) => {
    if (!backup.sizeBytes || backup.sizeBytes > MAX_BYTES || !backup.checksum)
      throw new Error("Invalid backup metadata");
    let url: URL | string;
    if (backup.adapter === "s3")
      url = await withS3(record, backup.id, (store) => store.url());
    else {
      const now = Math.floor(Date.now() / 1000);
      const encode = (value: object) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
      const signed = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: origin, aud: [node.origin], iat: now, nbf: now - 1, exp: now + 15, jti: randomUUID(), unique_id: randomUUID(), server_uuid: record.id, user_uuid: record.owner, backup_uuid: backup.id, scope: "backup-download" })}`;
      url = new URL("/download/backup", node.origin);
      url.searchParams.set(
        "token",
        `${signed}.${createHmac("sha256", node.token).update(signed).digest("base64url")}`,
      );
    }
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });
    if (
      !response.ok ||
      !response.body ||
      Number(response.headers.get("content-length")) !== backup.sizeBytes
    ) {
      await response.body?.cancel();
      throw new Error("Backup length mismatch");
    }
    const reader = response.body.getReader();
    const data = Buffer.alloc(backup.sizeBytes);
    let offset = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (offset + chunk.value.byteLength > data.length)
          throw new Error("Backup too large");
        data.set(chunk.value, offset);
        offset += chunk.value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (
      offset !== data.length ||
      createHash("sha1").update(data).digest("hex") !== backup.checksum
    )
      throw new Error("Backup checksum mismatch");
    return data;
  };
  type Schedule = {
    server_id: string;
    owner_id: string;
    node_id: string;
    adapter: Backup["adapter"];
    interval_minutes: number;
    keep_count: number;
    next_run_at: Date;
    last_result: string | null;
  };
  async function dispatchCreate(
    record: Target,
    id: string,
    adapter: Backup["adapter"],
  ) {
    if (adapter === "s3")
      await withS3(record, id, async (store) => {
        await store.initialize();
        await client.fixtureS3Backup(record.id, id);
      });
    else await client.fixtureBackup(record.id, id, "create");
  }
  async function scheduledTick() {
    const due = await rows<Schedule>(
      pool,
      "SELECT * FROM backup_schedules WHERE next_run_at<=CURRENT_TIMESTAMP(3) ORDER BY next_run_at LIMIT 8",
    );
    for (const entry of due) {
      if (entry.adapter === "s3" && !s3Enabled) continue;
      const record = await target(pool, entry.server_id, entry.owner_id);
      if (!record || record.nodeId !== entry.node_id) continue;
      let offline = false;
      try {
        offline = (await client.state(record.id)) === "offline";
      } catch {
        /* Treat unavailable nodes as ineligible. */
      }
      const id = randomUUID();
      const claim = await transaction(pool, async (db) => {
        const owner = await target(db, record.id, entry.owner_id, true);
        if (!owner || owner.nodeId !== entry.node_id) return false;
        const [slot] = await rows<Schedule>(
          db,
          "SELECT * FROM backup_schedules WHERE server_id=? AND node_id=? AND owner_id=? AND next_run_at<=CURRENT_TIMESTAMP(3) FOR UPDATE",
          [record.id, record.nodeId, record.owner],
        );
        if (!slot || slot.adapter !== entry.adapter) return false;
        const backups = await rows<{ state: string }>(
          db,
          "SELECT state FROM local_server_backups WHERE server_id=? AND node_id=?",
          [record.id, record.nodeId],
        );
        const reason = !offline
          ? "not_offline"
          : backups.some((row) =>
                ["creating", "restoring", "deleting"].includes(row.state),
              )
            ? "busy"
            : backups.length >= MAX_RECEIPTS
              ? "quota"
              : "reserved";
        await db.execute(
          "UPDATE backup_schedules SET next_run_at=CURRENT_TIMESTAMP(3)+INTERVAL interval_minutes MINUTE,last_result=? WHERE server_id=?",
          [reason, record.id],
        );
        if (reason !== "reserved") return false;
        await db.execute(
          "INSERT INTO local_server_backups(id,server_id,node_id,adapter,state,operation_started_at,schedule_slot) VALUES (?,?,?,?,'creating',CURRENT_TIMESTAMP(3),?)",
          [id, record.id, record.nodeId, slot.adapter, slot.next_run_at],
        );
        if (slot.adapter === "s3")
          await db.execute(
            "INSERT INTO s3_fixture_receipts(id,server_id,node_id) VALUES (?,?,?)",
            [id, record.id, record.nodeId],
          );
        return true;
      });
      if (claim) {
        try {
          await dispatchCreate(record, id, entry.adapter);
        } catch {
          /* Leave the durable receipt pending; never replay an uncertain dispatch. */
        }
      }
    }
    const schedules = await rows<Schedule>(
      pool,
      "SELECT q.* FROM backup_schedules q WHERE (SELECT COUNT(*) FROM local_server_backups b WHERE b.server_id=q.server_id AND b.node_id=q.node_id AND b.schedule_slot IS NOT NULL AND b.state='ready')>q.keep_count ORDER BY q.next_run_at LIMIT 8",
    );
    for (const entry of schedules) {
      if (entry.adapter === "s3" && !s3Enabled) continue;
      const victim = await transaction(pool, async (db) => {
        const record = await target(db, entry.server_id, entry.owner_id, true);
        if (!record || record.nodeId !== entry.node_id) return null;
        const [policy] = await rows<Schedule>(
          db,
          "SELECT * FROM backup_schedules WHERE server_id=? AND node_id=? AND owner_id=? FOR UPDATE",
          [record.id, record.nodeId, record.owner],
        );
        if (!policy) return null;
        const candidates = await rows<Backup>(
          db,
          `SELECT ${columns} FROM local_server_backups b WHERE server_id=? AND node_id=? AND schedule_slot IS NOT NULL AND state='ready' ORDER BY schedule_slot DESC,id`,
          [record.id, record.nodeId],
        );
        // Keep the newest N successful scheduled backups, plus any protected older copies.
        const backup = candidates
          .slice(policy.keep_count)
          .reverse()
          .find((row) => !row.locked && (row.adapter !== "s3" || s3Enabled));
        if (!backup) return null;
        await db.execute(
          "UPDATE local_server_backups SET state='deleting' WHERE id=? AND state='ready' AND locked=0",
          [backup.id],
        );
        return { record, backup };
      });
      if (!victim) continue;
      const { record, backup } = victim;
      try {
        if (backup.adapter === "s3") {
          if (!(await withS3(record, backup.id, (store) => store.remove())))
            continue;
        } else await client.fixtureBackup(record.id, backup.id, "delete");
        await pool.execute(
          "DELETE FROM local_server_backups WHERE id=? AND server_id=? AND node_id=? AND state='deleting'",
          [backup.id, record.id, record.nodeId],
        );
      } catch {
        /* A failed deletion remains visible for an explicit retry. */
      }
    }
  }
  function register(
    app: FastifyInstance,
    sessionUser: (req: FastifyRequest) => Promise<string | null>,
  ) {
    type Params = { id: string; backup?: string };
    const root = "/api/v1/servers/:id/backups";
    const config = { rateLimit: { max: 12, timeWindow: "1 minute" } };
    let worker: ReturnType<typeof setInterval> | undefined;
    let active: Promise<void> | undefined;
    app.addHook("onReady", async () => {
      worker = setInterval(() => {
        if (!active)
          active = scheduledTick()
            .catch(() => {
              app.log.warn("Staging backup scheduler tick failed");
            })
            .finally(() => {
              active = undefined;
            });
      }, 2000);
      worker.unref();
    });
    app.addHook("onClose", async () => {
      clearInterval(worker);
      await active;
    });
    for (const method of ["GET", "PUT", "DELETE"] as const)
      app.route<{ Params: Params }>({
        method,
        url: `/api/v1/servers/:id/backup-schedule`,
        config,
        bodyLimit: 1024,
        handler: async (req, reply) => {
          reply.header("cache-control", "no-store");
          const owner = await sessionUser(req);
          if (!owner) return reply.code(401).send({ error: "unauthenticated" });
          const server = req.params.id;
          if (!UUID_V4.test(server))
            return reply.code(404).send({ error: "not_found" });
          const body = req.body as
            | { adapter?: unknown; intervalMinutes?: unknown; keep?: unknown }
            | undefined;
          if (
            method === "PUT" &&
            (!body ||
              typeof body !== "object" ||
              Object.keys(body).sort().join(",") !==
                "adapter,intervalMinutes,keep" ||
              (body.adapter !== "wings" &&
                (body.adapter !== "s3" || !s3Enabled)) ||
              typeof body.intervalMinutes !== "number" ||
              !Number.isInteger(body.intervalMinutes) ||
              body.intervalMinutes < 15 ||
              body.intervalMinutes > 1440 ||
              (body.keep !== 1 && body.keep !== 2))
          )
            return reply.code(400).send({ error: "invalid_schedule" });
          const result = await transaction(pool, async (db) => {
            const record = await target(db, server, owner, method !== "GET");
            if (!record) return null;
            if (method === "DELETE")
              await db.execute(
                "DELETE FROM backup_schedules WHERE server_id=? AND node_id=? AND owner_id=?",
                [server, record.nodeId, owner],
              );
            if (method === "PUT" && body)
              await db.execute(
                "INSERT INTO backup_schedules(server_id,node_id,owner_id,adapter,interval_minutes,keep_count,next_run_at) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP(3)+INTERVAL ? MINUTE) ON DUPLICATE KEY UPDATE node_id=VALUES(node_id),owner_id=VALUES(owner_id),adapter=VALUES(adapter),interval_minutes=VALUES(interval_minutes),keep_count=VALUES(keep_count),next_run_at=VALUES(next_run_at),last_result=NULL",
                [
                  server,
                  record.nodeId,
                  owner,
                  String(body.adapter),
                  Number(body.intervalMinutes),
                  Number(body.keep),
                  Number(body.intervalMinutes),
                ],
              );
            const [schedule] = await rows(
              db,
              "SELECT adapter,interval_minutes AS intervalMinutes,keep_count AS keep,next_run_at AS nextRunAt,last_result AS lastResult FROM backup_schedules WHERE server_id=? AND node_id=? AND owner_id=?",
              [server, record.nodeId, owner],
            );
            return { schedule: schedule ?? null };
          });
          if (!result) return reply.code(404).send({ error: "not_found" });
          return method === "DELETE"
            ? reply.code(204).send()
            : reply.send(result);
        },
      });
    app.get<{ Params: Params }>(root, { config }, async (req, reply) => {
      reply.header("cache-control", "no-store");
      const owner = await sessionUser(req);
      if (!owner) return reply.code(401).send({ error: "unauthenticated" });
      const record = UUID_V4.test(req.params.id)
        ? await target(pool, req.params.id, owner)
        : null;
      if (!record) return reply.code(404).send({ error: "not_found" });
      return {
        items: await rows<Backup>(
          pool,
          `SELECT ${columns} FROM local_server_backups b WHERE server_id=? AND node_id=? ORDER BY created_at DESC,id`,
          [record.id, record.nodeId],
        ),
      };
    });
    app.get<{ Params: Params }>(
      `${root}/:backup/download`,
      { config },
      async (req, reply) => {
        reply.header("cache-control", "no-store");
        const owner = await sessionUser(req);
        if (!owner) return reply.code(401).send({ error: "unauthenticated" });
        const record = UUID_V4.test(req.params.id)
          ? await target(pool, req.params.id, owner)
          : null;
        const backup =
          record && UUID_V4.test(req.params.backup ?? "")
            ? await lookup(pool, record, req.params.backup ?? "")
            : null;
        if (!record || !backup)
          return reply.code(404).send({ error: "not_found" });
        if (backup.state !== "ready")
          return reply.code(409).send({ error: "backup_not_ready" });
        try {
          const bytes = await download(record, backup);
          return reply
            .type("application/octet-stream")
            .header(
              "content-disposition",
              `attachment; filename="${backup.id}.tar.gz"`,
            )
            .send(bytes);
        } catch {
          return reply.code(502).send({ error: "backup_unavailable" });
        }
      },
    );
    for (const action of ["lock", "unlock", "delete"] as const) {
      app.route<{ Params: Params }>({
        method: action === "delete" ? "DELETE" : "POST",
        url: `${root}/:backup${action === "delete" ? "" : `/${action}`}`,
        config,
        bodyLimit: 1024,
        handler: async (req, reply) => {
          const owner = await sessionUser(req);
          if (!owner) return reply.code(401).send({ error: "unauthenticated" });
          const { id: server, backup: id } = req.params;
          if (!id || !UUID_V4.test(id) || !UUID_V4.test(server))
            return reply.code(404).send({ error: "not_found" });
          if (req.body !== undefined)
            return reply.code(400).send({ error: "invalid_request" });
          const result = await transaction(pool, async (db) => {
            const record = await target(db, server, owner, true);
            const backup = record && (await lookup(db, record, id));
            if (!record || !backup) return { status: 404 } as const;
            if (action !== "delete") {
              if (
                backup.state !== "ready" &&
                !(action === "unlock" && backup.state === "restore_failed")
              )
                return { status: 409 } as const;
              await db.execute(
                "UPDATE local_server_backups SET locked=? WHERE id=?",
                [action === "lock" ? 1 : 0, id],
              );
              return { status: 204 } as const;
            }
            if (
              backup.locked ||
              ![
                "ready",
                "create_failed",
                "restore_failed",
                "deleting",
              ].includes(backup.state)
            )
              return { status: 409 } as const;
            await db.execute(
              "UPDATE local_server_backups SET state='deleting' WHERE id=?",
              [id],
            );
            return {
              status: 202,
              nodeId: record.nodeId,
              adapter: backup.adapter,
            } as const;
          });
          if (result.status === 204) return reply.code(204).send();
          if (result.status !== 202)
            return reply.code(result.status).send({
              error: result.status === 404 ? "not_found" : "backup_conflict",
            });
          try {
            if (result.adapter === "s3") {
              if (
                !(await withS3(
                  { id: server, nodeId: result.nodeId },
                  id,
                  (store) => store.remove(),
                ))
              )
                return reply.code(202).send({ id });
            } else await client.fixtureBackup(server, id, "delete");
          } catch {
            return reply.code(502).send({ error: "backup_delete_uncertain" });
          }
          await pool.execute(
            "DELETE FROM local_server_backups WHERE id=? AND server_id=? AND node_id=? AND state='deleting'",
            [id, server, result.nodeId],
          );
          return reply.code(204).send();
        },
      });
    }
    for (const action of ["create", "restore"] as const) {
      app.post<{ Params: Params }>(
        action === "create" ? root : `${root}/:backup/restore`,
        { config, bodyLimit: 1024 },
        async (req, reply) => {
          const owner = await sessionUser(req);
          if (!owner) return reply.code(401).send({ error: "unauthenticated" });
          const body = req.body;
          if (
            body !== undefined &&
            (body === null ||
              typeof body !== "object" ||
              Array.isArray(body) ||
              Object.keys(body).some(
                (key) => action !== "create" || key !== "adapter",
              ))
          )
            return reply.code(400).send({ error: "invalid_request" });
          const requested =
            (body as { adapter?: unknown } | undefined)?.adapter ?? "wings";
          if (requested !== "wings" && (requested !== "s3" || !s3Enabled))
            return reply.code(400).send({ error: "invalid_adapter" });
          const server = req.params.id;
          const id =
            action === "create" ? randomUUID() : (req.params.backup ?? "");
          if (
            !UUID_V4.test(server) ||
            !UUID_V4.test(id) ||
            !(await target(pool, server, owner))
          )
            return reply.code(404).send({ error: "not_found" });
          try {
            if ((await client.state(server)) !== "offline")
              return reply.code(409).send({ error: "server_not_offline" });
          } catch {
            return reply.code(502).send({ error: "wings_unavailable" });
          }
          const dispatch = await transaction(pool, async (db) => {
            const record = await target(db, server, owner, true);
            if (!record) return 404;
            const existing = await rows<Backup>(
              db,
              `SELECT ${columns} FROM local_server_backups b WHERE server_id=? AND node_id=?`,
              [server, record.nodeId],
            );
            const selected = existing.find((row) => row.id === id);
            if (action === "restore" && !selected) return 404;
            if (
              existing.some(
                (row) => row.state === "creating" || row.state === "restoring",
              )
            )
              return 409;
            const adapter = selected?.adapter ?? requested;
            if (action === "create") {
              if (existing.length >= MAX_RECEIPTS) return 409;
              await db.execute(
                "INSERT INTO local_server_backups(id,server_id,node_id,adapter,state,operation_started_at) VALUES (?,?,?,?,'creating',CURRENT_TIMESTAMP(3))",
                [id, server, record.nodeId, adapter],
              );
              if (adapter === "s3")
                await db.execute(
                  "INSERT INTO s3_fixture_receipts(id,server_id,node_id) VALUES (?,?,?)",
                  [id, server, record.nodeId],
                );
            } else {
              if (selected?.state !== "ready") return 409;
              await db.execute(
                "UPDATE local_server_backups SET state='restoring',operation_started_at=CURRENT_TIMESTAMP(3) WHERE id=? AND state='ready'",
                [id],
              );
            }
            return { adapter, nodeId: record.nodeId };
          });
          if (typeof dispatch === "number")
            return reply.code(dispatch).send({
              error: dispatch === 404 ? "not_found" : "backup_conflict",
            });
          try {
            if (dispatch.adapter === "s3")
              await withS3(
                { id: server, nodeId: dispatch.nodeId },
                id,
                async (store) => {
                  if (action === "create") await store.initialize();
                  await client.fixtureS3Backup(
                    server,
                    id,
                    action === "restore" ? await store.url() : undefined,
                  );
                },
              );
            else await client.fixtureBackup(server, id, action);
          } catch {
            return reply
              .code(502)
              .send({ id, error: "backup_dispatch_uncertain" });
          }
          return reply.code(202).send({ id });
        },
      );
    }
  }
  return { register, callback, urls, s3Enabled };
}
