import { createHmac, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { UUID_V4, validateNode, type WingsNode } from "./client";

export type SocketStats = {
  memoryBytes: number;
  memoryLimitBytes: number;
  cpuAbsolute: number;
  diskBytes: number;
  uptimeMs: number;
  rxBytes: number;
  txBytes: number;
};
export class SocketError extends Error {
  constructor(
    readonly reason:
      | "timeout"
      | "transport"
      | "rejected"
      | "payload"
      | "capacity",
  ) {
    super(`Wings websocket: ${reason}`);
  }
}
const encoded = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
export function signReadCapability(
  node: WingsNode,
  issuer: string,
  server: string,
  user: string,
  now = Date.now(),
) {
  validateNode(node);
  if (!UUID_V4.test(server) || !UUID_V4.test(user))
    throw new Error("Invalid websocket subject");
  const t = Math.floor(now / 1000);
  const signed = `${encoded({ alg: "HS256", typ: "JWT" })}.${encoded({ iss: issuer, aud: [node.origin], jti: randomUUID(), iat: t, nbf: t - 1, exp: t + 30, scope: "websocket", server_uuid: server, user_uuid: user, permissions: ["websocket.connect"] })}`;
  return `${signed}.${createHmac("sha256", node.token).update(signed).digest("base64url")}`;
}
function decodeStats(input: string): SocketStats {
  const data = JSON.parse(input) as Record<string, unknown>;
  if (
    !data ||
    typeof data !== "object" ||
    !data.network ||
    typeof data.network !== "object"
  )
    throw new SocketError("payload");
  const network = data.network as Record<string, unknown>;
  const num = (value: unknown, integer = true) => {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      (integer && !Number.isSafeInteger(value))
    )
      throw new SocketError("payload");
    return value;
  };
  return {
    memoryBytes: num(data.memory_bytes),
    memoryLimitBytes: num(data.memory_limit_bytes),
    cpuAbsolute: num(data.cpu_absolute, false),
    diskBytes: num(data.disk_bytes),
    uptimeMs: num(data.uptime),
    rxBytes: num(network.rx_bytes),
    txBytes: num(network.tx_bytes),
  };
}
export class WingsSocket {
  readonly #node: WingsNode;
  readonly #origin: string;
  #active = 0;
  constructor(raw: WingsNode, origin: string) {
    this.#node = validateNode(raw);
    if (new URL(origin).origin !== origin)
      throw new Error("Invalid socket origin");
    this.#origin = origin;
  }
  async stats(server: string, user: string): Promise<SocketStats> {
    if (this.#active >= 4) throw new SocketError("capacity");
    const capability = signReadCapability(
      this.#node,
      this.#origin,
      server,
      user,
    );
    this.#active++;
    try {
      return await new Promise<SocketStats>((resolve, reject) => {
        const url = new URL(`/api/servers/${server}/ws`, this.#node.origin);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(url, {
          origin: this.#origin,
          handshakeTimeout: 3500,
          maxPayload: 32768,
          followRedirects: false,
          perMessageDeflate: false,
        });
        let authenticated = false,
          done = false,
          frames = 0;
        const timer = setTimeout(
          () => finish(new SocketError("timeout")),
          5000,
        );
        function finish(result: SocketStats | SocketError) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          socket.terminate();
          if (result instanceof SocketError) reject(result);
          else resolve(result);
        }
        socket.on("error", () => finish(new SocketError("transport")));
        socket.on("close", () => finish(new SocketError("transport")));
        socket.on("open", () =>
          socket.send(
            JSON.stringify({ event: "auth", args: [capability] }),
            (err) => {
              if (err) finish(new SocketError("transport"));
            },
          ),
        );
        socket.on("message", (raw, binary) => {
          if (done) return;
          if (binary || ++frames > 128) {
            finish(new SocketError("payload"));
            return;
          }
          try {
            const frame = JSON.parse(raw.toString()) as {
              event?: unknown;
              args?: unknown;
            };
            if (!frame || typeof frame.event !== "string")
              throw new SocketError("payload");
            if (
              frame.event === "jwt error" ||
              frame.event === "token expired" ||
              frame.event === "daemon error" ||
              frame.event === "throttled"
            ) {
              finish(new SocketError("rejected"));
              return;
            }
            if (frame.event === "auth success" && !authenticated) {
              authenticated = true;
              socket.send(
                JSON.stringify({ event: "send stats", args: [] }),
                (err) => {
                  if (err) finish(new SocketError("transport"));
                },
              );
              return;
            }
            if (frame.event === "stats" && authenticated) {
              if (
                !Array.isArray(frame.args) ||
                typeof frame.args[0] !== "string"
              )
                throw new SocketError("payload");
              finish(decodeStats(frame.args[0]));
            }
          } catch {
            finish(new SocketError("payload"));
          }
        });
      });
    } finally {
      this.#active--;
    }
  }
}
