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
import type { FixtureBackupCallback } from "./remote";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_RECEIPTS = 3;
type Backup = {
  id: string;
  state: string;
  locked: number;
  needsReview: number;
  sizeBytes: number | null;
  checksum: string | null;
  createdAt: string;
};
const columns =
  "b.id,b.state,b.locked,b.size_bytes AS sizeBytes,b.checksum,b.created_at AS createdAt, CASE WHEN b.state IN ('creating','restoring') AND b.operation_started_at <= CURRENT_TIMESTAMP(3) - INTERVAL 2 MINUTE THEN 1 ELSE 0 END AS needsReview";
type Target = { id: string; owner: string; nodeId: string; cipher: Buffer };

export function localBackupService(
  pool: Pool,
  node: WingsNode,
  key: Buffer,
  pepper: Buffer,
  origin: string,
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
  const callback: FixtureBackupCallback = async (id, phase, event) => {
    const [record] = await rows<Target>(
      pool,
      `SELECT b.server_id AS id,s.owner_id AS owner,n.id AS nodeId,n.token_cipher AS cipher
      FROM local_server_backups b JOIN servers s ON s.id=b.server_id AND s.node_id=b.node_id JOIN nodes n ON n.id=b.node_id
      WHERE b.id=? AND n.origin=? AND n.token_id=?`,
      [id, node.origin, node.tokenId],
    );
    if (!record || !nodeMatches(record)) return false;
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
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const signed = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: origin, aud: [node.origin], iat: now, nbf: now - 1, exp: now + 15, jti: randomUUID(), unique_id: randomUUID(), server_uuid: record.id, user_uuid: record.owner, backup_uuid: backup.id, scope: "backup-download" })}`;
    const url = new URL("/download/backup", node.origin);
    url.searchParams.set(
      "token",
      `${signed}.${createHmac("sha256", node.token).update(signed).digest("base64url")}`,
    );
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
  function register(
    app: FastifyInstance,
    sessionUser: (req: FastifyRequest) => Promise<string | null>,
  ) {
    type Params = { id: string; backup?: string };
    const root = "/api/v1/servers/:id/backups";
    const config = { rateLimit: { max: 12, timeWindow: "1 minute" } };
    app.get<{ Params: Params }>(root, { config }, async (req, reply) => {
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
            return { status: 202, nodeId: record.nodeId } as const;
          });
          if (result.status === 204) return reply.code(204).send();
          if (result.status !== 202)
            return reply.code(result.status).send({
              error: result.status === 404 ? "not_found" : "backup_conflict",
            });
          try {
            await client.fixtureBackup(server, id, "delete");
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
          if (
            req.body !== undefined &&
            (req.body === null ||
              typeof req.body !== "object" ||
              Array.isArray(req.body) ||
              Object.keys(req.body).length)
          )
            return reply.code(400).send({ error: "invalid_request" });
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
          const status = await transaction(pool, async (db) => {
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
            if (action === "create") {
              if (existing.length >= MAX_RECEIPTS) return 409;
              await db.execute(
                "INSERT INTO local_server_backups(id,server_id,node_id,state,operation_started_at) VALUES (?,?,?,'creating',CURRENT_TIMESTAMP(3))",
                [id, server, record.nodeId],
              );
            } else {
              if (selected?.state !== "ready") return 409;
              await db.execute(
                "UPDATE local_server_backups SET state='restoring',operation_started_at=CURRENT_TIMESTAMP(3) WHERE id=? AND state='ready'",
                [id],
              );
            }
            return 202;
          });
          if (status !== 202)
            return reply.code(status).send({
              error: status === 404 ? "not_found" : "backup_conflict",
            });
          try {
            await client.fixtureBackup(server, id, action);
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
  return { register, callback };
}
