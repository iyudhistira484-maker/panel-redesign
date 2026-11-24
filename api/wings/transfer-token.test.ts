import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { WingsClient } from "./client";
import { signTransferCapability } from "./transfer-token";
const source = {
  origin: "http://127.0.0.1:18180",
  tokenId: "relaytransfersource",
  token: randomBytes(32).toString("hex"),
};
const dest = {
  origin: "http://127.0.0.1:18181",
  tokenId: "relaytransfertarget",
  token: randomBytes(32).toString("hex"),
};

test("transfer JWT signs for destination and binds the fixture UUID via sub", () => {
  const uuid = randomUUID();
  const [header, body, signature] = signTransferCapability(
    dest,
    "http://127.0.0.1:13201",
    uuid,
    1_800_000_000_000,
  ).split(".");
  const hash = (secret: string) =>
    createHmac("sha256", secret)
      .update(`${header}.${body}`)
      .digest("base64url");
  assert.equal(signature, hash(dest.token));
  assert.notEqual(signature, hash(source.token));
  const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  assert.equal(claims.scope, "transfer");
  assert.equal(claims.sub, uuid);
  assert.deepEqual(claims.aud, [dest.origin]);
  assert.equal(claims.exp - claims.iat, 60);
});

test("outbound transfer fixes the path and keeps source and destination authorization separate", async () => {
  const uuid = randomUUID();
  const key = signTransferCapability(dest, "http://127.0.0.1:13201", uuid);
  let sends = 0;
  const client = new WingsClient(source, async (url, init) => {
    sends++;
    assert.equal(url, `${source.origin}/api/servers/${uuid}/transfer`);
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${source.token}`,
    );
    assert.deepEqual(JSON.parse(String(init?.body)), {
      url: `${dest.origin}/api/transfers`,
      token: `Bearer ${key}`,
      server: { uuid, start_on_completion: false },
    });
    return new Response(null, { status: 202 });
  });
  await assert.rejects(client.transferTo(uuid, source, key));
  await assert.rejects(
    client.transferTo(
      uuid,
      { ...dest, origin: "http://example.test:18181" },
      key,
    ),
  );
  assert.equal(sends, 0);
  await client.transferTo(uuid, dest, key);
  assert.equal(sends, 1);
});
