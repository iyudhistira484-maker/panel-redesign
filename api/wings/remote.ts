import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { validateNode, type WingsNode } from "./client";

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}
/** Only an empty, disposable node can participate in this stage of qualification. */
export async function registerRemote(app: FastifyInstance, rawNode: WingsNode) {
  const node = validateNode(rawNode);
  const expected = digest(`Bearer ${node.tokenId}.${node.token}`);
  app.addHook("onRequest", async (req, reply) => {
    if (!timingSafeEqual(expected, digest(req.headers.authorization ?? "")))
      return reply.code(401).send({ error: "node_unauthorized" });
  });
  app.get<{ Querystring: { page?: string; per_page?: string } }>(
    "/servers",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            page: { type: "string", pattern: "^[1-9][0-9]{0,5}$" },
            per_page: { type: "string", pattern: "^[1-9][0-9]{0,2}$" },
          },
        },
      },
    },
    async (req) => ({
      data: [],
      meta: {
        current_page: Number(req.query.page ?? 1),
        from: 0,
        last_page: 1,
        per_page: Number(req.query.per_page ?? 50),
        to: 0,
        total: 0,
      },
    }),
  );
  app.post("/servers/reset", async (_req, reply) => reply.code(204).send());
  // No workload is registered. All per-server and other callbacks deliberately remain unavailable.
}
