import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { Algorithm, hash, verify } from "@node-rs/argon2";
import bcrypt from "bcryptjs";

export const token = () => randomBytes(32).toString("base64url");
export const passwordHash = (value: string) =>
  hash(value, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
export async function checkPassword(value: string, stored: string) {
  if (stored.startsWith("$argon2id$"))
    return {
      valid: await verify(stored, value).catch(() => false),
      upgrade: false,
    };
  const legacy = /^\$2[aby]\$/.test(stored);
  return {
    valid:
      legacy &&
      Buffer.byteLength(value) <= 72 &&
      (await bcrypt
        .compare(value, stored.replace(/^\$2y\$/, "$2b$"))
        .catch(() => false)),
    upgrade: legacy,
  };
}
export function keyFrom(value: string | undefined, name: string) {
  const key = Buffer.from(value ?? "", "base64");
  if (key.length !== 32) throw new Error(`${name} must encode 32 bytes`);
  return key;
}
export function cryptoContext(key: Buffer, pepper: Buffer) {
  if (key.length !== 32 || pepper.length !== 32 || key.equals(pepper))
    throw new Error("Distinct 32-byte keys required");
  return {
    digest: (scope: string, value: string) =>
      createHmac("sha256", pepper).update(`${scope}\0${value}`).digest(),
    seal: (secret: Buffer, owner: string) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(`totp:v1:${owner}`));
      const body = Buffer.concat([cipher.update(secret), cipher.final()]);
      return Buffer.concat([
        Buffer.from([1]),
        nonce,
        cipher.getAuthTag(),
        body,
      ]);
    },
    open: (src: Buffer, owner: string) => {
      if (src[0] !== 1 || src.length < 30)
        throw new Error("Invalid encrypted record");
      const cipher = createDecipheriv("aes-256-gcm", key, src.subarray(1, 13));
      cipher.setAAD(Buffer.from(`totp:v1:${owner}`));
      cipher.setAuthTag(src.subarray(13, 29));
      return Buffer.concat([cipher.update(src.subarray(29)), cipher.final()]);
    },
  };
}
export function base32(data: Buffer) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let out = "",
    value = 0,
    bits = 0;
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(value >> bits) & 31];
    }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
export function totpAt(secret: Buffer, step: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", secret).update(counter).digest();
  return String((h.readUInt32BE(h[19] & 15) & 0x7fffffff) % 1_000_000).padStart(
    6,
    "0",
  );
}
export function matchingStep(
  secret: Buffer,
  code: string,
  now: number,
  last = -1,
) {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30000);
  for (const step of [current, current - 1, current + 1]) {
    if (
      step >= 0 &&
      step > last &&
      timingSafeEqual(Buffer.from(code), Buffer.from(totpAt(secret, step)))
    )
      return step;
  }
  return null;
}
