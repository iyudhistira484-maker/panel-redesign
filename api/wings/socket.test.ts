import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { signReadCapability, WingsSocket } from "./socket";
const origin = "https://relay.example.test";
const token = randomBytes(32).toString("hex");
const node = {
  origin: "http://127.0.0.1:18080",
  tokenId: "test-node-id",
  token,
};

test("read-only socket capability is short lived and bound to server and user", () => {
  const now = 1_800_000_000_000,
    server = randomUUID(),
    user = randomUUID();
  const [header, payload, signature] = signReadCapability(
    node,
    origin,
    server,
    user,
    now,
  ).split(".");
  assert.equal(
    signature,
    createHmac("sha256", token)
      .update(`${header}.${payload}`)
      .digest("base64url"),
  );
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.deepEqual(claims.permissions, ["websocket.connect"]);
  assert.equal(claims.scope, "websocket");
  assert.equal(claims.exp - claims.iat, 30);
  assert.equal(claims.server_uuid, server);
  assert.equal(claims.user_uuid, user);
  assert.equal(claims.iss, origin);
  assert.throws(() => signReadCapability(node, origin, "../ws", user));
});

test("stats request follows authentication and returns only expected numeric fields", async () => {
  const hub = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve, reject) => {
    hub.once("listening", resolve);
    hub.once("error", reject);
  });
  const address = hub.address();
  assert.ok(address && typeof address !== "string");
  const events: string[] = [];
  hub.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      events.push(frame.event);
      if (frame.event === "auth")
        socket.send(JSON.stringify({ event: "auth success" }));
      if (frame.event === "send stats")
        socket.send(
          JSON.stringify({
            event: "stats",
            args: [
              JSON.stringify({
                memory_bytes: 2,
                memory_limit_bytes: 4,
                cpu_absolute: 0.25,
                disk_bytes: 3,
                uptime: 5,
                network: { rx_bytes: 6, tx_bytes: 7 },
                hidden: "do not forward",
              }),
            ],
          }),
        );
    });
  });
  try {
    const socket = new WingsSocket(
      { ...node, origin: `http://127.0.0.1:${address.port}` },
      origin,
    );
    assert.deepEqual(await socket.stats(randomUUID(), randomUUID()), {
      memoryBytes: 2,
      memoryLimitBytes: 4,
      cpuAbsolute: 0.25,
      diskBytes: 3,
      uptimeMs: 5,
      rxBytes: 6,
      txBytes: 7,
    });
    assert.deepEqual(events, ["auth", "send stats"]);
  } finally {
    await new Promise<void>((resolve) => hub.close(() => resolve()));
  }
});

test("console fixture drops unknown output and bounds its allowed marker history", async () => {
  const hub = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve, reject) => {
    hub.once("listening", resolve);
    hub.once("error", reject);
  });
  const address = hub.address();
  assert.ok(address && typeof address !== "string");
  hub.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.event === "auth")
        socket.send(JSON.stringify({ event: "auth success" }));
      if (frame.event === "send logs") {
        socket.send(
          JSON.stringify({
            event: "console output",
            args: ["token=example-private-value"],
          }),
        );
        for (let i = 0; i < 22; i++)
          socket.send(
            JSON.stringify({
              event: "console output",
              args: ["\u001b[32mRELAY_CONTRACT_READY\u001b[0m\r\n"],
            }),
          );
      }
    });
  });
  try {
    const socket = new WingsSocket(
      { ...node, origin: `http://127.0.0.1:${address.port}` },
      origin,
    );
    const result = await socket.console(randomUUID(), randomUUID());
    assert.deepEqual(result, {
      lines: Array.from({ length: 20 }, () => "RELAY_CONTRACT_READY"),
      truncated: true,
    });
  } finally {
    await new Promise<void>((resolve) => hub.close(() => resolve()));
  }
});
