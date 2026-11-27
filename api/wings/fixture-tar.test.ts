import assert from "node:assert/strict";
import { buffer } from "node:stream/consumers";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { extractFixtureTar } from "./fixture-tar";

async function archive(
  names: string[],
  type: "file" | "symlink" = "file",
  data = Buffer.from("\uFEFFrelay å\r\n"),
) {
  const tar = pack();
  const output = buffer(tar);
  for (const name of names)
    tar.entry(
      { name, type, linkname: type === "symlink" ? "other.txt" : undefined },
      type === "file" ? data : Buffer.alloc(0),
    );
  tar.finalize();
  return gzipSync(await output);
}
test("bounded TAR round-trips safe names and exact text bytes", async () => {
  const bytes = Buffer.from("\uFEFFrelay å\r\n");
  const paths = ["one.txt", "two.txt"];
  assert.deepEqual(
    await extractFixtureTar(await archive(paths)),
    paths.map((name) => ({ name, bytes })),
  );
});
test("bounded TAR rejects traversal, duplicate names, links, invalid gzip and expanded content", async () => {
  for (const payload of [
    await archive(["../escape.txt"]),
    await archive(["a.txt", "A.txt"]),
    await archive(["link.txt"], "symlink"),
    await archive(["a.txt"], "file", Buffer.alloc(16385)),
    gzipSync(Buffer.alloc(75001)),
    Buffer.from("invalid"),
  ]) {
    await assert.rejects(extractFixtureTar(payload));
  }
});
