import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Actor } from "./policy";
import { fixturePathSegment, WingsUnavailable } from "./wings/client";

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
