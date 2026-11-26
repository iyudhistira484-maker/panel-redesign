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
  const leaseBinding = `sftp-lease:${node.origin}:${node.tokenId}`;
  type Lease = {
    name: string;
    server: string;
    user: string;
    expires: number;
    fingerprint: string | null;
    version: number;
    permissions: string[];
  };
  return async (input: {
    type: string;
    username: string;
    password: string;
  }) => {
    const refresh = input.type === "lease";
    let lease: Lease | undefined;
    let name: string;
    let identifier: string;
    let fingerprint: Buffer | null;
    if (refresh) {
      try {
        lease = JSON.parse(
          crypt
            .open(Buffer.from(input.password, "base64url"), leaseBinding)
            .toString(),
        ) as Lease;
      } catch {
        return null;
      }
      if (!lease || Date.now() >= lease.expires) return null;
      ({ name, server: identifier } = lease);
      fingerprint = lease.fingerprint
        ? Buffer.from(lease.fingerprint, "hex")
        : null;
    } else {
      if (input.type !== "password" && input.type !== "public_key") return null;
      const match = /^([a-z0-9_.-]{1,191})\.([a-f0-9]{8})$/i.exec(
        input.username,
      );
      if (!match) return null;
      [, name, identifier] = match;
      fingerprint =
        input.type === "public_key" ? sftpKeyFingerprint(input.password) : null;
      if (input.type === "public_key" && !fingerprint) return null;
    }
    const candidates = await rows<{
      user: string;
      server: string;
      hash: string;
      owner: string;
      hasTotp: number;
      version: number;
      fileGrant: number | null;
      grants: string[] | string | null;
      hasKey: number;
      nodeId: string;
      cipher: Buffer;
    }>(
      pool,
      `SELECT u.id AS user,s.id AS server,u.password_hash AS hash,s.owner_id AS owner,
       u.totp_secret IS NOT NULL AS hasTotp,u.auth_version AS version,n.id AS nodeId,n.token_cipher AS cipher,
       JSON_CONTAINS(g.permissions,JSON_ARRAY('file.sftp','file.read','file.read-content')) AS fileGrant,g.permissions AS grants,
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
      version,
      hasKey,
      fileGrant,
      grants,
    } = candidates[0];
    const saved = crypt.open(cipher, nodeId);
    const configured = Buffer.from(node.token);
    if (
      saved.length !== configured.length ||
      !timingSafeEqual(saved, configured)
    )
      return null;
    if (
      hasTotp ||
      (lease &&
        (lease.user !== user ||
          lease.server !== server ||
          lease.version !== version))
    )
      return null;
    if (fingerprint) {
      if (!hasKey || (user !== owner && !fileGrant)) return null;
    } else if (
      user !== owner ||
      (!refresh && !(await checkPassword(input.password, hash)).valid)
    )
      return null;
    const permissions = ["file.read", "file.read-content"];
    if (fingerprint && user !== owner && fileGrant) {
      const allowed =
        typeof grants === "string"
          ? (JSON.parse(grants) as string[])
          : (grants ?? []);
      for (const permission of ["file.create", "file.update", "file.delete"])
        if (allowed.includes(permission)) permissions.push(permission);
    }
    if (refresh) {
      if (JSON.stringify(permissions) !== JSON.stringify(lease?.permissions))
        return null;
      return { user, server, permissions };
    }
    const data: Lease = {
      name,
      user,
      server,
      version,
      fingerprint: fingerprint?.toString("hex") ?? null,
      permissions,
      expires: Date.now() + 60 * 60 * 1000,
    };
    return {
      user,
      server,
      permissions,
      lease: crypt
        .seal(Buffer.from(JSON.stringify(data)), leaseBinding)
        .toString("base64url"),
    };
  };
}
