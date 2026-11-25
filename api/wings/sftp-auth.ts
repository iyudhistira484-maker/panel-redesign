import { createHash, timingSafeEqual } from "node:crypto";
import type { Pool } from "mysql2/promise";
import { rows } from "../db";
import { checkPassword, cryptoContext } from "../security";
import type { WingsNode } from "./client";

// Match raw OpenSSH Ed25519 public keys only; comments do not affect identity.
export function sftpKeyFingerprint(value: string) {
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]{68})(?: [^\r\n]*)?$/.exec(
    value.trim(),
  );
  if (!match) return null;
  const binary = Buffer.from(match[1], "base64");
  if (
    binary.length !== 51 ||
    binary.readUInt32BE(0) !== 11 ||
    binary.toString("ascii", 4, 15) !== "ssh-ed25519" ||
    binary.readUInt32BE(15) !== 32
  )
    return null;
  return createHash("sha256").update(binary).digest();
}

export function stagingSftpAuth(
  pool: Pool,
  node: WingsNode,
  key: Buffer,
  pepper: Buffer,
) {
  const crypt = cryptoContext(key, pepper, "node-token");
  return async (input: {
    type: string;
    username: string;
    password: string;
  }) => {
    if (input.type !== "password" && input.type !== "public_key") return null;
    const fingerprint =
      input.type === "public_key" ? sftpKeyFingerprint(input.password) : null;
    if (input.type === "public_key" && !fingerprint) return null;
    const match = /^([a-z0-9_.-]{1,191})\.([a-f0-9]{8}|[a-f0-9-]{36})$/i.exec(
      input.username,
    );
    if (!match) return null;
    const [, name, identifier] = match;
    const candidates = await rows<{
      user: string;
      server: string;
      hash: string;
      owner: string;
      hasTotp: number;
      fileGrant: number | null;
      hasKey: number;
      nodeId: string;
      cipher: Buffer;
    }>(
      pool,
      `SELECT u.id AS user,s.id AS server,u.password_hash AS hash,s.owner_id AS owner,
       u.totp_secret IS NOT NULL AS hasTotp,n.id AS nodeId,n.token_cipher AS cipher,
       JSON_CONTAINS(g.permissions,JSON_ARRAY('file.sftp','file.read','file.read-content')) AS fileGrant,
       EXISTS(SELECT 1 FROM compat_sftp_keys k WHERE k.user_id=u.id AND k.fingerprint=?) AS hasKey
       FROM users u JOIN compat_account_profiles p ON p.user_id=u.id
       JOIN servers s ON (s.id=? OR LEFT(s.id,8)=?) JOIN nodes n ON n.id=s.node_id
       JOIN wings_provisions w ON w.server_id=s.id
       LEFT JOIN server_grants g ON g.user_id=u.id AND g.server_id=s.id
       WHERE BINARY p.username=BINARY ? AND w.phase='installed'
       AND n.origin=? AND n.token_id=? LIMIT 2`,
      [fingerprint, identifier, identifier, name, node.origin, node.tokenId],
    );
    if (candidates.length !== 1) return null;
    const {
      user,
      server,
      hash,
      nodeId,
      cipher,
      owner,
      hasTotp,
      hasKey,
      fileGrant,
    } = candidates[0];
    const saved = crypt.open(cipher, nodeId);
    const configured = Buffer.from(node.token);
    if (
      saved.length !== configured.length ||
      !timingSafeEqual(saved, configured)
    )
      return null;
    if (input.type === "password") {
      if (
        user !== owner ||
        hasTotp ||
        !(await checkPassword(input.password, hash)).valid
      )
        return null;
    } else if (hasTotp || !hasKey || (user !== owner && !fileGrant))
      return null;
    return { user, server, permissions: ["file.read", "file.read-content"] };
  };
}
