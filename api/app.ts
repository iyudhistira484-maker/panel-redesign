import {
  createFixtureReceiver,
  type FixtureReceiver,
} from "./wings/transfer-receiver";
import { createProvisioner, ProvisionError } from "./wings/provision";
import { registerCatalog, type FixtureTransfer } from "./catalog/routes";
import { registerRemote } from "./wings/remote";
import { UUID_V4, type WingsNode } from "./wings/client";
import { randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { Pool } from "mysql2/promise";
import { rows, transaction, type Executor } from "./db";
import { canAccount, type Actor } from "./policy";
import {
  checkPassword,
  cryptoContext,
  matchingStep,
  passwordHash,
  token,
} from "./security";

export type ResetMessage = {
  email: string;
  locale: "id" | "en";
  token: string;
};
export type Options = {
  pool: Pool;
  origin: string;
  key: Buffer;
  pepper: Buffer;
  deliverReset: (message: ResetMessage) => Promise<void>;
  wingsTestNode?: WingsNode;
  enableDisposableProvisioning?: boolean;
  catalogNodeKey?: Buffer;
  allowedCatalogNodeOrigins?: readonly string[];
  fixtureTransfer?: FixtureTransfer;
  fixtureReceiver?: FixtureReceiver;
};
type User = {
  id: string;
  email: string;
  display_name: string;
  locale: "id" | "en";
  is_admin: 0 | 1;
  password_hash: string;
  totp_secret: Buffer | null;
  totp_step: number | null;
  auth_version: number;
};
type Session = User & { authenticated: 0 | 1 };
const secretPattern = "^[A-Za-z0-9_-]{43}$";
const sessionCookie = "__Host-relay_session";
const cookieSettings = {
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "strict",
} as const;
const object = (
  properties: Record<string, object>,
  required = Object.keys(properties),
) => ({ type: "object", properties, required, additionalProperties: false });
const text = (minLength: number, maxLength: number, pattern?: string) => ({
  type: "string",
  minLength,
  maxLength,
  ...(pattern ? { pattern } : {}),
});
const email = text(3, 254, "^[^@\\s]+@[^@\\s]+$");
const password = text(1, 128);
const newPassword = text(12, 128);
const code = text(6, 43);
const secret = text(43, 43, secretPattern);
const uuid = text(36, 36, "^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$");
const authLimit = { rateLimit: { max: 12, timeWindow: "1 minute" } };
const publicUser = (u: User) => ({
  id: u.id,
  email: u.email,
  displayName: u.display_name,
  locale: u.locale,
  admin: !!u.is_admin,
  twoFactor: !!u.totp_secret,
});
const audit = (db: Executor, event: string, user: string) =>
  db.execute(
    "INSERT INTO audit_log (actor_id,event,subject_id) VALUES (?,?,?)",
    [user, event, user],
  );

export async function createApp({
  pool,
  origin,
  key,
  pepper,
  deliverReset,
  wingsTestNode,
  enableDisposableProvisioning,
  catalogNodeKey,
  allowedCatalogNodeOrigins,
  fixtureTransfer,
  fixtureReceiver,
}: Options) {
  if ((fixtureTransfer || fixtureReceiver) && !enableDisposableProvisioning)
    throw new Error(
      "Fixture transfer requires explicit disposable provisioning",
    );
  if (new URL(origin).origin !== origin || !origin.startsWith("https://"))
    throw new Error("Set an exact HTTPS panel origin");
  if (
    enableDisposableProvisioning &&
    (!wingsTestNode ||
      !catalogNodeKey ||
      !allowedCatalogNodeOrigins?.includes(wingsTestNode.origin))
  )
    throw new Error(
      "Provisioning requires explicit disposable node, key and exact allowlist",
    );
  const provisioner =
    enableDisposableProvisioning && wingsTestNode && catalogNodeKey
      ? createProvisioner(pool, wingsTestNode, catalogNodeKey, pepper, origin)
      : undefined;
  const receiver =
    fixtureReceiver && provisioner && wingsTestNode && catalogNodeKey
      ? createFixtureReceiver(
          pool,
          wingsTestNode,
          catalogNodeKey,
          pepper,
          fixtureReceiver,
          provisioner.provider,
        )
      : undefined;
  const crypt = cryptoContext(key, pepper);
  const dummyHash = await passwordHash(token());
  const app = Fastify({
    logger: false,
    bodyLimit: 8192,
    requestTimeout: 15000,
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        useDefaults: false,
      },
    },
  });
  await app.register(helmet);
  await app.register(cookie);
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    skipOnError: false,
  });
  app.addHook("onRequest", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (
      !(
        wingsTestNode &&
        (req.routeOptions.url === "/api/remote/servers/reset" ||
          (provisioner &&
            req.routeOptions.url === "/api/remote/servers/:uuid/install") ||
          (receiver &&
            req.routeOptions.url ===
              "/api/remote/servers/:uuid/transfer/:result")) &&
        req.method === "POST"
      ) &&
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      (req.headers.origin !== origin || req.headers["x-relay-request"] !== "1")
    ) {
      return reply.code(403).send({ error: "origin_rejected" });
    }
  });
  app.setErrorHandler((error, _req, reply) => {
    const e = error as { validation?: unknown; statusCode?: number };
    const status = e.validation
      ? 400
      : e.statusCode && e.statusCode >= 400 && e.statusCode < 500
        ? e.statusCode
        : 500;
    return reply.code(status).send({
      error:
        status === 500
          ? "internal_error"
          : status === 429
            ? "rate_limited"
            : "invalid_request",
    });
  });
  const sessionKey = (raw: string) => crypt.digest("session", raw);
  async function session(
    raw: string | undefined,
    db: Executor = pool,
    lock = false,
  ) {
    if (!raw || !new RegExp(secretPattern).test(raw)) return undefined;
    return (
      await rows<Session>(
        db,
        `SELECT u.*,s.authenticated FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.digest=? AND s.expires_at>UTC_TIMESTAMP(3)${lock ? " FOR UPDATE" : ""}`,
        [sessionKey(raw)],
      )
    )[0];
  }
  async function issue(db: Executor, user: string, complete: boolean) {
    const value = token();
    await db.execute(
      "INSERT INTO sessions (digest,user_id,authenticated,expires_at) VALUES (?,?,?,TIMESTAMPADD(SECOND,?,UTC_TIMESTAMP(3)))",
      [sessionKey(value), user, complete, complete ? 43200 : 300],
    );
    return value;
  }
  async function throttle(kind: string, subject: string, max: number) {
    return transaction(pool, async (db) => {
      const digest = crypt.digest("throttle", `${kind}:${subject}`);
      await db.execute(
        "INSERT INTO auth_throttles (digest,attempts,expires_at) VALUES (?,0,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE digest=digest",
        [digest],
      );
      const record = (
        await rows<{ attempts: number; expired: 0 | 1 }>(
          db,
          "SELECT attempts, expires_at<=UTC_TIMESTAMP(3) AS expired FROM auth_throttles WHERE digest=? FOR UPDATE",
          [digest],
        )
      )[0];
      if (!record.expired && record.attempts >= max) return false;
      await db.execute(
        "UPDATE auth_throttles SET attempts=?, expires_at=IF(?,TIMESTAMPADD(MINUTE,15,UTC_TIMESTAMP(3)),expires_at) WHERE digest=?",
        [
          record.expired ? 1 : record.attempts + 1,
          Boolean(record.expired),
          digest,
        ],
      );
      return true;
    });
  }
  async function actor(
    raw: string | undefined,
    bearer: string | undefined,
  ): Promise<Actor | null> {
    if (bearer !== undefined) {
      const match = /^Bearer (rly_[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{22})$/.exec(
        bearer,
      );
      if (!match) return null;
      const record = (
        await rows<{ id: string }>(
          pool,
          "SELECT user_id AS id FROM api_keys WHERE digest=? AND expires_at>UTC_TIMESTAMP(3)",
          [crypt.digest("api-key", match[1])],
        )
      )[0];
      return record
        ? { id: record.id, admin: false, channel: "api-key" }
        : null;
    }
    const u = await session(raw);
    return u?.authenticated
      ? { id: u.id, admin: !!u.is_admin, channel: "session" }
      : null;
  }
  const generic = { error: "invalid_credentials" };
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_req, reply) => {
    try {
      await pool.execute("SELECT id FROM users LIMIT 0");
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ error: "not_ready" });
    }
  });
  app.post<{ Body: { email: string; password: string } }>(
    "/api/v1/auth/login",
    { config: authLimit, schema: { body: object({ email, password }) } },
    async (req, reply) => {
      const address = req.body.email.toLowerCase();
      if (!(await throttle("login", address, 12)))
        return reply.code(429).send({ error: "rate_limited" });
      const u = (
        await rows<User>(pool, "SELECT * FROM users WHERE email=?", [address])
      )[0];
      const result = await checkPassword(
        req.body.password,
        u?.password_hash ?? dummyHash,
      );
      if (!u || !result.valid) return reply.code(401).send(generic);
      const upgraded = result.upgrade
        ? await passwordHash(req.body.password)
        : null;
      const issued = await transaction(pool, async (db) => {
        const locked = (
          await rows<User>(db, "SELECT * FROM users WHERE id=? FOR UPDATE", [
            u.id,
          ])
        )[0];
        if (
          !locked ||
          locked.auth_version !== u.auth_version ||
          locked.password_hash !== u.password_hash
        )
          return null;
        if (upgraded)
          await db.execute("UPDATE users SET password_hash=? WHERE id=?", [
            upgraded,
            u.id,
          ]);
        const old = req.cookies[sessionCookie];
        if (old)
          await db.execute("DELETE FROM sessions WHERE digest=?", [
            sessionKey(old),
          ]);
        const complete = !locked.totp_secret;
        const raw = await issue(db, u.id, complete);
        await audit(
          db,
          complete ? "identity.login" : "identity.challenge",
          u.id,
        );
        return { raw, complete };
      });
      if (!issued) return reply.code(401).send(generic);
      return reply
        .setCookie(sessionCookie, issued.raw, {
          ...cookieSettings,
          maxAge: issued.complete ? 43200 : 300,
        })
        .send({ twoFactorRequired: !issued.complete });
    },
  );
  app.post<{ Body: { code: string } }>(
    "/api/v1/auth/challenge",
    { config: authLimit, schema: { body: object({ code }) } },
    async (req, reply) => {
      const raw = req.cookies[sessionCookie];
      const pending = await session(raw);
      if (!raw || !pending || pending.authenticated)
        return reply.code(401).send(generic);
      if (!(await throttle("challenge", pending.id, 10)))
        return reply.code(429).send({ error: "rate_limited" });
      const complete = await transaction(pool, async (db) => {
        const u = await session(raw, db, true);
        if (!u || u.authenticated || !u.totp_secret) return null;
        const step = matchingStep(
          crypt.open(u.totp_secret, u.id),
          req.body.code,
          Date.now(),
          u.totp_step ?? -1,
        );
        if (step !== null)
          await db.execute("UPDATE users SET totp_step=? WHERE id=?", [
            step,
            u.id,
          ]);
        else {
          const digest = crypt.digest(`recovery:${u.id}`, req.body.code);
          if (
            !(
              await rows<{ user_id: string }>(
                db,
                "SELECT user_id FROM recovery_codes WHERE digest=? AND user_id=? FOR UPDATE",
                [digest, u.id],
              )
            ).length
          )
            return null;
          await db.execute(
            "DELETE FROM recovery_codes WHERE digest=? AND user_id=?",
            [digest, u.id],
          );
        }
        await db.execute("DELETE FROM sessions WHERE digest=?", [
          sessionKey(raw),
        ]);
        const next = await issue(db, u.id, true);
        await audit(db, "identity.login", u.id);
        return next;
      });
      if (!complete) return reply.code(401).send(generic);
      return reply
        .setCookie(sessionCookie, complete, {
          ...cookieSettings,
          maxAge: 43200,
        })
        .send({ twoFactorRequired: false });
    },
  );
  app.post("/api/v1/auth/logout", async (req, reply) => {
    const raw = req.cookies[sessionCookie];
    if (raw)
      await transaction(pool, async (db) => {
        const u = await session(raw, db, true);
        await db.execute("DELETE FROM sessions WHERE digest=?", [
          sessionKey(raw),
        ]);
        if (u) await audit(db, "identity.logout", u.id);
      });
    return reply.clearCookie(sessionCookie, cookieSettings).code(204).send();
  });
  app.get("/api/v1/account", async (req, reply) => {
    const principal = await actor(
      req.cookies[sessionCookie],
      req.headers.authorization,
    );
    if (!principal) return reply.code(401).send(generic);
    const u = (
      await rows<User>(pool, "SELECT * FROM users WHERE id=?", [principal.id])
    )[0];
    if (!u || !canAccount(principal, u.id))
      return reply.code(403).send({ error: "forbidden" });
    return publicUser(u);
  });
  app.patch<{ Body: { displayName?: string; locale?: "id" | "en" } }>(
    "/api/v1/account",
    {
      schema: {
        body: {
          ...object(
            {
              displayName: text(1, 120),
              locale: { type: "string", enum: ["id", "en"] },
            },
            [],
          ),
          minProperties: 1,
        },
      },
    },
    async (req, reply) => {
      const raw = req.cookies[sessionCookie];
      const changed = await transaction(pool, async (db) => {
        const u = await session(raw, db, true);
        if (!u?.authenticated) return false;
        await db.execute(
          "UPDATE users SET display_name=COALESCE(?,display_name),locale=COALESCE(?,locale) WHERE id=?",
          [req.body.displayName ?? null, req.body.locale ?? null, u.id],
        );
        await audit(db, "identity.profile_changed", u.id);
        return true;
      });
      return changed ? reply.code(204).send() : reply.code(401).send(generic);
    },
  );
  app.post<{ Body: { email: string } }>(
    "/api/v1/auth/forgot-password",
    { config: authLimit, schema: { body: object({ email }) } },
    async (req, reply) => {
      const address = req.body.email.toLowerCase();
      if (!(await throttle("reset", address, 4))) return reply.code(202).send();
      const account = (
        await rows<User>(pool, "SELECT * FROM users WHERE email=?", [address])
      )[0];
      if (account) {
        const raw = token();
        const digest = crypt.digest("reset", raw);
        await pool.execute(
          "INSERT INTO password_resets (digest,user_id,expires_at) VALUES (?,?,TIMESTAMPADD(MINUTE,30,UTC_TIMESTAMP(3)))",
          [digest, account.id],
        );
        // Staging transport only. Do not log token or return delivery status to callers.
        void deliverReset({
          email: account.email,
          locale: account.locale,
          token: raw,
        })
          .catch(async () => {
            await pool.execute("DELETE FROM password_resets WHERE digest=?", [
              digest,
            ]);
          })
          .catch(() => {});
      }
      return reply.code(202).send();
    },
  );
  app.post<{ Body: { token: string; password: string } }>(
    "/api/v1/auth/reset-password",
    {
      config: authLimit,
      schema: { body: object({ token: secret, password: newPassword }) },
    },
    async (req, reply) => {
      const digest = crypt.digest("reset", req.body.token);
      const candidate = (
        await rows<{ user_id: string }>(
          pool,
          "SELECT user_id FROM password_resets WHERE digest=? AND expires_at>UTC_TIMESTAMP(3)",
          [digest],
        )
      )[0];
      if (!candidate) return reply.code(400).send({ error: "invalid_reset" });
      const hash = await passwordHash(req.body.password);
      const updated = await transaction(pool, async (db) => {
        await db.execute("SELECT id FROM users WHERE id=? FOR UPDATE", [
          candidate.user_id,
        ]);
        const active = (
          await rows<{ user_id: string }>(
            db,
            "SELECT user_id FROM password_resets WHERE digest=? AND expires_at>UTC_TIMESTAMP(3) FOR UPDATE",
            [digest],
          )
        )[0];
        if (!active) return false;
        await db.execute(
          "UPDATE users SET password_hash=?,auth_version=auth_version+1 WHERE id=?",
          [hash, active.user_id],
        );
        for (const sql of [
          "DELETE FROM sessions WHERE user_id=?",
          "DELETE FROM password_resets WHERE user_id=?",
          "DELETE FROM totp_enrollments WHERE user_id=?",
          "DELETE FROM api_keys WHERE user_id=?",
        ])
          await db.execute(sql, [active.user_id]);
        await audit(db, "identity.password_reset", active.user_id);
        return true;
      });
      return updated
        ? reply.clearCookie(sessionCookie, cookieSettings).code(204).send()
        : reply.code(400).send({ error: "invalid_reset" });
    },
  );
  app.post<{ Body: { password: string; seed: string } }>(
    "/api/v1/account/totp/begin",
    {
      config: authLimit,
      schema: {
        body: object({ password, seed: text(27, 27, "^[A-Za-z0-9_-]{27}$") }),
      },
    },
    async (req, reply) => {
      const raw = req.cookies[sessionCookie];
      const current = await session(raw);
      if (
        !current?.authenticated ||
        current.totp_secret ||
        !(await checkPassword(req.body.password, current.password_hash)).valid
      )
        return reply.code(401).send(generic);
      const seed = Buffer.from(req.body.seed, "base64url");
      if (seed.length !== 20 || seed.toString("base64url") !== req.body.seed)
        return reply.code(400).send({ error: "invalid_seed" });
      const saved = await transaction(pool, async (db) => {
        const u = await session(raw, db, true);
        if (
          !u?.authenticated ||
          u.totp_secret ||
          u.password_hash !== current.password_hash
        )
          return false;
        await db.execute(
          "INSERT INTO totp_enrollments (user_id,secret,expires_at) VALUES (?,?,TIMESTAMPADD(MINUTE,10,UTC_TIMESTAMP(3))) ON DUPLICATE KEY UPDATE secret=?,expires_at=TIMESTAMPADD(MINUTE,10,UTC_TIMESTAMP(3))",
          [u.id, crypt.seal(seed, u.id), crypt.seal(seed, u.id)],
        );
        return true;
      });
      if (!saved) return reply.code(401).send(generic);
      return reply.code(204).send();
    },
  );
  app.post<{ Body: { code: string; recoveryCodes: string[] } }>(
    "/api/v1/account/totp/confirm",
    {
      config: authLimit,
      schema: {
        body: object({
          code: text(6, 6, "^\\d{6}$"),
          recoveryCodes: {
            type: "array",
            minItems: 10,
            maxItems: 10,
            uniqueItems: true,
            items: text(16, 16, "^[A-Za-z0-9_-]{16}$"),
          },
        }),
      },
    },
    async (req, reply) => {
      const raw = req.cookies[sessionCookie];
      const confirmed = await transaction(pool, async (db) => {
        const u = await session(raw, db, true);
        if (!u?.authenticated || u.totp_secret) return null;
        const pending = (
          await rows<{ secret: Buffer }>(
            db,
            "SELECT secret FROM totp_enrollments WHERE user_id=? AND expires_at>UTC_TIMESTAMP(3) FOR UPDATE",
            [u.id],
          )
        )[0];
        if (!pending) return null;
        const step = matchingStep(
          crypt.open(pending.secret, u.id),
          req.body.code,
          Date.now(),
        );
        if (step === null) return null;
        const codes = req.body.recoveryCodes;
        await db.execute(
          "UPDATE users SET totp_secret=?,totp_step=?,auth_version=auth_version+1 WHERE id=?",
          [pending.secret, step, u.id],
        );
        await db.execute("DELETE FROM recovery_codes WHERE user_id=?", [u.id]);
        for (const c of codes)
          await db.execute(
            "INSERT INTO recovery_codes (digest,user_id) VALUES (?,?)",
            [crypt.digest(`recovery:${u.id}`, c), u.id],
          );
        await db.execute("DELETE FROM totp_enrollments WHERE user_id=?", [
          u.id,
        ]);
        await db.execute("DELETE FROM sessions WHERE user_id=?", [u.id]);
        await db.execute("DELETE FROM api_keys WHERE user_id=?", [u.id]);
        const next = await issue(db, u.id, true);
        await audit(db, "identity.totp_enabled", u.id);
        return next;
      });
      if (!confirmed)
        return reply.code(400).send({ error: "invalid_confirmation" });
      return reply
        .setCookie(sessionCookie, confirmed, {
          ...cookieSettings,
          maxAge: 43200,
        })
        .code(204)
        .send();
    },
  );
  app.post<{ Body: { password: string; code: string } }>(
    "/api/v1/account/totp/disable",
    {
      config: authLimit,
      schema: { body: object({ password, code: text(6, 6, "^\\d{6}$") }) },
    },
    async (req, reply) => {
      const raw = req.cookies[sessionCookie];
      const current = await session(raw);
      if (
        !current?.authenticated ||
        !current.totp_secret ||
        !(await checkPassword(req.body.password, current.password_hash)).valid
      )
        return reply.code(401).send(generic);
      const next = await transaction(pool, async (db) => {
        const u = await session(raw, db, true);
        if (
          !u?.authenticated ||
          !u.totp_secret ||
          u.password_hash !== current.password_hash
        )
          return null;
        if (
          matchingStep(
            crypt.open(u.totp_secret, u.id),
            req.body.code,
            Date.now(),
            u.totp_step ?? -1,
          ) === null
        )
          return null;
        await db.execute(
          "UPDATE users SET totp_secret=NULL,totp_step=NULL,auth_version=auth_version+1 WHERE id=?",
          [u.id],
        );
        await db.execute("DELETE FROM recovery_codes WHERE user_id=?", [u.id]);
        await db.execute("DELETE FROM sessions WHERE user_id=?", [u.id]);
        await audit(db, "identity.totp_disabled", u.id);
        return issue(db, u.id, true);
      });
      if (!next) return reply.code(401).send(generic);
      return reply
        .setCookie(sessionCookie, next, { ...cookieSettings, maxAge: 43200 })
        .code(204)
        .send();
    },
  );
  app.post<{ Body: { currentPassword: string; newPassword: string } }>(
    "/api/v1/account/password",
    {
      config: authLimit,
      schema: { body: object({ currentPassword: password, newPassword }) },
    },
    async (req, reply) => {
      const raw = req.cookies[sessionCookie];
      const current = await session(raw);
      if (
        !current?.authenticated ||
        !(await checkPassword(req.body.currentPassword, current.password_hash))
          .valid
      )
        return reply.code(401).send(generic);
      const hash = await passwordHash(req.body.newPassword);
      const next = await transaction(pool, async (db) => {
        const u = await session(raw, db, true);
        if (!u?.authenticated || u.password_hash !== current.password_hash)
          return null;
        await db.execute(
          "UPDATE users SET password_hash=?,auth_version=auth_version+1 WHERE id=?",
          [hash, u.id],
        );
        for (const sql of [
          "DELETE FROM sessions WHERE user_id=?",
          "DELETE FROM password_resets WHERE user_id=?",
          "DELETE FROM totp_enrollments WHERE user_id=?",
          "DELETE FROM api_keys WHERE user_id=?",
        ])
          await db.execute(sql, [u.id]);
        await audit(db, "identity.password_changed", u.id);
        return issue(db, u.id, true);
      });
      if (!next) return reply.code(401).send(generic);
      return reply
        .setCookie(sessionCookie, next, { ...cookieSettings, maxAge: 43200 })
        .code(204)
        .send();
    },
  );
  app.get("/api/v1/account/keys", async (req, reply) => {
    const u = await session(req.cookies[sessionCookie]);
    if (!u?.authenticated) return reply.code(401).send(generic);
    return rows<{ id: string; label: string; expires_at: string }>(
      pool,
      "SELECT id,label,expires_at FROM api_keys WHERE user_id=? ORDER BY expires_at DESC LIMIT 50",
      [u.id],
    );
  });
  app.post<{ Body: { label: string; key: string } }>(
    "/api/v1/account/keys",
    {
      config: authLimit,
      schema: {
        body: object({
          label: text(1, 80),
          key: text(47, 47, "^rly_[A-Za-z0-9_-]{43}$"),
        }),
      },
    },
    async (req, reply) => {
      const result = await transaction(pool, async (db) => {
        const u = await session(req.cookies[sessionCookie], db, true);
        if (!u?.authenticated) return null;
        const existing = await rows<{ id: string }>(
          db,
          "SELECT id FROM api_keys WHERE user_id=? AND expires_at>UTC_TIMESTAMP(3) LIMIT 10",
          [u.id],
        );
        if (existing.length >= 10) return false;
        const id = randomUUID();
        const suffix = randomBytes(16).toString("base64url");
        const digest = crypt.digest("api-key", `${req.body.key}.${suffix}`);
        try {
          await db.execute(
            "INSERT INTO api_keys (id,user_id,digest,label,expires_at) VALUES (?,?,?,?,TIMESTAMPADD(DAY,90,UTC_TIMESTAMP(3)))",
            [id, u.id, digest, req.body.label],
          );
        } catch (e) {
          if ((e as { code?: string }).code === "ER_DUP_ENTRY") return false;
          throw e;
        }
        await audit(db, "identity.api_key_created", u.id);
        return { id, suffix };
      });
      if (result === null) return reply.code(401).send(generic);
      if (result === false)
        return reply.code(409).send({ error: "key_conflict_or_limit" });
      return reply.code(201).send(result);
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/account/keys/:id",
    { schema: { params: object({ id: uuid }) } },
    async (req, reply) => {
      const result = await transaction(pool, async (db) => {
        const u = await session(req.cookies[sessionCookie], db, true);
        if (!u?.authenticated) return "unauthenticated";
        const record = (
          await rows<{ user_id: string }>(
            db,
            "SELECT user_id FROM api_keys WHERE id=? AND user_id=? FOR UPDATE",
            [req.params.id, u.id],
          )
        )[0];
        if (
          !record ||
          !canAccount(
            { id: u.id, admin: !!u.is_admin, channel: "session" },
            record.user_id,
            true,
          )
        )
          return "not_found";
        await db.execute("DELETE FROM api_keys WHERE id=? AND user_id=?", [
          req.params.id,
          u.id,
        ]);
        await audit(db, "identity.api_key_revoked", u.id);
        return "ok";
      });
      if (result === "unauthenticated") return reply.code(401).send(generic);
      if (result === "not_found")
        return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    },
  );
  app.get("/api/v1/account/activity", async (req, reply) => {
    const u = await session(req.cookies[sessionCookie]);
    if (!u?.authenticated) return reply.code(401).send(generic);
    return rows(
      pool,
      "SELECT CAST(id AS CHAR) AS id,event,created_at FROM audit_log WHERE actor_id=? ORDER BY id DESC LIMIT 100",
      [u.id],
    );
  });
  app.get<{ Querystring: { after?: string } }>(
    "/api/v1/servers",
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      const principal = await actor(
        req.cookies[sessionCookie],
        req.headers.authorization,
      );
      if (!principal || principal.channel !== "session")
        return reply.code(401).send({ error: "unauthenticated" });
      const after = req.query.after;
      if (
        after !== undefined &&
        (typeof after !== "string" || !UUID_V4.test(after))
      )
        return reply.code(400).send({ error: "invalid_cursor" });
      const result = await rows<{ id: string; name: string; isOwner: number }>(
        pool,
        `SELECT s.id,s.name,s.owner_id=? AS isOwner FROM servers s
      WHERE s.id>? AND (s.owner_id=? OR EXISTS (
        SELECT 1 FROM server_grants g WHERE g.server_id=s.id AND g.user_id=? AND JSON_LENGTH(g.permissions)>0
      )) ORDER BY s.id LIMIT 51`,
        [principal.id, after ?? "", principal.id, principal.id],
      );
      const items = result.slice(0, 50);
      return {
        items: items.map((item) => ({ ...item, isOwner: !!item.isOwner })),
        next: result.length > 50 ? items[49].id : null,
      };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/servers/:id/subusers",
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      const principal = await actor(
        req.cookies[sessionCookie],
        req.headers.authorization,
      );
      if (!principal || principal.channel !== "session")
        return reply.code(401).send({ error: "unauthenticated" });
      if (!UUID_V4.test(req.params.id))
        return reply.code(404).send({ error: "not_found" });
      const result = await rows<{
        id: string | null;
        email: string | null;
        permissions: string[] | string | null;
      }>(
        pool,
        `SELECT u.id,u.email,g.permissions FROM servers s
      LEFT JOIN server_grants g ON g.server_id=s.id AND JSON_LENGTH(g.permissions)>0
      LEFT JOIN users u ON u.id=g.user_id
      WHERE s.id=? AND s.owner_id=? ORDER BY u.email,u.id LIMIT 101`,
        [req.params.id, principal.id],
      );
      if (!result.length) return reply.code(404).send({ error: "not_found" });
      return {
        items: result
          .slice(0, 100)
          .filter((row) => row.id !== null)
          .map((row) => ({
            ...row,
            permissions:
              typeof row.permissions === "string"
                ? JSON.parse(row.permissions)
                : row.permissions,
          })),
        truncated: result.length > 100,
      };
    },
  );
  app.post<{
    Params: { id: string };
    Body: {
      email: string;
      action: "grant" | "revoke";
      permission?: "control.start" | "control.stop";
    };
  }>(
    "/api/v1/servers/:id/activity-access",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        body: object(
          {
            email,
            permission: {
              type: "string",
              enum: ["control.start", "control.stop"],
            },
            action: { type: "string", enum: ["grant", "revoke"] },
          },
          ["email", "action"],
        ),
      },
    },
    async (req, reply) => {
      const principal = await actor(
        req.cookies[sessionCookie],
        req.headers.authorization,
      );
      if (!principal || principal.channel !== "session")
        return reply.code(401).send({ error: "unauthenticated" });
      if (!UUID_V4.test(req.params.id))
        return reply.code(404).send({ error: "not_found" });
      const status = await transaction(pool, async (db) => {
        const [server] = await rows<{ owner_id: string }>(
          db,
          "SELECT owner_id FROM servers WHERE id=? FOR UPDATE",
          [req.params.id],
        );
        if (server?.owner_id !== principal.id) return 404;
        const [target] = await rows<{ id: string }>(
          db,
          "SELECT id FROM users WHERE email=?",
          [req.body.email.toLowerCase()],
        );
        if (!target || target.id === principal.id) return 422;
        const permission = req.body.permission;
        if (permission) {
          const [grant] = await rows<{ permissions: string[] | string }>(
            db,
            "SELECT permissions FROM server_grants WHERE server_id=? AND user_id=? FOR UPDATE",
            [req.params.id, target.id],
          );
          if (!grant) return 409;
          const current: string[] =
            typeof grant.permissions === "string"
              ? JSON.parse(grant.permissions)
              : grant.permissions;
          const adding = req.body.action === "grant";
          if (current.includes(permission) === adding) return 409;
          const updated = adding
            ? [...current, permission]
            : current.filter((value) => value !== permission);
          if (updated.length)
            await db.execute(
              "UPDATE server_grants SET permissions=? WHERE server_id=? AND user_id=?",
              [JSON.stringify(updated), req.params.id, target.id],
            );
          else
            await db.execute(
              "DELETE FROM server_grants WHERE server_id=? AND user_id=?",
              [req.params.id, target.id],
            );
          await db.execute(
            "INSERT INTO audit_log (actor_id,event,subject_id) VALUES (?,?,?)",
            [
              principal.id,
              `catalog.${permission}.${req.body.action}`,
              req.params.id,
            ],
          );
          return 204;
        }
        const [existing] = await rows<{ exact: number }>(
          db,
          "SELECT (JSON_LENGTH(permissions)=1 AND JSON_CONTAINS(permissions,JSON_QUOTE('activity.read'))) AS exact FROM server_grants WHERE server_id=? AND user_id=? FOR UPDATE",
          [req.params.id, target.id],
        );
        if (req.body.action === "grant") {
          if (existing) return 409;
          await db.execute(
            "INSERT INTO server_grants (server_id,user_id,permissions) VALUES (?,?,JSON_ARRAY('activity.read'))",
            [req.params.id, target.id],
          );
        } else {
          if (!existing?.exact) return 409;
          await db.execute(
            "DELETE FROM server_grants WHERE server_id=? AND user_id=?",
            [req.params.id, target.id],
          );
        }
        await db.execute(
          "INSERT INTO audit_log (actor_id,event,subject_id) VALUES (?,?,?)",
          [
            principal.id,
            req.body.action === "grant"
              ? "catalog.activity_access_granted"
              : "catalog.activity_access_revoked",
            req.params.id,
          ],
        );
        return 204;
      });
      if (status === 204) return reply.code(204).send();
      return reply.code(status).send({
        error:
          status === 404
            ? "not_found"
            : status === 409
              ? "grant_conflict"
              : "invalid_account",
      });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/servers/:id/activity",
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      const principal = await actor(
        req.cookies[sessionCookie],
        req.headers.authorization,
      );
      if (!principal || principal.channel !== "session")
        return reply.code(401).send({ error: "unauthenticated" });
      if (!UUID_V4.test(req.params.id))
        return reply.code(404).send({ error: "not_found" });
      const result = await rows<{
        id: string | null;
        event: string | null;
        created_at: Date | null;
        actor_name: string | null;
      }>(
        pool,
        `SELECT CAST(a.id AS CHAR) AS id, a.event, a.created_at, performer.display_name AS actor_name
      FROM servers s JOIN users u ON u.id=?
      LEFT JOIN server_grants g ON g.server_id=s.id AND g.user_id=u.id
      LEFT JOIN audit_log a ON a.subject_id=s.id AND (a.event LIKE 'catalog.%' OR a.event IN ('wings.power_start_requested','wings.power_stop_requested','wings.power_start_uncertain','wings.power_stop_uncertain'))
      LEFT JOIN users performer ON performer.id=a.actor_id
      WHERE s.id=? AND (s.owner_id=u.id OR u.is_admin=1 OR JSON_CONTAINS(g.permissions,JSON_QUOTE('activity.read'))=1)
      ORDER BY a.id DESC LIMIT 100`,
        [principal.id, req.params.id],
      );
      if (!result.length) return reply.code(404).send({ error: "not_found" });
      return result.filter((entry) => entry.id !== null);
    },
  );
  if (provisioner)
    app.get<{ Params: { id: string } }>(
      "/api/v1/servers/:id/runtime",
      { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
      async (req, reply) => {
        reply.header("cache-control", "no-store");
        const principal = await actor(
          req.cookies[sessionCookie],
          req.headers.authorization,
        );
        if (!principal || principal.channel !== "session")
          return reply.code(401).send({ error: "unauthenticated" });
        if (!UUID_V4.test(req.params.id))
          return reply.code(404).send({ error: "server_not_found" });
        try {
          return await provisioner.runtime(req.params.id, principal, "user");
        } catch (error) {
          if (error instanceof ProvisionError)
            return reply.code(error.status).send({ error: error.code });
          throw error;
        }
      },
    );
  if (provisioner)
    app.get<{
      Params: { id: string };
      Querystring: { directory?: string; preview?: string; download?: string };
    }>(
      "/api/v1/servers/:id/files",
      { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
      async (req, reply) => {
        reply.header("cache-control", "no-store");
        const principal = await actor(
          req.cookies[sessionCookie],
          req.headers.authorization,
        );
        if (!principal || principal.channel !== "session")
          return reply.code(401).send({ error: "unauthenticated" });
        if (!UUID_V4.test(req.params.id))
          return reply.code(404).send({ error: "server_not_found" });
        try {
          const path = req.query.directory ?? "/";
          if (typeof path !== "string")
            return reply.code(400).send({ error: "invalid_directory" });
          const preview = req.query.preview;
          if (preview !== undefined && typeof preview !== "string")
            return reply.code(400).send({ error: "invalid_text_file" });
          const download = req.query.download;
          if (download !== undefined && (download !== "1" || !preview))
            return reply.code(400).send({ error: "invalid_download" });
          const result = await provisioner.files(
            req.params.id,
            principal,
            path,
            preview,
            download === "1",
          );
          if (Buffer.isBuffer(result))
            return reply
              .header(
                "content-disposition",
                `attachment; filename="${preview}"`,
              )
              .header("x-content-type-options", "nosniff")
              .type("application/octet-stream")
              .send(result);
          return result;
        } catch (error) {
          if (error instanceof ProvisionError)
            return reply.code(error.status).send({ error: error.code });
          throw error;
        }
      },
    );
  if (provisioner)
    app.post<{
      Params: { id: string };
      Body: { version: string; text: string };
    }>(
      "/api/v1/servers/:id/files/edit-fixture",
      {
        bodyLimit: 100_000,
        config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
        schema: {
          body: object({
            version: text(64, 64, "^[a-f0-9]{64}$"),
            text: text(0, 16384),
          }),
        },
      },
      async (req, reply) => {
        reply.header("cache-control", "no-store");
        const principal = await actor(
          req.cookies[sessionCookie],
          req.headers.authorization,
        );
        if (!principal || principal.channel !== "session")
          return reply.code(401).send({ error: "unauthenticated" });
        if (!UUID_V4.test(req.params.id))
          return reply.code(404).send({ error: "server_not_found" });
        try {
          return await provisioner.editFixtureText(
            req.params.id,
            principal,
            req.body.version,
            req.body.text,
          );
        } catch (error) {
          if (error instanceof ProvisionError)
            return reply.code(error.status).send({ error: error.code });
          throw error;
        }
      },
    );
  if (provisioner)
    app.get<{ Params: { id: string } }>(
      "/api/v1/servers/:id/stats",
      { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
      async (req, reply) => {
        reply.header("cache-control", "no-store");
        const principal = await actor(
          req.cookies[sessionCookie],
          req.headers.authorization,
        );
        if (!principal || principal.channel !== "session")
          return reply.code(401).send({ error: "unauthenticated" });
        if (!UUID_V4.test(req.params.id))
          return reply.code(404).send({ error: "server_not_found" });
        try {
          return await provisioner.stats(req.params.id, principal, "user");
        } catch (error) {
          if (error instanceof ProvisionError)
            return reply.code(error.status).send({ error: error.code });
          throw error;
        }
      },
    );
  if (provisioner)
    app.get<{ Params: { id: string } }>(
      "/api/v1/servers/:id/console",
      { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
      async (req, reply) => {
        reply.header("cache-control", "no-store");
        const principal = await actor(
          req.cookies[sessionCookie],
          req.headers.authorization,
        );
        if (!principal || principal.channel !== "session")
          return reply.code(401).send({ error: "unauthenticated" });
        if (!UUID_V4.test(req.params.id))
          return reply.code(404).send({ error: "server_not_found" });
        try {
          return await provisioner.console(req.params.id, principal, "user");
        } catch (error) {
          if (error instanceof ProvisionError)
            return reply.code(error.status).send({ error: error.code });
          throw error;
        }
      },
    );
  if (provisioner)
    app.post<{
      Params: { id: string };
      Body: { action: "start" | "stop"; confirm: true };
    }>(
      "/api/v1/servers/:id/power",
      {
        config: { rateLimit: { max: 15, timeWindow: "1 minute" } },
        schema: {
          body: object({
            action: { type: "string", enum: ["start", "stop"] },
            confirm: { type: "boolean", const: true },
          }),
        },
      },
      async (req, reply) => {
        const principal = await actor(
          req.cookies[sessionCookie],
          req.headers.authorization,
        );
        if (!principal || principal.channel !== "session")
          return reply.code(401).send({ error: "unauthenticated" });
        if (!UUID_V4.test(req.params.id))
          return reply.code(404).send({ error: "server_not_found" });
        try {
          return reply
            .code(202)
            .send(
              await provisioner.power(
                req.params.id,
                req.body.action,
                principal,
                "user",
              ),
            );
        } catch (error) {
          if (error instanceof ProvisionError)
            return reply.code(error.status).send({ error: error.code });
          throw error;
        }
      },
    );
  if (wingsTestNode)
    await app.register(
      async (instance) =>
        registerRemote(
          instance,
          wingsTestNode,
          undefined,
          receiver?.provider ?? provisioner?.provider,
          receiver?.onTransfer,
        ),
      { prefix: "/api/remote" },
    );
  if (catalogNodeKey?.equals(key))
    throw new Error("Use a distinct node encryption key");
  await app.register(
    (instance) =>
      registerCatalog(instance, {
        pool,
        pepper,
        provisioner,
        nodeKey: catalogNodeKey,
        allowedNodeOrigins: allowedCatalogNodeOrigins,
        fixtureTransfer,
        authenticate: (req) =>
          actor(req.cookies[sessionCookie], req.headers.authorization),
      }),
    { prefix: "/api/v1/admin" },
  );
  return app;
}
