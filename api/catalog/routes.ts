import { ProvisionError, type createProvisioner } from "../wings/provision";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, PoolConnection } from "mysql2/promise";
import { rows, transaction } from "../db";
import { EggFormatError, exportEgg, parseEgg } from "../eggs/codec";
import { canManageCatalog, type Actor } from "../policy";
import { cryptoContext } from "../security";
import { validateNode, WingsClient, WingsUnavailable } from "../wings/client";

type Options = {
  pool: Pool;
  authenticate: (req: FastifyRequest) => Promise<Actor | null>;
  nodeKey?: Buffer;
  provisioner?: ReturnType<typeof createProvisioner>;
  allowedNodeOrigins?: readonly string[];
  pepper: Buffer;
};
const id = {
  type: "string",
  pattern: "^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$",
};
const text = (max: number) => ({
  type: "string",
  minLength: 1,
  maxLength: max,
});
const schema = (properties: Record<string, object>) => ({
  type: "object",
  required: Object.keys(properties),
  additionalProperties: false,
  properties,
});
const byId = { params: schema({ id }) };
const put = (properties: Record<string, object>) => ({
  body: schema(properties),
});
const domainErrors = new Set(["ER_DUP_ENTRY", "ER_NO_REFERENCED_ROW_2"]);
class CatalogError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export async function registerCatalog(
  app: FastifyInstance,
  {
    pool,
    authenticate,
    provisioner,
    nodeKey,
    allowedNodeOrigins = [],
    pepper,
  }: Options,
) {
  const crypt = nodeKey
    ? cryptoContext(nodeKey, pepper, "node-token")
    : undefined;
  const principals = new WeakMap<FastifyRequest, Actor>();
  app.addHook("onRequest", async (req, reply) => {
    const actor = await authenticate(req);
    if (!actor) return reply.code(401).send({ error: "unauthenticated" });
    if (!canManageCatalog(actor))
      return reply.code(403).send({ error: "forbidden" });
    principals.set(req, actor);
  });
  async function write(
    req: FastifyRequest,
    event: string,
    run: (db: PoolConnection, uuid: string) => Promise<void>,
  ) {
    const principal = principals.get(req);
    if (!principal) throw new CatalogError(403, "forbidden");
    const uuid = randomUUID();
    await transaction(pool, async (db) => {
      // Check current admin role once more inside the transaction before persisting.
      const active = (
        await rows<{ is_admin: number }>(
          db,
          "SELECT is_admin FROM users WHERE id=? FOR UPDATE",
          [principal.id],
        )
      )[0];
      if (!active?.is_admin) throw new CatalogError(403, "forbidden");
      await run(db, uuid);
      await db.execute(
        "INSERT INTO audit_log (actor_id,event,subject_id) VALUES (?,?,?)",
        [principal.id, event, uuid],
      );
    });
    return { id: uuid };
  }
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof CatalogError || err instanceof ProvisionError)
      return reply.code(err.status).send({ error: err.code });
    if (err instanceof EggFormatError)
      return reply.code(422).send({ error: "invalid_egg", field: err.field });
    if (err instanceof WingsUnavailable)
      return reply
        .code(502)
        .send({ error: "wings_unavailable", reason: err.reason });
    if (domainErrors.has((err as { code?: string }).code ?? ""))
      return reply.code(409).send({ error: "catalog_conflict" });
    // Delegate framework validation and unexpected errors to application's sanitized handler.
    throw err;
  });
  app.get("/nodes", async () =>
    rows(pool, "SELECT id,name,origin FROM nodes ORDER BY name,id LIMIT 100"),
  );
  app.get("/nests", async () =>
    rows(pool, "SELECT id,name FROM nests ORDER BY name,id LIMIT 100"),
  );
  app.get("/eggs", async () =>
    rows(
      pool,
      "SELECT id,nest_id AS nestId,name,version FROM eggs ORDER BY name,id LIMIT 100",
    ),
  );
  app.get("/allocations", async () =>
    rows(
      pool,
      "SELECT id,node_id AS nodeId,ip,port FROM allocations ORDER BY node_id,ip,port LIMIT 100",
    ),
  );
  app.get("/servers", async () =>
    rows(
      pool,
      "SELECT s.id,s.name,s.node_id AS nodeId,s.owner_id AS ownerId,s.egg_id AS eggId,s.allocation_id AS allocationId,COALESCE(p.phase,s.status) AS status FROM servers s LEFT JOIN wings_provisions p ON p.server_id=s.id ORDER BY s.name,s.id LIMIT 100",
    ),
  );
  app.post<{
    Body: { name: string; origin: string; tokenId: string; token: string };
  }>(
    "/nodes",
    {
      schema: put({
        name: text(100),
        origin: text(80),
        tokenId: text(64),
        token: text(128),
      }),
    },
    async (req, reply) => {
      if (!crypt) throw new CatalogError(503, "node_key_unavailable");
      let node: ReturnType<typeof validateNode>;
      try {
        node = validateNode(req.body);
      } catch {
        throw new CatalogError(422, "invalid_test_node");
      }
      if (!allowedNodeOrigins.includes(node.origin))
        throw new CatalogError(422, "test_node_not_allowlisted");
      const result = await write(
        req,
        "catalog.node_created",
        async (db, uuid) => {
          await db.execute(
            "INSERT INTO nodes (id,name,origin,token_id,token_cipher) VALUES (?,?,?,?,?)",
            [
              uuid,
              req.body.name,
              node.origin,
              node.tokenId,
              crypt.seal(Buffer.from(node.token), uuid),
            ],
          );
        },
      );
      return reply.code(201).send(result);
    },
  );
  app.get<{ Params: { id: string } }>(
    "/nodes/:id/health",
    {
      schema: byId,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req) => {
      if (!crypt) throw new CatalogError(503, "node_key_unavailable");
      const node = (
        await rows<{ origin: string; token_id: string; token_cipher: Buffer }>(
          pool,
          "SELECT origin,token_id,token_cipher FROM nodes WHERE id=?",
          [req.params.id],
        )
      )[0];
      if (!node) throw new CatalogError(404, "node_not_found");
      if (!allowedNodeOrigins.includes(node.origin))
        throw new CatalogError(422, "test_node_not_allowlisted");
      return new WingsClient({
        origin: node.origin,
        tokenId: node.token_id,
        token: crypt.open(node.token_cipher, req.params.id).toString(),
      }).health();
    },
  );
  app.post<{ Body: { name: string } }>(
    "/nests",
    { schema: put({ name: text(100) }) },
    async (req, reply) =>
      reply.code(201).send(
        await write(req, "catalog.nest_created", async (db, uuid) => {
          await db.execute("INSERT INTO nests (id,name) VALUES (?,?)", [
            uuid,
            req.body.name,
          ]);
        }),
      ),
  );
  app.post<{ Body: { nestId: string; document: string } }>(
    "/eggs",
    {
      bodyLimit: 2100000,
      schema: put({ nestId: id, document: text(1048576) }),
    },
    async (req, reply) => {
      const egg = parseEgg(req.body.document);
      if ([...egg.name].length > 120) throw new EggFormatError("name");
      return reply.code(201).send(
        await write(req, "catalog.egg_imported", async (db, uuid) => {
          await db.execute(
            "INSERT INTO eggs (id,nest_id,name,version,document) VALUES (?,?,?,?,?)",
            [
              uuid,
              req.body.nestId,
              egg.name,
              egg.version,
              Buffer.from(egg.source),
            ],
          );
        }),
      );
    },
  );
  app.get<{ Params: { id: string } }>(
    "/eggs/:id/document",
    { schema: byId },
    async (req, reply) => {
      const egg = (
        await rows<{ document: Buffer }>(
          pool,
          "SELECT document FROM eggs WHERE id=?",
          [req.params.id],
        )
      )[0];
      if (!egg) throw new CatalogError(404, "egg_not_found");
      return reply
        .header("content-disposition", 'attachment; filename="egg.json"')
        .type("application/json; charset=utf-8")
        .send(exportEgg(parseEgg(egg.document.toString("utf8"))));
    },
  );
  app.post<{ Body: { nodeId: string; ip: string; port: number } }>(
    "/allocations",
    {
      schema: put({
        nodeId: id,
        ip: text(45),
        port: { type: "integer", minimum: 1, maximum: 65535 },
      }),
    },
    async (req, reply) => {
      // This initial slice provisions loopback resources only.
      if (isIP(req.body.ip) !== 4 || req.body.ip !== "127.0.0.1")
        throw new CatalogError(422, "test_allocation_required");
      return reply.code(201).send(
        await write(req, "catalog.allocation_created", async (db, uuid) => {
          await db.execute(
            "INSERT INTO allocations (id,node_id,ip,port) VALUES (?,?,?,?)",
            [uuid, req.body.nodeId, req.body.ip, req.body.port],
          );
        }),
      );
    },
  );
  app.post<{
    Body: {
      name: string;
      nodeId: string;
      ownerId: string;
      eggId: string;
      allocationId: string;
    };
  }>(
    "/servers",
    {
      schema: put({
        name: text(100),
        nodeId: id,
        ownerId: id,
        eggId: id,
        allocationId: id,
      }),
    },
    async (req, reply) => {
      const { name, nodeId, ownerId, eggId, allocationId } = req.body;
      const result = await write(
        req,
        "catalog.server_draft_created",
        async (db, uuid) => {
          await db.execute(
            "INSERT INTO servers (id,name,node_id,owner_id,egg_id,allocation_id) VALUES (?,?,?,?,?,?)",
            [uuid, name, nodeId, ownerId, eggId, allocationId],
          );
        },
      );
      return reply.code(201).send({ ...result, status: "draft" });
    },
  );
  if (provisioner) {
    const confirmation = {
      ...byId,
      body: schema({ confirm: { type: "boolean", const: true } }),
    };
    const limit = { rateLimit: { max: 10, timeWindow: "1 minute" } };
    const admin = (req: FastifyRequest) => {
      const actor = principals.get(req);
      if (!actor) throw new CatalogError(403, "forbidden");
      return actor;
    };
    app.get<{ Params: { id: string } }>(
      "/servers/:id/stats",
      {
        schema: byId,
        config: { rateLimit: { max: 15, timeWindow: "1 minute" } },
      },
      (req) => provisioner.stats(req.params.id, admin(req)),
    );
    app.get<{ Params: { id: string } }>(
      "/servers/:id/console",
      {
        schema: byId,
        config: { rateLimit: { max: 15, timeWindow: "1 minute" } },
      },
      (req) => provisioner.console(req.params.id, admin(req)),
    );
    app.get<{ Params: { id: string } }>(
      "/servers/:id/runtime",
      {
        schema: byId,
        config: { rateLimit: { max: 90, timeWindow: "1 minute" } },
      },
      (req) => provisioner.runtime(req.params.id, admin(req)),
    );
    app.post<{ Params: { id: string }; Body: { action: "start" | "stop" } }>(
      "/servers/:id/power",
      {
        config: limit,
        schema: {
          ...byId,
          body: schema({
            confirm: { type: "boolean", const: true },
            action: { type: "string", enum: ["start", "stop"] },
          }),
        },
      },
      async (req, reply) =>
        reply
          .code(202)
          .send(
            await provisioner.power(req.params.id, req.body.action, admin(req)),
          ),
    );
    app.post<{ Params: { id: string } }>(
      "/servers/:id/reconcile",
      { schema: confirmation, config: limit },
      (req) => provisioner.reconcile(req.params.id, admin(req)),
    );

    for (const action of ["reinstall", "delete"] as const) {
      app.post<{ Params: { id: string } }>(
        `/servers/:id/${action}`,
        { schema: confirmation, config: limit },
        async (req, reply) =>
          reply
            .code(202)
            .send(
              await provisioner.destructive(req.params.id, action, admin(req)),
            ),
      );
    }
    app.post<{ Params: { id: string }; Body: { confirm: boolean } }>(
      "/servers/:id/provision",
      {
        schema: {
          ...byId,
          body: schema({ confirm: { type: "boolean", const: true } }),
        },
        config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      },
      async (req, reply) => {
        const principal = principals.get(req);
        if (!principal) throw new CatalogError(403, "forbidden");
        const phase = await provisioner.provision(req.params.id, principal);
        return reply.code(202).send({ phase });
      },
    );
    app.get<{ Params: { id: string } }>(
      "/servers/:id/provision",
      { schema: byId },
      async (req) => {
        const res = (
          await rows<{ phase: string }>(
            pool,
            "SELECT COALESCE(p.phase,'draft') AS phase FROM servers s LEFT JOIN wings_provisions p ON s.id=p.server_id WHERE s.id=?",
            [req.params.id],
          )
        )[0];
        if (!res) throw new CatalogError(404, "server_not_found");
        return res;
      },
    );
  }
}
