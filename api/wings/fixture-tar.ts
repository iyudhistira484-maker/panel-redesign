import { gunzipSync } from "node:zlib";
import { extract } from "tar-stream";
import { fixtureTextLimit } from "./fixture-gzip";
import type { FixtureZipEntry } from "./fixture-zip";

export const fixtureTarLimit = 80_000;
export async function extractFixtureTar(
  input: Buffer,
): Promise<FixtureZipEntry[]> {
  if (!input.length || input.length > fixtureTarLimit)
    throw new Error("Invalid fixture archive");
  const tar = gunzipSync(input, { maxOutputLength: 75_000 });
  if (
    tar.length < 1024 ||
    tar.length % 512 ||
    tar.subarray(-1024).some((byte) => byte !== 0)
  )
    throw new Error("Truncated fixture tar");
  const entries: FixtureZipEntry[] = [];
  const names = new Set<string>();
  const parser = extract();
  parser.end(tar);
  for await (const stream of parser) {
    const { name, type, size } = stream.header;
    if (
      type !== "file" ||
      typeof size !== "number" ||
      size > fixtureTextLimit ||
      size < 0 ||
      entries.length >= 4 ||
      !/^(?:[a-zA-Z0-9][a-zA-Z0-9_. -]{0,75})\.txt$/.test(name) ||
      names.has(name.toLowerCase())
    )
      throw new Error("Invalid fixture tar entry");
    const parts: Buffer[] = [];
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) throw new Error("Invalid archive stream");
      parts.push(chunk);
    }
    const bytes = Buffer.concat(parts);
    if (bytes.length !== size)
      throw new Error("Invalid fixture tar member size");
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    names.add(name.toLowerCase());
    entries.push({ name, bytes });
  }
  if (!entries.length) throw new Error("Empty fixture tar");
  return entries;
}
