import { createHmac, randomUUID } from "node:crypto";
import { UUID_V4, validateNode, type WingsNode } from "./client";

/** Internal fixture capability, never sent to a browser or written to disk. */
export function signTransferCapability(
  raw: WingsNode,
  issuer: string,
  id: string,
  now = Date.now(),
) {
  const node = validateNode(raw);
  if (!UUID_V4.test(id) || new URL(issuer).origin !== issuer)
    throw new Error("Invalid transfer fixture subject");
  const second = Math.floor(now / 1000);
  const json = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const bits = `${json({ alg: "HS256", typ: "JWT" })}.${json({ iss: issuer, aud: [node.origin], sub: id, jti: randomUUID(), iat: second, nbf: second - 1, exp: second + 60, scope: "transfer" })}`;
  return `${bits}.${createHmac("sha256", node.token).update(bits).digest("base64url")}`;
}
