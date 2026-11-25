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
  authenticate: (authorization: string) => Promise<string | null>,
  resources?: (id: string) => Promise<unknown>,
) {
  for (const path of ["/api/client", "/api/client/"])
    app.get<{ Querystring: Record<string, unknown> }>(
      path,
      { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
      async (req, reply) => {
        reply.header("cache-control", "no-store");
        const user = await authenticate(req.headers.authorization ?? "");
        if (!user)
          return reply
            .code(401)
            .send(errors("AuthenticationException", "Unauthenticated."));
        const page = integer(req.query.page, 1, 1_000_000),
          size = integer(req.query.per_page, 50, 100);
        if (
          page === null ||
          size === null ||
          Object.keys(req.query).some(
            (key) => key !== "page" && key !== "per_page",
          )
        )
          return reply
            .code(400)
            .send(
              errors("BadRequestHttpException", "Unsupported list parameters."),
            );
        const scope = [user, user];
        const { total, records } = await transaction(
          pool,
          async (db: Executor) => {
            const [count] = await rows<{ total: number }>(
              db,
              `SELECT COUNT(*) AS total FROM servers s WHERE ${visible}`,
              scope,
            );
            const records = await rows<Server>(
              db,
              `${projection} WHERE ${visible} ORDER BY s.name,s.id LIMIT ? OFFSET ?`,
              [user, ...scope, size, (page - 1) * size],
            );
            return { total: Number(count.total), records };
          },
        );
        const pages = Math.max(1, Math.ceil(total / size));
        const link = (number: number) =>
          `${origin}/api/client?${new URLSearchParams({ ...(req.query.per_page === undefined ? {} : { per_page: String(size) }), page: String(number) })}`;
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
  app.get<{ Params: { identifier: string } }>(
    "/api/client/servers/:identifier/resources",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      const user = await authenticate(req.headers.authorization ?? "");
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
  app.get<{ Params: { identifier: string } }>(
    "/api/client/servers/:identifier",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      const user = await authenticate(req.headers.authorization ?? "");
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
