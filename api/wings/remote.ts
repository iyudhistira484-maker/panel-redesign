import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { UUID_V4, validateNode, type WingsNode } from "./client";

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}
export type ContractWorkload = {
  uuid: string;
  configuration: {
    settings: Record<string, unknown>;
    process_configuration: Record<string, unknown>;
  };
  install: { container_image: string; entrypoint: string; script: string };
  installed: (result: { successful: boolean; reinstall: boolean }) => void;
};
/** Optional fixture is only supplied by the disposable Docker harness, never by the app. */
export async function registerRemote(
  app: FastifyInstance,
  rawNode: WingsNode,
  fixture?: ContractWorkload,
) {
  if (fixture && !UUID_V4.test(fixture.uuid))
    throw new Error("Invalid test fixture UUID");
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
            page: { type: "string", pattern: "^(0|[1-9][0-9]{0,5})$" },
            per_page: { type: "string", pattern: "^[1-9][0-9]{0,2}$" },
          },
        },
      },
    },
    async (req) => ({
      data: [],
      meta: {
        current_page: Math.max(1, Number(req.query.page ?? 1)),
        from: 0,
        last_page: 1,
        per_page: Number(req.query.per_page ?? 50),
        to: 0,
        total: 0,
      },
    }),
  );
  app.post("/servers/reset", async (_req, reply) => reply.code(204).send());
  if (!fixture) return;
  // The daemon starts empty. Register the sole fixture for the explicit create request,
  // not for discovery: otherwise Wings would pre-register it at boot.
  app.get<{ Params: { uuid: string } }>("/servers/:uuid", async (req, reply) =>
    req.params.uuid === fixture.uuid
      ? fixture.configuration
      : reply.code(404).send({ error: "server_not_found" }),
  );
  app.get<{ Params: { uuid: string } }>(
    "/servers/:uuid/install",
    async (req, reply) =>
      req.params.uuid === fixture.uuid
        ? fixture.install
        : reply.code(404).send({ error: "server_not_found" }),
  );
  app.post<{
    Params: { uuid: string };
    Body: { successful: boolean; reinstall: boolean };
  }>(
    "/servers/:uuid/install",
    {
      schema: {
        body: {
          type: "object",
          required: ["successful", "reinstall"],
          additionalProperties: false,
          properties: {
            successful: { type: "boolean" },
            reinstall: { type: "boolean" },
          },
        },
      },
    },
    async (req, reply) => {
      if (req.params.uuid !== fixture.uuid)
        return reply.code(404).send({ error: "server_not_found" });
      fixture.installed(req.body);
      return reply.code(204).send();
    },
  );
}
