import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { WingsClient } from "./client";

const node = {
  origin: "http://127.0.0.1:18080",
  tokenId: "treetestnode",
  token: "abcdefghijklmnopqrstuvwxyz0123456789",
};
const file = (name: string, size: number) => ({
  name,
  size,
  directory: false,
  file: true,
  symlink: false,
  mode: "-rw-r--r--",
});
const folder = {
  name: "nested",
  size: 4096,
  directory: true,
  file: false,
  symlink: false,
  mode: "drwxr-xr-x",
};
function client(
  bytes: number[],
  options: {
    reverse?: boolean;
    extra?: boolean;
    symlink?: boolean;
    wrongSize?: boolean;
  } = {},
) {
  return new WingsClient(node, async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("list-directory")) {
      const root = [folder, file("empty", 0)];
      if (options.extra) root.push(file("extra", 0));
      if (options.reverse) root.reverse();
      return Response.json(
        url.searchParams.get("directory") === "/"
          ? root
          : [
              {
                ...file("data.bin", options.wrongSize ? 5 : bytes.length),
                symlink: options.symlink ?? false,
              },
            ],
      );
    }
    const path = url.searchParams.get("file");
    return new Response(
      new Uint8Array(path === "nested/data.bin" ? bytes : []),
    );
  });
}

test("tree digest is stable for unordered listings and detects binary changes and extra files", async () => {
  const id = randomUUID();
  const original = await client([0, 255, 13]).transferTreeDigest(id);
  assert.equal(
    await client([0, 255, 13], { reverse: true }).transferTreeDigest(id),
    original,
  );
  assert.notEqual(await client([0, 254, 13]).transferTreeDigest(id), original);
  assert.notEqual(
    await client([0, 255, 13], { extra: true }).transferTreeDigest(id),
    original,
  );
});

test("tree verification refuses symlinks and inconsistent lengths", async () => {
  const id = randomUUID();
  await assert.rejects(client([0], { symlink: true }).transferTreeDigest(id), {
    reason: "payload",
  });
  await assert.rejects(
    client([0], { wrongSize: true }).transferTreeDigest(id),
    { reason: "payload" },
  );
});
