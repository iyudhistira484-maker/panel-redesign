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
  installed: (result: {
    successful: boolean;
    reinstall: boolean;
  }) => void | Promise<void>;
};
export type WorkloadProvider = {
  lookup: (id: string) => Promise<ContractWorkload | undefined>;
  list: (
    page: number,
    perPage: number,
  ) => Promise<{
    data: {
      uuid: string;
      settings: Record<string, unknown>;
      process_configuration: Record<string, unknown>;
    }[];
    total: number;
  }>;
};
/** Optional fixture is only supplied by the disposable Docker harness, never by the app. */
export async function registerRemote(
  app: FastifyInstance,
  rawNode: WingsNode,
  fixture?: ContractWorkload,
  provider?: WorkloadProvider,
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
    async (req) => {
      const page = Math.max(1, Number(req.query.page ?? 1));
      const perPage = Math.min(100, Number(req.query.per_page ?? 50));
      const { data, total } = provider
        ? await provider.list(page, perPage)
        : { data: [], total: 0 };
      return {
        data,
        meta: {
          current_page: page,
          from: data.length ? (page - 1) * perPage + 1 : 0,
          last_page: Math.max(1, Math.ceil(total / perPage)),
          per_page: perPage,
          to: data.length ? (page - 1) * perPage + data.length : 0,
          total,
        },
      };
    },
  );
  app.post("/servers/reset", async (_req, reply) => reply.code(204).send());
  if (!fixture && !provider) return;
  const lookup = async (id: string) =>
    UUID_V4.test(id)
      ? provider
        ? provider.lookup(id)
        : fixture?.uuid === id
          ? fixture
          : undefined
      : undefined;
  app.get<{ Params: { uuid: string } }>(
    "/servers/:uuid",
    async (req, reply) => {
      const workload = await lookup(req.params.uuid);
      return (
        workload?.configuration ??
        reply.code(404).send({ error: "server_not_found" })
      );
    },
  );
  app.get<{ Params: { uuid: string } }>(
    "/servers/:uuid/install",
    async (req, reply) => {
      const workload = await lookup(req.params.uuid);
      return (
        workload?.install ?? reply.code(404).send({ error: "server_not_found" })
      );
    },
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
      const workload = await lookup(req.params.uuid);
      if (!workload) return reply.code(404).send({ error: "server_not_found" });
      await workload.installed(req.body);
      return reply.code(204).send();
    },
  );
}
