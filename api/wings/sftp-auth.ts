import { timingSafeEqual } from "node:crypto";
import type { Pool } from "mysql2/promise";
import { rows } from "../db";
import { checkPassword, cryptoContext } from "../security";
import type { WingsNode } from "./client";

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
    if (input.type !== "password") return null;
    const match = /^([a-z0-9_.-]{1,191})\.([a-f0-9]{8}|[a-f0-9-]{36})$/i.exec(
      input.username,
    );
    if (!match) return null;
    const [, name, identifier] = match;
    const candidates = await rows<{
      user: string;
      server: string;
      hash: string;
      nodeId: string;
      cipher: Buffer;
    }>(
      pool,
      `SELECT u.id AS user,s.id AS server,u.password_hash AS hash,n.id AS nodeId,n.token_cipher AS cipher
       FROM users u JOIN compat_account_profiles p ON p.user_id=u.id
       JOIN servers s ON s.owner_id=u.id JOIN nodes n ON n.id=s.node_id
       JOIN wings_provisions w ON w.server_id=s.id
       WHERE BINARY p.username=BINARY ? AND u.totp_secret IS NULL AND w.phase='installed'
       AND (s.id=? OR LEFT(s.id,8)=?) AND n.origin=? AND n.token_id=? LIMIT 2`,
      [name, identifier, identifier, node.origin, node.tokenId],
    );
    if (candidates.length !== 1) return null;
    const { user, server, hash, nodeId, cipher } = candidates[0];
    const saved = crypt.open(cipher, nodeId);
    const configured = Buffer.from(node.token);
    if (
      saved.length !== configured.length ||
      !timingSafeEqual(saved, configured)
    )
      return null;
    if (!(await checkPassword(input.password, hash)).valid) return null;
    return { user, server, permissions: ["file.read", "file.read-content"] };
  };
}
