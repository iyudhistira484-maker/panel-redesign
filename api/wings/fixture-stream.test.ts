import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";
import { FixtureStreamLimit, spoolFixture } from "./fixture-stream";

test("binary spool hashes chunks and rejects over-limit or interrupted bodies", async () => {
  const bytes = Buffer.from([0, 255, 10, 22]);
  const source = () => Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]);
  const result = await spoolFixture(source(), bytes.length);
  try {
    assert.equal(result.size, bytes.length);
    assert.equal(
      result.digest,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.deepEqual(await readFile(result.path), bytes);
  } finally {
    await result.dispose();
  }
  await assert.rejects(readFile(result.path), { code: "ENOENT" });
  await assert.rejects(
    spoolFixture(source(), bytes.length - 1),
    FixtureStreamLimit,
  );
  await assert.rejects(
    spoolFixture(
      Readable.from(
        (async function* () {
          yield bytes.subarray(0, 2);
          throw new Error("connection closed");
        })(),
      ),
      bytes.length,
    ),
    /connection closed/,
  );
});
