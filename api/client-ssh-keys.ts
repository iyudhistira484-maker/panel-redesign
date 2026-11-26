import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "mysql2/promise";
import { rows, transaction } from "./db";
import { sftpKeyFingerprint } from "./wings/sftp-auth";

type Entry = {
  fingerprint: Buffer;
  name: string;
  public_key: string;
  created_at: string;
};
const columns = "fingerprint,name,public_key,created_at";
const item = (row: Entry) => ({
  object: "ssh_key",
  attributes: {
    name: row.name,
    fingerprint: `SHA256:${row.fingerprint.toString("base64").replace(/=+$/, "")}`,
    public_key: row.public_key,
    created_at: new Date(`${row.created_at.replace(" ", "T")}Z`).toISOString(),
  },
});

export function registerClientSshKeys(
  app: FastifyInstance,
  pool: Pool,
  sessionUser: (req: FastifyRequest) => Promise<string | null>,
) {
  const path = "/api/client/account/ssh-keys";
  const limited = { rateLimit: { max: 20, timeWindow: "1 minute" } };
  app.get(path, { config: limited }, async (req, reply) => {
    const user = await sessionUser(req);
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    const list = await rows<Entry>(
      pool,
      `SELECT ${columns} FROM compat_sftp_keys WHERE user_id=? AND public_key IS NOT NULL ORDER BY created_at,fingerprint`,
      [user],
    );
    return { object: "list", data: list.map(item) };
  });
  app.post<{ Body: { name: string; public_key: string } }>(
    path,
    {
      config: limited,
      bodyLimit: 4096,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name", "public_key"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 80 },
            public_key: { type: "string", minLength: 1, maxLength: 2048 },
          },
        },
      },
    },
    async (req, reply) => {
      const user = await sessionUser(req);
      if (!user) return reply.code(401).send({ error: "unauthenticated" });
      const { name, public_key } = req.body;
      const fingerprint = sftpKeyFingerprint(public_key);
      if (!name.trim() || !fingerprint)
        return reply.code(422).send({ error: "invalid_ssh_key" });
      const canonical = public_key.trim().split(" ").slice(0, 2).join(" ");
      try {
        const result = await transaction(pool, async (db) => {
          const profile = await rows(
            db,
            "SELECT user_id FROM compat_account_profiles WHERE user_id=? FOR UPDATE",
            [user],
          );
          if (!profile.length) return "unmapped" as const;
          const [{ total }] = await rows<{ total: number }>(
            db,
            "SELECT COUNT(*) AS total FROM compat_sftp_keys WHERE user_id=?",
            [user],
          );
          if (total >= 10) return "limit" as const;
          await db.execute(
            "INSERT INTO compat_sftp_keys (user_id,fingerprint,name,public_key) VALUES (?,?,?,?)",
            [user, fingerprint, name.trim(), canonical],
          );
          await db.execute(
            "INSERT INTO audit_log (actor_id,event) VALUES (?,'user:ssh-key.create')",
            [user],
          );
          const [row] = await rows<Entry>(
            db,
            `SELECT ${columns} FROM compat_sftp_keys WHERE fingerprint=? AND user_id=?`,
            [fingerprint, user],
          );
          return row;
        });
        if (result === "unmapped")
          return reply.code(404).send({ error: "account_mapping_required" });
        if (result === "limit")
          return reply.code(409).send({ error: "ssh_key_limit" });
        return item(result);
      } catch (error) {
        if ((error as { code?: string }).code === "ER_DUP_ENTRY")
          return reply.code(409).send({ error: "ssh_key_conflict" });
        throw error;
      }
    },
  );
  app.post<{ Body: { fingerprint: string } }>(
    `${path}/remove`,
    {
      config: limited,
      bodyLimit: 1024,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["fingerprint"],
          properties: {
            fingerprint: {
              type: "string",
              pattern: "^SHA256:[A-Za-z0-9+/]{43}$",
            },
          },
        },
      },
    },
    async (req, reply) => {
      const user = await sessionUser(req);
      if (!user) return reply.code(401).send({ error: "unauthenticated" });
      const fingerprint = Buffer.from(req.body.fingerprint.slice(7), "base64");
      await transaction(pool, async (db) => {
        const [result] = await db.execute<
          import("mysql2/promise").ResultSetHeader
        >("DELETE FROM compat_sftp_keys WHERE fingerprint=? AND user_id=?", [
          fingerprint,
          user,
        ]);
        if (result.affectedRows)
          await db.execute(
            "INSERT INTO audit_log (actor_id,event) VALUES (?,'user:ssh-key.delete')",
            [user],
          );
      });
      return reply.code(204).send();
    },
  );
}
