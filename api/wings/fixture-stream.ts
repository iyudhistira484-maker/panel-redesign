import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export class FixtureStreamLimit extends Error {}
export async function spoolFixture(source: Readable, limit: number) {
  const directory = await mkdtemp(join(tmpdir(), "relay-transfer-"));
  const path = join(directory, "file");
  const dispose = () => rm(directory, { recursive: true, force: true });
  let size = 0;
  const hash = createHash("sha256");
  try {
    await pipeline(
      source,
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          size += chunk.length;
          if (size > limit) return done(new FixtureStreamLimit());
          hash.update(chunk);
          done(null, chunk);
        },
      }),
      createWriteStream(path, { flags: "wx", mode: 0o600 }),
      { signal: AbortSignal.timeout(15_000) },
    );
    return { path, size, digest: hash.digest("hex"), dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
