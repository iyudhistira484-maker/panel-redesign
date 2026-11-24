import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import type { Pool } from "mysql2/promise";
import { createApp } from "../app";
import { WingsClient, supportedWings, validateNode } from "./client";

const node = {
  origin: "http://127.0.0.1:18080",
  tokenId: "relay-test",
  token: randomBytes(32).toString("base64url"),
};
const auth = `Bearer ${node.tokenId}.${node.token}`;
const origin = "https://relay.example.test";

test("bootstrap callbacks require node credentials and leave browser CSRF intact", async () => {
  const app = await createApp({
    pool: {} as Pool,
    origin,
    key: randomBytes(32),
    pepper: randomBytes(32),
    deliverReset: async () => {},
    wingsTestNode: node,
  });
  try {
    const url = "/api/remote/servers";
    assert.equal((await app.inject(url)).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          url,
          headers: { authorization: `Bearer ${node.token}` },
        })
      ).statusCode,
      401,
    );
    const res = await app.inject({
      url: `${url}?page=1&per_page=50`,
      headers: { authorization: auth },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      data: [],
      meta: {
        current_page: 1,
        from: 0,
        last_page: 1,
        per_page: 50,
        to: 0,
        total: 0,
      },
    });
    assert.equal(
      (
        await app.inject({
          url: `${url}?page=-1`,
          headers: { authorization: auth },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `${url}/reset`,
          headers: { authorization: auth },
        })
      ).statusCode,
      204,
    );
    assert.equal(
      (await app.inject({ method: "POST", url: `${url}/reset` })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          url: `${url}/11111111-1111-4111-8111-111111111111`,
          headers: { authorization: auth },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/logout",
          headers: { authorization: auth },
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
  }
});

test("outbound client pins origin and version without reflecting upstream errors", async () => {
  assert.throws(() =>
    validateNode({ ...node, origin: "http://example.test:18080" }),
  );
  assert.throws(() =>
    validateNode({ ...node, origin: "http://127.0.0.1:18080/api" }),
  );
  const payload = {
    version: supportedWings,
    cpu_count: 4,
    architecture: "amd64",
    os: "linux",
  };
  const fixture: typeof fetch = async (url, options) => {
    assert.equal(url, `${node.origin}/api/system`);
    assert.equal(options?.redirect, "error");
    assert.equal(
      new Headers(options?.headers).get("authorization"),
      `Bearer ${node.token}`,
    );
    return Response.json(payload);
  };
  assert.equal((await new WingsClient(node, fixture).health()).cpuThreads, 4);
  await assert.rejects(
    new WingsClient(node, async () =>
      Response.json({ ...payload, version: "0.0.0" }),
    ).health(),
    { reason: "version" },
  );
  await assert.rejects(
    new WingsClient(node, async () => new Response("x".repeat(16385))).health(),
    { reason: "payload" },
  );
  await assert.rejects(
    new WingsClient(
      node,
      async () => new Response(node.token, { status: 401 }),
    ).health(),
    { reason: "http" },
  );
});
