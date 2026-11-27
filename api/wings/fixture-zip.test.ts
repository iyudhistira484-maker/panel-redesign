import assert from "node:assert/strict";
import { buffer } from "node:stream/consumers";
import test from "node:test";
import { ZipFile } from "yazl";
import { compressFixtureZip, extractFixtureZip } from "./fixture-zip";

test("round-trips multiple fixture texts with exact bytes", async () => {
  const files = [
    { name: "one.txt", bytes: Buffer.from("\uFEFFé\r\n") },
    { name: "two.txt", bytes: Buffer.from("Second\n") },
  ];
  const zip = await compressFixtureZip(files);
  assert.deepEqual(await extractFixtureZip(zip), files);
  const corrupt = Buffer.from(zip);
  const central = corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  corrupt[central + 16] ^= 1;
  await assert.rejects(extractFixtureZip(corrupt));
  await assert.rejects(extractFixtureZip(zip.subarray(0, -10)));
  const traversal = Buffer.from(zip);
  for (
    let index = traversal.indexOf("one.txt");
    index !== -1;
    index = traversal.indexOf("one.txt", index + 7)
  )
    traversal.write("../.txt", index);
  await assert.rejects(extractFixtureZip(traversal));
});
test("rejects symlinks, nested paths, duplicate names and oversized text", async () => {
  for (const entries of [
    [{ name: "link.txt", mode: 0o120777, size: 1 }],
    [{ name: "nested/a.txt", mode: 0o100644, size: 1 }],
    [
      { name: "a.txt", mode: 0o100644, size: 1 },
      { name: "A.txt", mode: 0o100644, size: 1 },
    ],
    [{ name: "large.txt", mode: 0o100644, size: 16385 }],
  ]) {
    const writer = new ZipFile();
    const zip = buffer(writer.outputStream);
    for (const { name, mode, size } of entries)
      writer.addBuffer(Buffer.alloc(size), name, { mode });
    writer.end();
    await assert.rejects(extractFixtureZip(await zip));
  }
});

test("mixed ZIP preserves arbitrary binary bytes but rejects them under a text filename", async () => {
  const bytes = Buffer.from(Array.from({ length: 16384 }, (_, i) => i % 256));
  const entries = [
    { name: "data.bin", bytes },
    { name: "notes.txt", bytes: Buffer.from("catatan\r\n") },
  ];
  assert.deepEqual(
    await extractFixtureZip(await compressFixtureZip(entries)),
    entries,
  );
  await assert.rejects(compressFixtureZip([{ name: "data.txt", bytes }]));
});
