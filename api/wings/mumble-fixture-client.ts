import assert from "node:assert/strict";
import { connect } from "node:tls";

// ChannelState properties are optional: initial discovery carries the ID and
// name, while later messages can update unrelated fields on the same channel.
export function decodeFixtureChannel(payload: Buffer) {
  let offset = 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      assert.ok(offset < payload.length, "Truncated protobuf varint");
      const byte = payload[offset++];
      assert.ok(shift < 28 || byte <= 15, "Oversized protobuf varint");
      value += (byte & 127) * 2 ** shift;
      if (byte < 128) return value;
    }
    throw new Error("Invalid protobuf varint");
  };
  let id: number | undefined;
  let name: string | undefined;
  while (offset < payload.length) {
    const tag = varint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      const value = varint();
      if (field === 1) id = value;
    } else if (wire === 2) {
      const length = varint();
      assert.ok(length <= payload.length - offset, "Truncated protobuf field");
      if (field === 3) name = payload.toString("utf8", offset, offset + length);
      offset += length;
    } else {
      throw new Error("Unexpected Mumble ChannelState wire type");
    }
  }
  return { id, name };
}

// Test-only anonymous authentication on the disposable runner. The workload
// generates a self-signed certificate; never use this client for production.
export function joinFixtureMumble(
  port: number,
  username: string,
  host = "127.0.0.1",
) {
  assert.ok(
    (port === 25614 && host === "127.0.0.1") ||
      (port === 25611 && /^172\.(?:1[6-9]|2[0-9]|3[01])\.\d+\.\d+$/.test(host)),
  );
  assert.match(username, /^relay-ci-[a-z]{1,12}$/);
  return new Promise<{
    close: () => void;
    probe: () => Promise<void>;
    hasChannel: (name: string) => boolean;
  }>((resolve, reject) => {
    const socket = connect({
      host,
      port,
      rejectUnauthorized: false,
    });
    const deadline = setTimeout(
      () => socket.destroy(new Error("Mumble ServerSync timed out")),
      6000,
    );
    const cleanup = () => clearTimeout(deadline);
    socket.once("error", (error) => {
      cleanup();
      reject(error);
    });
    socket.once("close", () => {
      cleanup();
      reject(new Error("Mumble closed before ServerSync"));
    });
    socket.once("secureConnect", () => {
      // Authenticate (type 2), protobuf field 1: username, field 5: Opus.
      const name = Buffer.from(username);
      const payload = Buffer.concat([
        Buffer.from([0x0a, name.length]),
        name,
        Buffer.from([0x28, 1]),
      ]);
      const header = Buffer.alloc(6);
      header.writeUInt16BE(2);
      header.writeUInt32BE(payload.length, 2);
      socket.write(Buffer.concat([header, payload]));
    });
    let synced = false;
    let serial = 0;
    let waiting:
      | { payload: Buffer; finish: (error?: Error) => void }
      | undefined;
    socket.once("close", () =>
      waiting?.finish(new Error("Original Mumble session closed")),
    );
    const probe = async () => {
      assert.ok(
        synced && !socket.destroyed && !socket.readableEnded,
        "Original Mumble session is no longer connected",
      );
      assert.ok(!waiting, "Mumble fixture probe already pending");
      assert.ok(++serial < 128, "Mumble fixture probe budget exceeded");
      // Ping (type 3), protobuf field 1: echoed timestamp. A new nonce
      // proves a fresh reply on the original TLS socket, not a reconnect.
      const payload = Buffer.from([8, serial]);
      await new Promise<void>((resolveProbe, rejectProbe) => {
        const timer = setTimeout(
          () => waiting?.finish(new Error("Mumble session ping timed out")),
          4000,
        );
        waiting = {
          payload,
          finish(error) {
            clearTimeout(timer);
            waiting = undefined;
            if (error) rejectProbe(error);
            else resolveProbe();
          },
        };
        socket.write(
          Buffer.concat([
            Buffer.from([0, 3, 0, 0, 0, payload.length]),
            payload,
          ]),
        );
      });
    };
    const channels = new Map<number, string>();
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 6) {
        const type = pending.readUInt16BE(0);
        const length = pending.readUInt32BE(2);
        if (length > 262144) {
          socket.destroy(new Error("Oversized Mumble fixture frame"));
          return;
        }
        if (pending.length < 6 + length) return;
        const payload = pending.subarray(6, 6 + length);
        pending = pending.subarray(6 + length);
        if (
          type === 3 &&
          waiting &&
          payload.subarray(0, 2).equals(waiting.payload)
        )
          waiting.finish();
        if (type === 7) {
          try {
            const { id, name } = decodeFixtureChannel(payload);
            if (id !== undefined && name !== undefined) channels.set(id, name);
          } catch (error) {
            socket.destroy(error as Error);
            return;
          }
        }
        if (type === 4) {
          socket.destroy(new Error("Mumble rejected fixture authentication"));
          return;
        }
        if (type === 5 && length > 0) {
          cleanup();
          synced = true;
          resolve({
            close: () => socket.destroy(),
            probe,
            hasChannel: (name: string) => [...channels.values()].includes(name),
          });
        }
      }
    });
  });
}

// No client is replaced after a failed probe. Check both sessions before,
// during and after the control-plane operation, including an in-flight probe.
export async function observeMumbleSessions(
  sessions: readonly { probe: () => Promise<void> }[],
  operation: () => Promise<void>,
) {
  assert.equal(sessions.length, 2);
  const check = async () => {
    await Promise.all(sessions.map((session) => session.probe()));
  };
  await check();
  let stopped = false;
  let samples = 0;
  const monitoring = (async () => {
    try {
      do {
        await check();
        samples++;
        if (!stopped) await new Promise((resolve) => setTimeout(resolve, 250));
      } while (!stopped);
      return { ok: true } as const;
    } catch (error) {
      return { ok: false, error } as const;
    }
  })();
  try {
    await operation();
  } finally {
    stopped = true;
    await monitoring;
  }
  const result = await monitoring;
  if (!result.ok) throw result.error;
  await check();
  return { samples };
}
