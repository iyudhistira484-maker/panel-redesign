import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "mysql2/promise";
import { rows, transaction, type Executor } from "./db";

type Inventory = {
  id: number;
  uuid: string;
  name: string;
  phase: string | null;
};
const projection = `SELECT s.application_id AS id,s.id AS uuid,s.name,p.phase FROM servers s LEFT JOIN wings_provisions p ON p.server_id=s.id`;
const visible = `(p.phase IS NULL OR p.phase <> 'deleted')`;
const item = (row: Inventory) => ({
  object: "server",
  attributes: {
    id: row.id,
    uuid: row.uuid,
    identifier: row.uuid.slice(0, 8),
    name: row.name,
    status: row.phase === "installed" ? null : (row.phase ?? "draft"),
  },
});
function deny(
  reply: FastifyReply,
  status: number,
  code: string,
  detail: string,
) {
  return reply
    .code(status)
    .send({ errors: [{ code, status: String(status), detail }] });
}
function integer(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d{1,9}$/.test(value)) return null;
  const number = Number(value);
  return number >= 1 ? Math.min(number, max) : null;
}
export function registerApplicationInventory(
  app: FastifyInstance,
  pool: Pool,
  origin: string,
  digest: (key: string) => Buffer,
) {
  async function authorize(db: Executor, auth: string, reply: FastifyReply) {
    const token = /^rlya_[A-Za-z0-9_-]{43}$/.exec(
      auth.startsWith("Bearer ") ? auth.slice(7) : "",
    )?.[0];
    const [key] = token
      ? await rows<{ read_servers: number }>(
          db,
          `SELECT k.read_servers FROM application_keys k JOIN users u ON u.id=k.user_id WHERE k.digest=? AND k.expires_at>UTC_TIMESTAMP(3) AND u.is_admin=TRUE`,
          [digest(token)],
        )
      : [];
    if (!key) {
      deny(reply, 401, "AuthenticationException", "Unauthenticated.");
      return false;
    }
    if (!key.read_servers) {
      deny(
        reply,
        403,
        "AuthorizationException",
        "Server inventory access denied.",
      );
      return false;
    }
    return true;
  }
  const config = { rateLimit: { max: 40, timeWindow: "1 minute" } };
  const path = "/api/application/servers";
  app.get<{ Querystring: Record<string, unknown> }>(
    path,
    { config },
    async (req, reply) =>
      transaction(pool, async (db) => {
        if (!(await authorize(db, req.headers.authorization ?? "", reply)))
          return reply;
        const page = integer(req.query.page, 1, 999_999_999),
          size = integer(req.query.per_page, 50, 100);
        if (
          !page ||
          !size ||
          Object.keys(req.query).some(
            (key) => key !== "page" && key !== "per_page",
          )
        )
          return deny(
            reply,
            400,
            "BadRequestHttpException",
            "Only page and per_page are supported.",
          );
        const [count] = await rows<{ total: number }>(
          db,
          `SELECT COUNT(*) AS total FROM servers s LEFT JOIN wings_provisions p ON p.server_id=s.id WHERE ${visible}`,
        );
        const total = Number(count.total),
          pages = Math.max(1, Math.ceil(total / size));
        const records = await rows<Inventory>(
          db,
          `${projection} WHERE ${visible} ORDER BY s.application_id LIMIT ? OFFSET ?`,
          [size, (page - 1) * size],
        );
        const link = (number: number) =>
          `${origin}${path}?per_page=${size}&page=${number}`;
        const links: Record<string, string> = {};
        if (page > 1) links.previous = link(page - 1);
        if (page < pages) links.next = link(page + 1);
        return {
          object: "list",
          data: records.map(item),
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
      }),
  );
  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    `${path}/:id`,
    { config },
    async (req, reply) =>
      transaction(pool, async (db) => {
        if (!(await authorize(db, req.headers.authorization ?? "", reply)))
          return reply;
        if (Object.keys(req.query).length)
          return deny(
            reply,
            400,
            "BadRequestHttpException",
            "Relationships are not supported.",
          );
        const id = Number(req.params.id);
        const [record] =
          /^[1-9]\d{0,9}$/.test(req.params.id) && id <= 4_294_967_295
            ? await rows<Inventory>(
                db,
                `${projection} WHERE ${visible} AND s.application_id=?`,
                [id],
              )
            : [];
        return record
          ? item(record)
          : deny(reply, 404, "NotFoundHttpException", "Server not found.");
      }),
  );
}
