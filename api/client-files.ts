import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ProvisionError } from "./wings/provision";
import type { Actor } from "./policy";
import {
  type FixtureSubfolder,
  fixturePathSegment,
  WingsUnavailable,
} from "./wings/client";

type Entry = {
  name: string;
  directory: boolean;
  size: number;
  mode: unknown;
  mode_bits: unknown;
  mimetype: unknown;
  created_at: unknown;
  modified_at: unknown;
};
export type FileBinding = {
  rename(
    id: string,
    actor: Actor,
    source: string,
    target: string,
    destination?: FixtureSubfolder,
    origin?: FixtureSubfolder,
  ): Promise<unknown>;
  chmod(
    id: string,
    actor: Actor,
    name: string,
    mode: "600" | "644",
  ): Promise<unknown>;
  deleteUpload(id: string, actor: Actor, name: string): Promise<void>;
  uploadAllowed(id: string, actor: Actor): Promise<boolean>;
  upload(
    id: string,
    actor: Actor,
    name: string,
    bytes: Buffer,
    expires: number,
  ): Promise<void>;
  contents(id: string): Promise<Buffer>;
  edit(
    id: string,
    actor: Actor,
    version: string,
    text: string,
  ): Promise<unknown>;
  allowed(id: string, actor: Actor, download: boolean): Promise<boolean>;
  list(id: string, parts: string[]): Promise<Entry[]>;
  read(
    id: string,
    parts: string[],
    name: string,
    verifyOnly: boolean,
  ): Promise<Buffer>;
};
function pathParts(value: unknown, root: boolean) {
  if (value === "/" && root) return [];
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  const parts = value.slice(1).split("/");
  return parts.length <= (root ? 4 : 5) && parts.every(fixturePathSegment)
    ? parts
    : null;
}
function failure(reply: FastifyReply, status: number) {
  const detail =
    status === 400
      ? "Invalid fixture path."
      : status === 401
        ? "Unauthenticated."
        : status === 403
          ? "File access denied."
          : status === 404
            ? "File or server not found."
            : "Fixture files unavailable.";
  const code =
    status === 400
      ? "BadRequestHttpException"
      : status === 401
        ? "AuthenticationException"
        : status === 403
          ? "AuthorizationException"
          : status === 404
            ? "NotFoundHttpException"
            : "DaemonConnectionException";
  return reply
    .code(status)
    .send({ errors: [{ code, status: String(status), detail }] });
}
const fileError = (err: unknown, reply: FastifyReply) => {
  if (!(err instanceof WingsUnavailable)) throw err;
  return failure(reply, err.reason === "not_found" ? 404 : 502);
};
const atom = (value: unknown) => {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time)
    ? new Date(time).toISOString().replace(/\.\d{3}Z$/, "+00:00")
    : null;
};
export function registerClientFiles(
  app: FastifyInstance,
  origin: string,
  authenticate: (auth: string) => Promise<Actor | null>,
  resolve: (id: string, user: string) => Promise<{ id: string } | null>,
  binding?: FileBinding,
) {
  const tickets = new Map<
    string,
    { id: string; parts: string[]; name: string; actor: Actor; expires: number }
  >();
  const ticketPath = "/api/client/file-downloads";
  for (const action of ["list", "download"] as const) {
    const download = action === "download";
    app.get<{
      Params: { identifier: string };
      Querystring: Record<string, unknown>;
    }>(
      `/api/client/servers/:identifier/files/${action}`,
      { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
      async (req, reply) => {
        const actor = await authenticate(req.headers.authorization ?? "");
        if (!actor) return failure(reply, 401);
        const server = await resolve(req.params.identifier, actor.id);
        if (!server) return failure(reply, 404);
        if (!binding) return failure(reply, 503);
        if (!(await binding.allowed(server.id, actor, download)))
          return failure(reply, 403);
        const field = download ? "file" : "directory";
        const parts = pathParts(
          req.query[field] ?? (download ? undefined : "/"),
          !download,
        );
        if (!parts || Object.keys(req.query).some((key) => key !== field))
          return failure(reply, 400);
        try {
          if (!download) {
            const entries = await binding.list(server.id, parts);
            return {
              object: "list",
              data: entries.map((entry) => ({
                object: "file_object",
                attributes: {
                  name: entry.name,
                  size: entry.size,
                  mode: entry.mode,
                  mode_bits: entry.mode_bits,
                  is_file: !entry.directory,
                  is_symlink: false,
                  mimetype: entry.mimetype,
                  created_at: atom(entry.created_at),
                  modified_at: atom(entry.modified_at),
                },
              })),
            };
          }
          const name = parts.pop();
          if (!name) return failure(reply, 400);
          await binding.read(server.id, parts, name, true);
          const now = Date.now();
          for (const [token, ticket] of tickets)
            if (ticket.expires <= now) tickets.delete(token);
          if (tickets.size >= 128) return failure(reply, 503);
          const token = randomBytes(32).toString("base64url");
          tickets.set(token, {
            id: server.id,
            parts,
            name,
            actor,
            expires: now + 15_000,
          });
          const url = new URL(`${ticketPath}/${server.id}/${name}`, origin);
          url.searchParams.set("token", token);
          return { object: "signed_url", attributes: { url: url.href } };
        } catch (err) {
          return fileError(err, reply);
        }
      },
    );
  }
  const fixedFile = "/fixture-docs/example.txt";
  const textError = (error: unknown, reply: FastifyReply) => {
    if (!(error instanceof ProvisionError)) return fileError(error, reply);
    if (error.code === "file_version_conflict")
      return reply.code(412).send({
        errors: [
          {
            code: "PreconditionFailedHttpException",
            status: "412",
            detail: "File changed; reload before writing.",
          },
        ],
      });
    return failure(reply, error.status);
  };
  app.get<{ Params: { identifier: string }; Querystring: { file?: string } }>(
    "/api/client/servers/:identifier/files/contents",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const actor = await authenticate(req.headers.authorization ?? "");
      if (!actor) return failure(reply, 401);
      const server = await resolve(req.params.identifier, actor.id);
      if (!server) return failure(reply, 404);
      if (!binding) return failure(reply, 503);
      if (!(await binding.allowed(server.id, actor, true)))
        return failure(reply, 403);
      if (req.query.file !== fixedFile || Object.keys(req.query).length !== 1)
        return failure(reply, 400);
      try {
        const bytes = await binding.contents(server.id);
        return reply
          .type("text/plain; charset=utf-8")
          .header(
            "etag",
            `"${createHash("sha256").update(bytes).digest("hex")}"`,
          )
          .header("x-content-type-options", "nosniff")
          .send(bytes);
      } catch (error) {
        return textError(error, reply);
      }
    },
  );
  app.register(async (scope) => {
    scope.removeContentTypeParser("text/plain");
    scope.addContentTypeParser(
      "text/plain",
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body),
    );
    scope.post<{
      Params: { identifier: string };
      Querystring: { file?: string };
      Body: Buffer;
    }>(
      "/api/client/servers/:identifier/files/write",
      {
        bodyLimit: 16384,
        config: { rateLimit: { max: 12, timeWindow: "1 minute" } },
      },
      async (req, reply) => {
        const actor = await authenticate(req.headers.authorization ?? "");
        if (!actor) return failure(reply, 401);
        const server = await resolve(req.params.identifier, actor.id);
        if (!server) return failure(reply, 404);
        if (!binding) return failure(reply, 503);
        if (
          req.query.file !== fixedFile ||
          Object.keys(req.query).length !== 1 ||
          !Buffer.isBuffer(req.body)
        )
          return failure(reply, 400);
        const match = /^"([a-f0-9]{64})"$/.exec(req.headers["if-match"] ?? "");
        if (!match)
          return reply.code(428).send({
            errors: [
              {
                code: "PreconditionRequiredHttpException",
                status: "428",
                detail: "Send the current strong ETag in If-Match.",
              },
            ],
          });
        let text: string;
        try {
          text = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(req.body);
        } catch {
          return failure(reply, 400);
        }
        try {
          await binding.edit(server.id, actor, match[1], text);
          return reply.code(204).send();
        } catch (error) {
          return textError(error, reply);
        }
      },
    );
  });
  app.post<{
    Params: { identifier: string };
    Body: { root?: unknown; files?: unknown };
  }>(
    "/api/client/servers/:identifier/files/delete",
    {
      bodyLimit: 1024,
      config: { rateLimit: { max: 12, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const actor = await authenticate(req.headers.authorization ?? "");
      if (!actor) return failure(reply, 401);
      const server = await resolve(req.params.identifier, actor.id);
      if (!server) return failure(reply, 404);
      if (!binding) return failure(reply, 503);
      const { root, files } = req.body ?? {};
      if (
        root !== "/fixture-docs" ||
        Object.keys(req.body ?? {}).length !== 2 ||
        !Array.isArray(files) ||
        files.length !== 1 ||
        typeof files[0] !== "string" ||
        !fixturePathSegment(files[0]) ||
        !files[0].endsWith(".txt")
      )
        return failure(reply, 400);
      try {
        await binding.deleteUpload(server.id, actor, files[0]);
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof ProvisionError && error.status === 409)
          return reply.code(409).send({
            errors: [
              {
                code: "ConflictHttpException",
                status: "409",
                detail:
                  "The uploaded file changed or the server is not ready for deletion.",
              },
            ],
          });
        return textError(error, reply);
      }
    },
  );
  app.post<{
    Params: { identifier: string };
    Body: { root?: unknown; files?: unknown };
  }>(
    "/api/client/servers/:identifier/files/chmod",
    {
      bodyLimit: 1024,
      config: { rateLimit: { max: 12, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const actor = await authenticate(req.headers.authorization ?? "");
      if (!actor) return failure(reply, 401);
      const server = await resolve(req.params.identifier, actor.id);
      if (!server) return failure(reply, 404);
      if (!binding) return failure(reply, 503);
      const { root, files } = req.body ?? {};
      if (
        root !== "/fixture-docs" ||
        Object.keys(req.body ?? {}).length !== 2 ||
        !Array.isArray(files) ||
        files.length !== 1
      )
        return failure(reply, 400);
      const entry = files[0];
      if (
        !entry ||
        typeof entry !== "object" ||
        Object.keys(entry).length !== 2 ||
        typeof entry.file !== "string" ||
        !fixturePathSegment(entry.file) ||
        !entry.file.endsWith(".txt")
      )
        return failure(reply, 400);
      const mode = entry.mode;
      if (mode !== "600" && mode !== "644") return failure(reply, 400);
      try {
        await binding.chmod(server.id, actor, entry.file, mode);
        return reply.code(204).send();
      } catch (error) {
        return textError(error, reply);
      }
    },
  );
  const renamePath = (
    value: unknown,
  ): { name: string; folder?: FixtureSubfolder } | null => {
    if (typeof value !== "string") return null;
    const parts = value.split("/");
    const name = parts.pop();
    const folder = parts.pop();
    if (
      parts.length ||
      !name ||
      !fixturePathSegment(name) ||
      !name.endsWith(".txt") ||
      (folder !== undefined && folder !== "moved" && folder !== "review")
    )
      return null;
    return { name, folder };
  };
  app.put<{
    Params: { identifier: string };
    Body: { root?: unknown; files?: unknown };
  }>(
    "/api/client/servers/:identifier/files/rename",
    {
      bodyLimit: 1024,
      config: { rateLimit: { max: 12, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const actor = await authenticate(req.headers.authorization ?? "");
      if (!actor) return failure(reply, 401);
      const server = await resolve(req.params.identifier, actor.id);
      if (!server) return failure(reply, 404);
      if (!binding) return failure(reply, 503);
      const { root, files } = req.body ?? {};
      if (
        root !== "/fixture-docs" ||
        Object.keys(req.body ?? {}).length !== 2 ||
        !Array.isArray(files) ||
        files.length !== 1
      )
        return failure(reply, 400);
      const entry = files[0];
      if (
        !entry ||
        typeof entry !== "object" ||
        Object.keys(entry).length !== 2
      )
        return failure(reply, 400);
      const from = renamePath(entry.from),
        to = renamePath(entry.to);
      if (!from || !to) return failure(reply, 400);
      try {
        await binding.rename(
          server.id,
          actor,
          from.name,
          to.name,
          to.folder,
          from.folder,
        );
        return reply.code(204).send();
      } catch (error) {
        return textError(error, reply);
      }
    },
  );
  const uploadTickets = new Map<
    string,
    { id: string; actor: Actor; expires: number }
  >();
  const uploadPath = "/api/client/file-uploads";
  app.get<{ Params: { identifier: string } }>(
    "/api/client/servers/:identifier/files/upload",
    { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const actor = await authenticate(req.headers.authorization ?? "");
      if (!actor) return failure(reply, 401);
      const server = await resolve(req.params.identifier, actor.id);
      if (!server) return failure(reply, 404);
      if (!binding) return failure(reply, 503);
      if (!(await binding.uploadAllowed(server.id, actor)))
        return failure(reply, 403);
      const now = Date.now();
      for (const [token, ticket] of uploadTickets)
        if (ticket.expires <= now) uploadTickets.delete(token);
      if (uploadTickets.size >= 128) return failure(reply, 503);
      const token = randomBytes(32).toString("base64url");
      uploadTickets.set(token, { id: server.id, actor, expires: now + 15_000 });
      const url = new URL(`${uploadPath}/${server.id}`, origin);
      url.searchParams.set("token", token);
      return { object: "signed_url", attributes: { url: url.href } };
    },
  );
  if (binding)
    app.register(async (scope) => {
      scope.addContentTypeParser(
        "multipart/form-data",
        { parseAs: "buffer" },
        (_req, body, done) => done(null, body),
      );
      scope.post<{
        Params: { id: string };
        Querystring: { token?: string; directory?: string };
        Body: Buffer;
      }>(
        `${uploadPath}/:id`,
        {
          bodyLimit: 20480,
          config: { rateLimit: { max: 15, timeWindow: "1 minute" } },
        },
        async (req, reply) => {
          reply.header("referrer-policy", "no-referrer");
          const { token, directory } = req.query;
          const ticket =
            typeof token === "string" ? uploadTickets.get(token) : undefined;
          if (
            !ticket ||
            !token ||
            ticket.id !== req.params.id ||
            ticket.expires <= Date.now()
          )
            return failure(reply, 404);
          if (
            directory !== "/fixture-docs" ||
            Object.keys(req.query).length !== 2 ||
            !Buffer.isBuffer(req.body)
          )
            return failure(reply, 400);
          uploadTickets.delete(token);
          let file: File;
          try {
            const body = await new Response(new Uint8Array(req.body), {
              headers: { "content-type": req.headers["content-type"] ?? "" },
            }).formData();
            const parts = [...body.entries()];
            if (
              parts.length !== 1 ||
              parts[0][0] !== "files" ||
              typeof parts[0][1] === "string"
            )
              return failure(reply, 400);
            file = parts[0][1];
          } catch {
            return failure(reply, 400);
          }
          if (
            !fixturePathSegment(file.name) ||
            !file.name.endsWith(".txt") ||
            file.size > 16384
          )
            return failure(reply, 400);
          try {
            await binding.upload(
              ticket.id,
              ticket.actor,
              file.name,
              Buffer.from(await file.arrayBuffer()),
              ticket.expires,
            );
            return reply.code(200).send();
          } catch (error) {
            if (
              error instanceof ProvisionError &&
              (error.code === "file_exists" ||
                error.code === "server_not_offline")
            )
              return reply.code(409).send({
                errors: [
                  {
                    code: "ConflictHttpException",
                    status: "409",
                    detail:
                      error.code === "file_exists"
                        ? "File already exists."
                        : "Server must be offline.",
                  },
                ],
              });
            return textError(error, reply);
          }
        },
      );
    });
  if (!binding) return;
  app.get<{
    Params: { id: string; name: string };
    Querystring: { token?: string };
  }>(
    `${ticketPath}/:id/:name`,
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      exposeHeadRoute: false,
    },
    async (req, reply) => {
      reply.header("referrer-policy", "no-referrer");
      const token = req.query.token;
      if (typeof token !== "string" || Object.keys(req.query).length !== 1)
        return failure(reply, 404);
      const ticket = tickets.get(token);
      if (
        !ticket ||
        ticket.expires <= Date.now() ||
        ticket.id !== req.params.id ||
        ticket.name !== req.params.name
      )
        return failure(reply, 404);
      tickets.delete(token);
      if (!(await binding.allowed(ticket.id, ticket.actor, true)))
        return failure(reply, 404);
      try {
        const bytes = await binding.read(
          ticket.id,
          ticket.parts,
          ticket.name,
          false,
        );
        if (
          ticket.expires <= Date.now() ||
          !(await binding.allowed(ticket.id, ticket.actor, true))
        )
          return failure(reply, 404);
        return reply
          .type("application/octet-stream")
          .header(
            "content-disposition",
            `attachment; filename="${ticket.name}"`,
          )
          .header("x-content-type-options", "nosniff")
          .send(bytes);
      } catch (err) {
        return fileError(err, reply);
      }
    },
  );
}
