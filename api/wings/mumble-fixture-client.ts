import assert from "node:assert/strict";
import { connect } from "node:tls";

// Test-only anonymous authentication on the disposable runner. The workload
// generates a self-signed certificate; never use this client for production.
export function joinFixtureMumble(port: number, username: string) {
  assert.equal(port, 25614);
  assert.match(username, /^relay-ci-[a-z]{1,12}$/);
  return new Promise<{ close: () => void }>((resolve, reject) => {
    const socket = connect({
      host: "127.0.0.1",
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
        pending = pending.subarray(6 + length);
        if (type === 4) {
          socket.destroy(new Error("Mumble rejected fixture authentication"));
          return;
        }
        if (type === 5 && length > 0) {
          cleanup();
          resolve({ close: () => socket.destroy() });
        }
      }
    });
  });
}
