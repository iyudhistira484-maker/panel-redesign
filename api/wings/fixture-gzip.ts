import { gzipSync, gunzipSync } from "node:zlib";

export const fixtureTextLimit = 16_384;
const encodedLimit = 22_016;
export function compressFixtureText(bytes: Buffer) {
  if (bytes.length > fixtureTextLimit) throw new Error("Invalid fixture text");
  return gzipSync(bytes);
}

// gzip is a single byte stream, not a directory archive. Never use a filename
// from its optional header; the caller assigns the output path independently.
export function extractFixtureText(content: string) {
  if (content.length > encodedLimit) throw new Error("Invalid fixture gzip");
  const compressed = Buffer.from(content, "base64");
  if (compressed.toString("base64") !== content)
    throw new Error("Invalid fixture gzip");
  const bytes = gunzipSync(compressed, { maxOutputLength: fixtureTextLimit });
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  return { bytes, text };
}
