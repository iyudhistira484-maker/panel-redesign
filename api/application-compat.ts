import { randomUUID } from "node:crypto";
import { lockFreeAllocation } from "./catalog/transfer";
import { ProvisionError } from "./wings/provision";
import { isExternalServerId } from "./external-server-id";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "mysql2/promise";
import { rows, transaction, type Executor } from "./db";

type Inventory = {
  id: number;
  uuid: string;
  external_id: string | null;
  name: string;
  phase: string | null;
  node: number;
  allocation: number;
};
const projection = `SELECT s.application_id AS id,s.id AS uuid,s.external_id,s.name,n.application_id AS node,a.application_id AS allocation,p.phase FROM servers s JOIN nodes n ON n.id=s.node_id JOIN allocations a ON a.id=s.allocation_id LEFT JOIN wings_provisions p ON p.server_id=s.id`;
const visible = `(p.phase IS NULL OR p.phase <> 'deleted')`;
const item = (row: Inventory) => ({
  object: "server",
  attributes: {
    id: row.id,
    uuid: row.uuid,
    external_id: row.external_id,
    identifier: row.uuid.slice(0, 8),
    name: row.name,
    node: row.node,
    allocation: row.allocation,
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
  create?: {
    claim(db: Executor, id: string, actorId: string): Promise<void>;
    dispatch(id: string): Promise<string>;
  },
) {
  async function authorize(
    db: Executor,
    auth: string,
    reply: FastifyReply,
    scope:
      | "read_servers"
      | "read_nodes"
      | "read_allocations"
      | "create_servers" = "read_servers",
  ) {
    const token = /^rlya_[A-Za-z0-9_-]{43}$/.exec(
      auth.startsWith("Bearer ") ? auth.slice(7) : "",
    )?.[0];
    const [key] = token
      ? await rows<Record<typeof scope, number> & { user_id: string }>(
          db,
          `SELECT k.user_id,k.read_servers,k.read_nodes,k.read_allocations,k.create_servers FROM application_keys k JOIN users u ON u.id=k.user_id WHERE k.digest=? AND k.expires_at>UTC_TIMESTAMP(3) AND u.is_admin=TRUE${scope === "create_servers" ? " FOR UPDATE" : ""}`,
          [digest(token)],
        )
      : [];
    if (!key) {
      deny(reply, 401, "AuthenticationException", "Unauthenticated.");
      return false;
    }
    if (!key[scope]) {
      deny(reply, 403, "AuthorizationException", "Inventory access denied.");
      return false;
    }
    return key.user_id;
  }
  const config = { rateLimit: { max: 40, timeWindow: "1 minute" } };
  const path = "/api/application/servers";
  const profile = { memory: 128, swap: 0, disk: 64, io: 500, cpu: 50 };
  const featureLimits = { databases: 0, allocations: 0, backups: 0 };
  const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  const agrees = (value: unknown, expected: Record<string, unknown>) =>
    record(value) &&
    Object.keys(value).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, v]) => value[key] === v);
  const validId = (value: unknown): value is number =>
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 4_294_967_295;
  app.post(
    path,
    {
      bodyLimit: 4096,
      config: { rateLimit: { max: 12, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      try {
        const id = await transaction(pool, async (db) => {
          const actor = await authorize(
            db,
            req.headers.authorization ?? "",
            reply,
            "create_servers",
          );
          if (!actor) return null;
          if (!create)
            throw new ProvisionError(503, "staging_provisioning_unavailable");
          const input = req.body;
          if (
            !record(input) ||
            Object.keys(input).some(
              (field) =>
                ![
                  "name",
                  "user",
                  "egg",
                  "docker_image",
                  "startup",
                  "environment",
                  "limits",
                  "feature_limits",
                  "allocation",
                  "external_id",
                  "start_on_completion",
                ].includes(field),
            ) ||
            typeof input.name !== "string" ||
            !input.name.trim() ||
            [...input.name].length > 100 ||
            /\p{Cc}/u.test(input.name) ||
            !validId(input.user) ||
            !validId(input.egg) ||
            !record(input.allocation) ||
            Object.keys(input.allocation).length !== 1 ||
            !validId(input.allocation.default) ||
            input.docker_image !== "~relay-wings-contract-workload:ci" ||
            input.startup !== "sh /home/container/relay-start.sh" ||
            !agrees(input.environment, {}) ||
            !agrees(input.limits, profile) ||
            !agrees(input.feature_limits, featureLimits) ||
            (input.start_on_completion !== undefined &&
              input.start_on_completion !== false) ||
            (input.external_id !== undefined &&
              input.external_id !== null &&
              !isExternalServerId(input.external_id))
          )
            throw new ProvisionError(422, "invalid_fixture_profile");
          const [owner] = await rows<{ id: string }>(
            db,
            "SELECT id FROM users WHERE application_id=? AND email LIKE '%@example.test' AND is_admin=FALSE",
            [input.user],
          );
          const [egg] = await rows<{ id: string }>(
            db,
            "SELECT id FROM eggs WHERE application_id=?",
            [input.egg],
          );
          const [allocation] = await rows<{ id: string; node_id: string }>(
            db,
            "SELECT id,node_id FROM allocations WHERE application_id=? AND ip='127.0.0.1'",
            [input.allocation.default],
          );
          if (!owner || !egg || !allocation)
            throw new ProvisionError(422, "fixture_placement_not_supported");
          if (
            !(await lockFreeAllocation(db, allocation.node_id, allocation.id))
          )
            throw new ProvisionError(409, "allocation_unavailable");
          const id = randomUUID();
          await db.execute(
            "INSERT INTO servers (id,name,node_id,owner_id,egg_id,allocation_id,external_id) VALUES (?,?,?,?,?,?,?)",
            [
              id,
              input.name,
              allocation.node_id,
              owner.id,
              egg.id,
              allocation.id,
              input.external_id ?? null,
            ],
          );
          await create.claim(db, id, actor);
          return id;
        });
        if (!id || !create) return reply;
        const phase = await create.dispatch(id);
        const [result] = await rows<Inventory>(
          pool,
          `${projection} WHERE s.id=?`,
          [id],
        );
        if (phase === "uncertain" || phase === "install_failed")
          return reply.code(502).send({
            errors: [
              {
                code: "DaemonConnectionException",
                status: "502",
                detail: "Server reserved; installation not confirmed.",
              },
            ],
            meta: { server: item(result).attributes },
          });
        return reply.code(201).send(item(result));
      } catch (error) {
        if ((error as { code?: string }).code === "ER_DUP_ENTRY")
          return deny(
            reply,
            409,
            "ConflictHttpException",
            "Allocation or external ID already in use.",
          );
        if (error instanceof ProvisionError)
          return deny(
            reply,
            error.status,
            error.status === 409
              ? "ConflictHttpException"
              : "ProvisionException",
            error.code,
          );
        throw error;
      }
    },
  );
  app.get<{ Querystring: Record<string, unknown> }>(
    path,
    { config },
    async (req, reply) =>
      transaction(pool, async (db) => {
        if (!(await authorize(db, req.headers.authorization ?? "", reply)))
          return reply;
        const page = integer(req.query.page, 1, 999_999_999),
          size = integer(req.query.per_page, 50, 100);
        const uuid = req.query["filter[uuid]"];
        if (
          (uuid !== undefined &&
            (typeof uuid !== "string" || !/^[a-f0-9-]{1,36}$/i.test(uuid))) ||
          !page ||
          !size ||
          Object.keys(req.query).some(
            (key) =>
              key !== "page" && key !== "per_page" && key !== "filter[uuid]",
          )
        )
          return deny(
            reply,
            400,
            "BadRequestHttpException",
            "Invalid pagination or UUID filter.",
          );
        const where =
          uuid === undefined ? visible : `${visible} AND LOWER(s.id) LIKE ?`;
        const params =
          uuid === undefined ? [] : [`%${String(uuid).toLowerCase()}%`];
        const [count] = await rows<{ total: number }>(
          db,
          `SELECT COUNT(*) AS total FROM servers s LEFT JOIN wings_provisions p ON p.server_id=s.id WHERE ${where}`,
          params,
        );
        const total = Number(count.total),
          pages = Math.max(1, Math.ceil(total / size));
        const records = await rows<Inventory>(
          db,
          `${projection} WHERE ${where} ORDER BY s.application_id LIMIT ? OFFSET ?`,
          [...params, size, (page - 1) * size],
        );
        const link = (number: number) => {
          const query = new URLSearchParams({
            per_page: String(size),
            page: String(number),
          });
          if (typeof uuid === "string") query.set("filter[uuid]", uuid);
          return `${origin}${path}?${query}`;
        };
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
  app.get<{
    Params: { externalId: string };
    Querystring: Record<string, unknown>;
  }>(`${path}/external/:externalId`, { config }, async (req, reply) =>
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
      const [record] = isExternalServerId(req.params.externalId)
        ? await rows<Inventory>(
            db,
            `${projection} WHERE ${visible} AND s.external_id=?`,
            [req.params.externalId],
          )
        : [];
      return record
        ? item(record)
        : deny(reply, 404, "NotFoundHttpException", "Server not found.");
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
  const nodesPath = "/api/application/nodes";
  const nodeItem = (n: { id: number; uuid: string; name: string }) => ({
    object: "node",
    attributes: { id: n.id, uuid: n.uuid, name: n.name },
  });
  const numeric = (value: string) =>
    /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 4_294_967_295
      ? Number(value)
      : null;
  const pagination = (query: Record<string, unknown>) => {
    if (Object.keys(query).some((key) => key !== "page" && key !== "per_page"))
      return null;
    const page = integer(query.page, 1, 999_999_999),
      size = integer(query.per_page, 50, 100);
    return page && size ? { page, size } : null;
  };
  function list<T>(
    url: string,
    total: number,
    data: T[],
    { page, size }: { page: number; size: number },
  ) {
    const pages = Math.max(1, Math.ceil(total / size));
    const links: Record<string, string> = {};
    const link = (n: number) => `${origin}${url}?per_page=${size}&page=${n}`;
    if (page > 1) links.previous = link(page - 1);
    if (page < pages) links.next = link(page + 1);
    return {
      object: "list",
      data,
      meta: {
        pagination: {
          total,
          count: data.length,
          per_page: size,
          current_page: page,
          total_pages: pages,
          links: Object.keys(links).length ? links : [],
        },
      },
    };
  }
  const badQuery = (reply: FastifyReply) =>
    deny(reply, 400, "BadRequestHttpException", "Unsupported inventory query.");
  const missingNode = (reply: FastifyReply) =>
    deny(reply, 404, "NotFoundHttpException", "Node not found.");
  app.get<{ Querystring: Record<string, unknown> }>(
    nodesPath,
    { config },
    async (req, reply) =>
      transaction(pool, async (db) => {
        if (
          !(await authorize(
            db,
            req.headers.authorization ?? "",
            reply,
            "read_nodes",
          ))
        )
          return reply;
        const params = pagination(req.query);
        if (!params) return badQuery(reply);
        const [count] = await rows<{ total: number }>(
          db,
          "SELECT COUNT(*) AS total FROM nodes",
        );
        const records = await rows<{ id: number; uuid: string; name: string }>(
          db,
          "SELECT application_id AS id,id AS uuid,name FROM nodes ORDER BY application_id LIMIT ? OFFSET ?",
          [params.size, (params.page - 1) * params.size],
        );
        return list(
          nodesPath,
          Number(count.total),
          records.map(nodeItem),
          params,
        );
      }),
  );
  app.get<{ Params: { node: string }; Querystring: Record<string, unknown> }>(
    `${nodesPath}/:node`,
    { config },
    async (req, reply) =>
      transaction(pool, async (db) => {
        if (
          !(await authorize(
            db,
            req.headers.authorization ?? "",
            reply,
            "read_nodes",
          ))
        )
          return reply;
        if (Object.keys(req.query).length) return badQuery(reply);
        const id = numeric(req.params.node);
        const [record] =
          id === null
            ? []
            : await rows<{ id: number; uuid: string; name: string }>(
                db,
                "SELECT application_id AS id,id AS uuid,name FROM nodes WHERE application_id=?",
                [id],
              );
        return record ? nodeItem(record) : missingNode(reply);
      }),
  );
  app.get<{ Params: { node: string }; Querystring: Record<string, unknown> }>(
    `${nodesPath}/:node/allocations`,
    { config },
    async (req, reply) =>
      transaction(pool, async (db) => {
        if (
          !(await authorize(
            db,
            req.headers.authorization ?? "",
            reply,
            "read_allocations",
          ))
        )
          return reply;
        const params = pagination(req.query);
        if (!params) return badQuery(reply);
        const id = numeric(req.params.node);
        const [record] =
          id === null
            ? []
            : await rows<{ uuid: string }>(
                db,
                "SELECT id AS uuid FROM nodes WHERE application_id=?",
                [id],
              );
        if (!record) return missingNode(reply);
        const [count] = await rows<{ total: number }>(
          db,
          "SELECT COUNT(*) AS total FROM allocations WHERE node_id=?",
          [record.uuid],
        );
        const allocationRows = await rows<{
          id: number;
          ip: string;
          port: number;
          assigned: number;
        }>(
          db,
          `SELECT a.application_id AS id,a.ip,a.port,(EXISTS (SELECT 1 FROM servers s WHERE s.allocation_id=a.id) OR EXISTS (SELECT 1 FROM server_secondary_allocations sa WHERE sa.allocation_id=a.id)) AS assigned FROM allocations a WHERE a.node_id=? ORDER BY a.application_id LIMIT ? OFFSET ?`,
          [record.uuid, params.size, (params.page - 1) * params.size],
        );
        return list(
          `${nodesPath}/${id}/allocations`,
          Number(count.total),
          allocationRows.map((row) => ({
            object: "allocation",
            attributes: {
              id: row.id,
              ip: row.ip,
              port: row.port,
              alias: null,
              notes: null,
              assigned: Boolean(row.assigned),
            },
          })),
          params,
        );
      }),
  );
}
