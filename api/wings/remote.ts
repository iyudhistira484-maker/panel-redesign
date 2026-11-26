import type { stagingSftpAuth } from "./sftp-auth";
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
export type FixtureBackupSignal = {
  successful: boolean;
  checksum?: string;
  checksum_type?: string;
  size?: number;
  parts?: { etag: string; part_number: number }[];
};
export type FixtureBackupCallback = (
  id: string,
  phase: "create" | "restore",
  event: FixtureBackupSignal,
) => boolean | Promise<boolean>;
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
  onTransfer?: (id: string, successful: boolean) => boolean | Promise<boolean>,
  authenticateSftp?: ReturnType<typeof stagingSftpAuth>,
  fixtureBackupCallback?: FixtureBackupCallback,
  fixtureS3Urls?: (
    id: string,
    size: number,
  ) => Promise<{ part_size: number; parts: string[] } | null>,
) {
  if (fixture && !UUID_V4.test(fixture.uuid))
    throw new Error("Invalid test fixture UUID");
  const node = validateNode(rawNode);
  const expected = digest(`Bearer ${node.tokenId}.${node.token}`);
  app.addHook("onRequest", async (req, reply) => {
    if (!timingSafeEqual(expected, digest(req.headers.authorization ?? "")))
      return reply.code(401).send({ error: "node_unauthorized" });
  });
  if (authenticateSftp)
    app.post<{ Body: { type: string; username: string; password: string } }>(
      "/sftp/auth",
      {
        bodyLimit: 8192,
        config: { rateLimit: { max: 12, timeWindow: "1 minute" } },
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            required: ["type", "username", "password"],
            properties: {
              type: { type: "string", enum: ["password", "public_key"] },
              username: { type: "string", maxLength: 228 },
              password: { type: "string", minLength: 1, maxLength: 4096 },
              ip: { type: "string", maxLength: 64 },
              session_id: { type: "string", maxLength: 1024 },
              client_version: { type: "string", maxLength: 1024 },
            },
          },
        },
      },
      async (req, reply) => {
        reply.header("cache-control", "no-store");
        const approved = await authenticateSftp(req.body);
        return approved ?? reply.code(403).send({ error: "sftp_denied" });
      },
    );
  if (authenticateSftp)
    app.post<{ Body: { type: "lease"; username?: string; password: string } }>(
      "/sftp/session",
      {
        bodyLimit: 4096,
        config: { rateLimit: { max: 300, timeWindow: "1 minute" } },
        schema: {
          body: {
            type: "object",
            required: ["type", "password"],
            properties: {
              type: { const: "lease" },
              password: { type: "string", pattern: "^[A-Za-z0-9_-]{40,3000}$" },
            },
          },
        },
      },
      async (req, reply) => {
        reply.header("cache-control", "no-store");
        const authorized = await authenticateSftp({
          type: "lease",
          username: "",
          password: req.body.password,
        });
        return authorized ?? reply.code(403).send({ error: "sftp_denied" });
      },
    );
  if (fixtureS3Urls)
    app.get<{ Params: { backup: string }; Querystring: { size?: string } }>(
      "/backups/:backup",
      async (req, reply) => {
        const size = req.query.size;
        if (
          !UUID_V4.test(req.params.backup) ||
          typeof size !== "string" ||
          !/^\d{1,7}$/.test(size)
        )
          return reply.code(404).send({ error: "backup_not_found" });
        const urls = await fixtureS3Urls(req.params.backup, Number(size));
        if (!urls) return reply.code(404).send({ error: "backup_not_found" });
        return reply.header("cache-control", "no-store").send(urls);
      },
    );
  if (fixtureBackupCallback)
    for (const phase of ["create", "restore"] as const) {
      app.post<{ Params: { backup: string }; Body: FixtureBackupSignal }>(
        `/backups/:backup${phase === "restore" ? "/restore" : ""}`,
        {
          bodyLimit: 4096,
          schema: {
            body: {
              type: "object",
              required: ["successful"],
              properties: {
                successful: { type: "boolean" },
                checksum: { type: "string", maxLength: 128 },
                checksum_type: { type: "string", maxLength: 16 },
                size: { type: "integer", minimum: 0 },
                parts: {
                  type: "array",
                  maxItems: 1,
                  items: {
                    type: "object",
                    required: ["etag", "part_number"],
                    properties: {
                      etag: { type: "string", maxLength: 64 },
                      part_number: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
        async (req, reply) => {
          if (
            !UUID_V4.test(req.params.backup) ||
            !(await fixtureBackupCallback(req.params.backup, phase, req.body))
          )
            return reply.code(404).send({ error: "backup_not_found" });
          return reply.code(204).send();
        },
      );
    }
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
  if (onTransfer)
    app.post<{ Params: { uuid: string; result: string } }>(
      "/servers/:uuid/transfer/:result",
      async (req, reply) => {
        const { uuid, result } = req.params;
        if (
          !UUID_V4.test(uuid) ||
          (result !== "success" && result !== "failure") ||
          !(await onTransfer(uuid, result === "success"))
        )
          return reply.code(404).send({ error: "transfer_not_found" });
        return reply.code(204).send();
      },
    );
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
