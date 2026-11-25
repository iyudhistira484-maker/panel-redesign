import { registerClientStream, type StreamBinding } from "./client-stream";
import type { Actor } from "./policy";
import type { FastifyInstance } from "fastify";
import { rows, transaction, type Executor } from "./db";
import type { Pool } from "mysql2/promise";
import { ProvisionError } from "./wings/provision";
import { UUID_V4 } from "./wings/client";

type Server = {
  id: string;
  name: string;
  node: string;
  owner_id: string;
  permissions: string[] | string | null;
};
const visible = `(s.owner_id=? OR EXISTS (SELECT 1 FROM server_grants g WHERE g.server_id=s.id AND g.user_id=? AND JSON_LENGTH(g.permissions)>0))`;
const projection = `SELECT s.id,s.name,n.name AS node,s.owner_id,g.permissions FROM servers s JOIN nodes n ON n.id=s.node_id LEFT JOIN server_grants g ON g.server_id=s.id AND g.user_id=?`;
function item(row: Server, user: string) {
  return {
    object: "server",
    attributes: {
      uuid: row.id,
      identifier: row.id.slice(0, 8),
      __deprecated_uuid_short: row.id.slice(0, 8),
      name: row.name,
      node: row.node,
      server_owner: row.owner_id === user,
    },
  };
}
const errors = (code: string, detail: string) => ({
  errors: [
    {
      code,
      status:
        code === "NotFoundHttpException"
          ? "404"
          : code === "AuthenticationException"
            ? "401"
            : "400",
      detail,
    },
  ],
});
function integer(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d{1,9}$/.test(value)) return null;
  const number = Number(value);
  return number >= 1 ? Math.min(number, max) : null;
}
export function registerClientCompatibility(
  app: FastifyInstance,
  pool: Pool,
  origin: string,
  authenticate: (authorization: string) => Promise<Actor | null>,
  resources?: (id: string) => Promise<unknown>,
  power?: (
    id: string,
    action: "start" | "stop" | "restart",
    actor: Actor,
  ) => Promise<unknown>,
  command?: (id: string, command: string, actor: Actor) => Promise<void>,
  stream?: StreamBinding,
) {
  for (const path of ["/api/client", "/api/client/"])
    app.get<{ Querystring: Record<string, unknown> }>(
      path,
      { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
      async (req, reply) => {
        reply.header("cache-control", "no-store");
        const user = (await authenticate(req.headers.authorization ?? ""))?.id;
        if (!user)
          return reply
            .code(401)
            .send(errors("AuthenticationException", "Unauthenticated."));
        const page = integer(req.query.page, 1, 1_000_000),
          size = integer(req.query.per_page, 50, 100);
        const { type, "filter[name]": name, "filter[uuid]": uuid } = req.query;
        const supported = new Set([
          "page",
          "per_page",
          "type",
          "filter[name]",
          "filter[uuid]",
        ]);
        if (
          page === null ||
          size === null ||
          (type !== undefined && type !== "owner") ||
          (name !== undefined &&
            (typeof name !== "string" ||
              name.length < 1 ||
              name.length > 100 ||
              name.includes(","))) ||
          (uuid !== undefined &&
            (typeof uuid !== "string" || !/^[0-9a-f-]{1,36}$/i.test(uuid))) ||
          Object.keys(req.query).some((key) => !supported.has(key))
        )
          return reply
            .code(400)
            .send(
              errors("BadRequestHttpException", "Unsupported list parameters."),
            );
        const conditions = [type === "owner" ? "s.owner_id=?" : visible];
        const scope = type === "owner" ? [user] : [user, user];
        const partial = (value: string) =>
          `%${value.replace(/[!%_]/g, (char) => `!${char}`)}%`;
        if (typeof name === "string") {
          conditions.push("LOWER(s.name) LIKE LOWER(?) ESCAPE '!'");
          scope.push(partial(name));
        }
        if (typeof uuid === "string") {
          conditions.push("LOWER(s.id) LIKE LOWER(?) ESCAPE '!'");
          scope.push(partial(uuid));
        }
        const where = conditions.join(" AND ");
        const { total, records } = await transaction(
          pool,
          async (db: Executor) => {
            const [count] = await rows<{ total: number }>(
              db,
              `SELECT COUNT(*) AS total FROM servers s WHERE ${where}`,
              scope,
            );
            const records = await rows<Server>(
              db,
              `${projection} WHERE ${where} ORDER BY s.name,s.id LIMIT ? OFFSET ?`,
              [user, ...scope, size, (page - 1) * size],
            );
            return { total: Number(count.total), records };
          },
        );
        const pages = Math.max(1, Math.ceil(total / size));
        const link = (number: number) => {
          const params = new URLSearchParams();
          for (const [key, value] of Object.entries(req.query))
            if (key !== "page" && typeof value === "string")
              params.set(key, key === "per_page" ? String(size) : value);
          params.set("page", String(number));
          return `${origin}/api/client?${params}`;
        };
        const links: Record<string, string> = {};
        if (page > 1) links.previous = link(page - 1);
        if (page < pages) links.next = link(page + 1);
        return {
          object: "list",
          data: records.map((row) => item(row, user)),
          meta: {
            pagination: {
              total,
              count: records.length,
              per_page: size,
              current_page: page,
              total_pages: pages,
              links: Object.keys(links).length ? links : [],
            },
          },
        };
      },
    );
  async function resolve(identifier: string, user: string) {
    const full = UUID_V4.test(identifier);
    if (!full && !/^[a-f0-9]{8}$/.test(identifier)) return null;
    const records = await rows<Server>(
      pool,
      `${projection} WHERE ${visible} AND ${full ? "s.id=?" : "s.id LIKE ?"} LIMIT 2`,
      [user, user, user, full ? identifier : `${identifier}-%`],
    );
    return records.length === 1 ? records[0] : null;
  }
  const issueStream = stream
    ? registerClientStream(app, origin, stream)
    : undefined;
  app.get<{ Params: { identifier: string } }>(
    "/api/client/servers/:identifier/websocket",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const actor = await authenticate(req.headers.authorization ?? "");
      if (!actor)
        return reply
          .code(401)
          .send(errors("AuthenticationException", "Unauthenticated."));
      const server = await resolve(req.params.identifier, actor.id);
      if (!server)
        return reply
          .code(404)
          .send(errors("NotFoundHttpException", "Server not found."));
      const result = await issueStream?.(server.id, actor);
      if (!result)
        return reply.code(403).send({
          errors: [
            {
              code: "AuthorizationException",
              status: "403",
              detail: "WebSocket access unavailable.",
            },
          ],
        });
      return result;
    },
  );
  app.get<{ Params: { identifier: string } }>(
    "/api/client/servers/:identifier/resources",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      const user = (await authenticate(req.headers.authorization ?? ""))?.id;
      if (!user)
        return reply
          .code(401)
          .send(errors("AuthenticationException", "Unauthenticated."));
      const server = await resolve(req.params.identifier, user);
      if (!server)
        return reply
          .code(404)
          .send(errors("NotFoundHttpException", "Server not found."));
      const unavailable = (status: number) =>
        reply.code(status).send({
          errors: [
            {
              code: "DaemonConnectionException",
              status: String(status),
              detail: "Server resources unavailable.",
            },
          ],
        });
      if (!resources) return unavailable(503);
      try {
        return { object: "stats", attributes: await resources(server.id) };
      } catch (error) {
        if (error instanceof ProvisionError) return unavailable(error.status);
        throw error;
      }
    },
  );
  app.post<{ Params: { identifier: string }; Body: { command: string } }>(
    "/api/client/servers/:identifier/command",
    {
      bodyLimit: 1024,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      const principal = await authenticate(req.headers.authorization ?? "");
      if (!principal)
        return reply
          .code(401)
          .send(errors("AuthenticationException", "Unauthenticated."));
      const input = req.body?.command;
      if (
        typeof input !== "string" ||
        Object.keys(req.body ?? {}).length !== 1 ||
        !/^relay-marker [a-f0-9]{24}(?![\s\S])/.test(input)
      )
        return reply
          .code(400)
          .send(
            errors(
              "BadRequestHttpException",
              "Only the staging marker command is supported.",
            ),
          );
      const server = await resolve(req.params.identifier, principal.id);
      if (!server)
        return reply
          .code(404)
          .send(errors("NotFoundHttpException", "Server not found."));
      const unavailable = (status: number, code: string, detail: string) =>
        reply
          .code(status)
          .send({ errors: [{ code, status: String(status), detail }] });
      if (!command)
        return unavailable(
          503,
          "ServiceUnavailableHttpException",
          "Server console unavailable.",
        );
      try {
        await command(server.id, input, principal);
        return reply.code(204).send();
      } catch (error) {
        if (!(error instanceof ProvisionError)) throw error;
        if (error.status === 404)
          return reply
            .code(404)
            .send(errors("NotFoundHttpException", "Server not found."));
        return unavailable(
          error.status,
          error.status === 403
            ? "AuthorizationException"
            : "CommandRequestException",
          error.status === 502
            ? "Command delivery unconfirmed."
            : "Command not permitted or unavailable.",
        );
      }
    },
  );
  app.post<{
    Params: { identifier: string };
    Body: { signal: "start" | "stop" | "restart" };
  }>(
    "/api/client/servers/:identifier/power",
    {
      bodyLimit: 2048,
      config: { rateLimit: { max: 15, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      const principal = await authenticate(req.headers.authorization ?? "");
      if (!principal)
        return reply
          .code(401)
          .send(errors("AuthenticationException", "Unauthenticated."));
      const { signal } = req.body ?? {};
      if (
        (signal !== "start" && signal !== "stop" && signal !== "restart") ||
        Object.keys(req.body ?? {}).length !== 1
      )
        return reply
          .code(400)
          .send(
            errors(
              "BadRequestHttpException",
              "Only start, stop and restart signals are supported.",
            ),
          );
      const server = await resolve(req.params.identifier, principal.id);
      if (!server)
        return reply
          .code(404)
          .send(errors("NotFoundHttpException", "Server not found."));
      if (!power)
        return reply.code(503).send({
          errors: [
            {
              code: "ServiceUnavailableHttpException",
              status: "503",
              detail: "Server power unavailable.",
            },
          ],
        });
      try {
        await power(server.id, signal, principal);
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof ProvisionError)
          return reply.code(error.status).send({
            errors: [
              {
                code:
                  error.status === 404
                    ? "NotFoundHttpException"
                    : error.status === 403
                      ? "AuthorizationException"
                      : "PowerRequestException",
                status: String(error.status),
                detail:
                  error.status === 502
                    ? "Power outcome unknown."
                    : "Power request not permitted or unavailable.",
              },
            ],
          });
        throw error;
      }
    },
  );
  app.get<{ Params: { identifier: string } }>(
    "/api/client/servers/:identifier",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      const user = (await authenticate(req.headers.authorization ?? ""))?.id;
      if (!user)
        return reply
          .code(401)
          .send(errors("AuthenticationException", "Unauthenticated."));
      const { identifier } = req.params;
      const missing = () =>
        reply
          .code(404)
          .send(errors("NotFoundHttpException", "Server not found."));
      const record = await resolve(identifier, user);
      if (!record) return missing();
      return {
        ...item(record, user),
        meta: {
          is_server_owner: record.owner_id === user,
          user_permissions:
            record.owner_id === user
              ? ["*"]
              : typeof record.permissions === "string"
                ? JSON.parse(record.permissions)
                : (record.permissions ?? []),
        },
      };
    },
  );
}
