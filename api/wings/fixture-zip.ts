import { buffer as collect } from "node:stream/consumers";
import { crc32 } from "node:zlib";
import { type ZipFile, fromBuffer } from "yauzl";
import { ZipFile as ZipWriter } from "yazl";
import { fixtureTextLimit } from "./fixture-gzip";

export const fixtureZipLimits = {
  entries: 4,
  total: 4 * fixtureTextLimit,
  archive: 70_000,
};
export type FixtureZipEntry = { name: string; bytes: Buffer };
export const fixtureZipName = (name: string) =>
  /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}\.(txt|bin)(?![\s\S])/.test(name);
const invalid = () => new Error("Invalid fixture ZIP");
function validate(entries: FixtureZipEntry[]) {
  const names = new Set<string>();
  let total = 0;
  if (!entries.length || entries.length > fixtureZipLimits.entries)
    throw invalid();
  for (const { name, bytes } of entries) {
    if (
      !fixtureZipName(name) ||
      names.has(name.toLowerCase()) ||
      bytes.length > fixtureTextLimit
    )
      throw invalid();
    names.add(name.toLowerCase());
    total += bytes.length;
    if (name.endsWith(".txt"))
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  if (total > fixtureZipLimits.total) throw invalid();
}
export async function compressFixtureZip(entries: FixtureZipEntry[]) {
  validate(entries);
  const zip = new ZipWriter();
  const result = collect(zip.outputStream);
  for (const { name, bytes } of entries)
    zip.addBuffer(bytes, name, { mode: 0o100644 });
  zip.end();
  return result;
}
export async function extractFixtureZip(
  input: Buffer,
): Promise<FixtureZipEntry[]> {
  if (!input.length || input.length > fixtureZipLimits.archive) throw invalid();
  const zip = await new Promise<ZipFile>((resolve, reject) =>
    fromBuffer(
      input,
      {
        lazyEntries: true,
        autoClose: false,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, file) => (error ? reject(error) : resolve(file)),
    ),
  );
  try {
    if (zip.entryCount < 1 || zip.entryCount > fixtureZipLimits.entries)
      throw invalid();
    const entries: FixtureZipEntry[] = [];
    return await new Promise((resolve, reject) => {
      zip.on("error", reject);
      zip.once("end", () => {
        try {
          validate(entries);
          resolve(entries);
        } catch (error) {
          reject(error);
        }
      });
      zip.on("entry", (entry) => {
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (
          (mode !== 0 && mode !== 0o100000) ||
          (entry.externalFileAttributes & 0x10) !== 0 ||
          entry.isEncrypted() ||
          entry.uncompressedSize > fixtureTextLimit ||
          entries.length >= fixtureZipLimits.entries
        ) {
          reject(invalid());
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            reject(error ?? invalid());
            return;
          }
          void collect(stream)
            .then((bytes) => {
              if (
                bytes.length !== entry.uncompressedSize ||
                crc32(bytes) !== entry.crc32
              )
                throw invalid();
              entries.push({ name: entry.fileName, bytes });
              validate(entries);
              zip.readEntry();
            })
            .catch(reject);
        });
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}
