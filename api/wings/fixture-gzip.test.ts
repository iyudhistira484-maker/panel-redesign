import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { compressFixtureText, extractFixtureText } from "./fixture-gzip";

test("gzip keeps exact UTF-8 bytes and ignores embedded filenames", () => {
  const original = Buffer.from("\uFEFFRelay å\r\n");
  const compressed = compressFixtureText(original);
  const header = Buffer.from(compressed.subarray(0, 10));
  header[3] |= 8;
  const named = Buffer.concat([
    header,
    Buffer.from("../../escape.txt\0"),
    compressed.subarray(10),
  ]);
  assert.deepEqual(extractFixtureText(named.toString("base64")), {
    bytes: original,
    text: original.toString(),
  });
});

test("rejects corrupt gzip, expansion past 16 KiB and invalid UTF-8", () => {
  for (const payload of [
    Buffer.from("not gzip"),
    gzipSync(Buffer.alloc(16385)),
    gzipSync(Buffer.from([255])),
  ])
    assert.throws(() => extractFixtureText(payload.toString("base64")));
});
