import { randomBytes } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { FastifyInstance } from "fastify";
import type WebSocket from "ws";
import type { Actor } from "./policy";

export type StreamBinding = {
  allowed(id: string, actor: Actor): Promise<boolean>;
  connect(id: string, actor: Actor): WebSocket;
};
const lifetime = 15_000;
const send = (socket: WebSocket, event: string, args: string[] = []) =>
  socket.send(JSON.stringify({ event, args }));

export function registerClientStream(
  app: FastifyInstance,
  origin: string,
  binding: StreamBinding,
) {
  const tickets = new Map<
    string,
    { id: string; actor: Actor; expires: number }
  >();
  let active = 0;
  const path = "/api/client/streams";
  app.get<{ Params: { id: string } }>(
    `${path}/:id`,
    {
      websocket: true,
      config: { rateLimit: { max: 15, timeWindow: "1 minute" } },
      preValidation: async (req, reply) => {
        if (req.headers.origin !== undefined && req.headers.origin !== origin)
          return reply.code(403).send();
      },
    },
    (peer, req) => {
      if (active >= 8) {
        peer.close(1013);
        return;
      }
      active++;
      let upstream: WebSocket | undefined;
      let polling: ReturnType<typeof setInterval> | undefined;
      let authenticated = false;
      let connecting = false;
      let closed = false;
      let checking = false;
      let frameCount = 0;
      let timer = setTimeout(() => close(1008), 3500);
      function cleanup() {
        if (closed) return;
        closed = true;
        active--;
        clearTimeout(timer);
        clearInterval(polling);
        upstream?.terminate();
      }
      function close(code: number) {
        cleanup();
        peer.close(code);
      }
      peer.on("close", cleanup);
      peer.on("error", () => close(1011));
      peer.on("message", async (raw, binary) => {
        try {
          if (closed) return;
          if (binary || ++frameCount > 16) return close(1008);
          const frame = JSON.parse(raw.toString());
          if (
            authenticated &&
            frame?.event === "send logs" &&
            Array.isArray(frame.args) &&
            frame.args.length === 0
          )
            return;
          if (
            connecting ||
            frame?.event !== "auth" ||
            !Array.isArray(frame.args) ||
            frame.args.length !== 1 ||
            typeof frame.args[0] !== "string"
          )
            return close(1008);
          connecting = true;
          const token = frame.args[0];
          const ticket = tickets.get(token);
          if (
            !ticket ||
            ticket.id !== req.params.id ||
            ticket.expires <= Date.now()
          )
            return close(1008);
          tickets.delete(token);
          if (!(await binding.allowed(ticket.id, ticket.actor)))
            return close(1008);
          if (closed || ticket.expires <= Date.now()) return close(1008);
          clearTimeout(timer);
          timer = setTimeout(() => close(1008), ticket.expires - Date.now());
          polling = setInterval(async () => {
            if (closed || checking) return;
            checking = true;
            try {
              if (!(await binding.allowed(ticket.id, ticket.actor)))
                close(1008);
            } catch {
              close(1011);
            } finally {
              checking = false;
            }
          }, 1000);
          upstream = binding.connect(ticket.id, ticket.actor);
          upstream.on("error", () => close(1011));
          upstream.on("close", () => {
            if (!closed) close(1011);
          });
          upstream.on("message", (data, isBinary) => {
            try {
              if (closed) return;
              if (isBinary) return close(1011);
              const message = JSON.parse(data.toString());
              if (message.event === "auth success" && !authenticated) {
                authenticated = true;
                send(peer, "auth success");
              } else if (
                [
                  "jwt error",
                  "token expired",
                  "daemon error",
                  "throttled",
                ].includes(message.event)
              )
                close(1011);
              else if (
                authenticated &&
                !checking &&
                message.event === "console output" &&
                typeof message.args?.[0] === "string"
              ) {
                const line = stripVTControlCharacters(message.args[0]).trim();
                if (/^RELAY_COMMAND_ACK [a-f0-9]{24}$/.test(line)) {
                  if (peer.bufferedAmount > 8192) return close(1013);
                  send(peer, "console output", [line]);
                }
              }
            } catch {
              close(1011);
            }
          });
        } catch {
          close(1008);
        }
      });
    },
  );
  return async (id: string, actor: Actor) => {
    if (!(await binding.allowed(id, actor))) return null;
    const now = Date.now();
    for (const [token, ticket] of tickets)
      if (ticket.expires <= now) tickets.delete(token);
    if (tickets.size >= 128) return null;
    const token = randomBytes(32).toString("base64url");
    tickets.set(token, { id, actor, expires: now + lifetime });
    const socket = new URL(`${path}/${id}`, origin);
    socket.protocol = "wss:";
    return { data: { token, socket: socket.href } };
  };
}
