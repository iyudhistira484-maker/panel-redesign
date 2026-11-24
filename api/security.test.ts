import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import bcrypt from "bcryptjs";
import type { Pool } from "mysql2/promise";
import {
  base32,
  checkPassword,
  cryptoContext,
  matchingStep,
  passwordHash,
  totpAt,
} from "./security";
import { canAccount, canServer, serverPermissions } from "./policy";
import { createApp } from "./app";

test("Argon2id and legacy bcrypt verification", async () => {
  const value = "a staging passphrase only";
  const modern = await passwordHash(value);
  assert.match(modern, /^\$argon2id\$/);
  assert.deepEqual(await checkPassword(value, modern), {
    valid: true,
    upgrade: false,
  });
  assert.equal((await checkPassword("wrong", modern)).valid, false);
  const legacy = (await bcrypt.hash(value, 4)).replace(/^\$2b\$/, "$2y$");
  assert.deepEqual(await checkPassword(value, legacy), {
    valid: true,
    upgrade: true,
  });
});
test("TOTP RFC 6238 vector, correct window, step replay rejected", () => {
  const seed = Buffer.from("12345678901234567890");
  assert.equal(totpAt(seed, 1), "287082");
  assert.equal(matchingStep(seed, "287082", 59000), 1);
  assert.equal(matchingStep(seed, "287082", 59000, 1), null);
  assert.equal(matchingStep(seed, "287082", 150000), null);
  assert.equal(base32(Buffer.from("foobar")), "MZXW6YTBOI");
});
test("TOTP ciphertext bound to owner, tamper rejected, digest domains separated", () => {
  const c = cryptoContext(randomBytes(32), randomBytes(32));
  const seed = randomBytes(20);
  const encrypted = c.seal(seed, "a");
  assert.deepEqual(c.open(encrypted, "a"), seed);
  assert.throws(() => c.open(encrypted, "b"));
  encrypted[15] ^= 1;
  assert.throws(() => c.open(encrypted, "a"));
  assert.notDeepEqual(c.digest("reset", "value"), c.digest("session", "value"));
});
test("authorization matrix keeps every imported permission scoped", () => {
  assert.equal(serverPermissions.length, 40);
  const actor = { id: "alice", admin: false, channel: "session" } as const;
  const server = { id: "one", owner: "bob" };
  for (const p of serverPermissions) {
    const grant = { user: "alice", server: "one", permissions: [p] };
    assert.equal(canServer(actor, server, grant, p), true, p);
    assert.equal(
      canServer(actor, { ...server, id: "two" }, grant, p),
      false,
      p,
    );
    assert.equal(
      canServer(actor, server, { ...grant, user: "eve" }, p),
      false,
      p,
    );
    assert.equal(canServer(actor, server, null, p), false, p);
  }
  assert.equal(
    canServer({ ...actor, admin: true }, server, null, "unknown.permission"),
    false,
  );
  assert.equal(
    canServer(
      { ...actor, channel: "api-key" },
      server,
      { user: "alice", server: "one", permissions: ["file.read"] },
      "file.read",
    ),
    false,
  );
  assert.equal(canAccount({ ...actor, admin: true }, "bob"), false);
  assert.equal(
    canAccount({ ...actor, channel: "api-key" }, "alice", true),
    false,
  );
});
test("HTTP denies foreign origins and strict validation before reaching storage", async () => {
  const app = await createApp({
    pool: {} as Pool,
    origin: "https://relay.example.test",
    key: randomBytes(32),
    pepper: randomBytes(32),
    deliverReset: async () => {
      throw Error("must not send");
    },
  });
  try {
    const request = { method: "POST", url: "/api/v1/auth/login" } as const;
    const headers = {
      origin: "https://relay.example.test",
      "x-relay-request": "1",
    };
    assert.equal(
      (
        await app.inject({
          ...request,
          payload: { email: "a@example.test", password: "bad" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          ...request,
          headers: { ...headers, origin: "https://other.example.test" },
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          ...request,
          headers,
          payload: { email: "a@example.test", password: 123 },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          ...request,
          headers,
          payload: { email: "a@example.test", password: "pw", admin: true },
        })
      ).statusCode,
      400,
    );
    const anonymous = await app.inject("/api/v1/account");
    assert.equal(anonymous.statusCode, 401);
    assert.equal(anonymous.headers["cache-control"], "no-store");
  } finally {
    await app.close();
  }
});
