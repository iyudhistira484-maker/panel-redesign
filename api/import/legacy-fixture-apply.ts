import { timingSafeEqual } from "node:crypto";
import type { Pool } from "mysql2/promise";
import { rows, transaction } from "../db";
import { cryptoContext } from "../security";
import { UUID_V4, validateNode, type WingsNode } from "../wings/client";
import { disposableEgg } from "../wings/provision";
import { legacyPreflight } from "./legacy-preflight";

type Credentials = {
  node: WingsNode;
  key: Buffer;
  pepper: Buffer;
  allocationId: string;
};
const name = "Existing staging workload";
const document = Buffer.from(disposableEgg);

/** Single allowlisted adoption fixture. No source database connection, SQL dump or account migration. */
export async function applyLegacyFixture(
  pool: Pool,
  manifest: unknown,
  credentials: Credentials,
) {
  if (
    process.env.RELAY_DISPOSABLE_WINGS_CI !== "1" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    process.env.GITHUB_EVENT_NAME !== "push" ||
    !process.env.RELAY_STAGING_DATABASE_URL?.endsWith("/relay_test")
  )
    throw new Error("Disposable staging fixture only");
  const report = legacyPreflight(manifest);
  if (
    Object.entries(report.counts).some(
      ([table, count]) => count !== (table === "subusers" ? 0 : 1),
    ) ||
    report.servers.length !== 1
  )
    throw new Error("Only one legacy fixture is supported");
  const server = report.servers[0];
  const { uuid, ownerId, nodeId, eggId, nestId, port } = server;
  const { allocationId, key, pepper } = credentials;
  const node = validateNode(credentials.node);
  if (
    typeof uuid !== "string" ||
    typeof ownerId !== "string" ||
    typeof nodeId !== "string" ||
    typeof eggId !== "string" ||
    typeof nestId !== "string" ||
    !UUID_V4.test(allocationId) ||
    port !== 25610 ||
    node.origin !== "http://127.0.0.1:18080"
  )
    throw new Error("Invalid staging fixture placement");
  const crypto = cryptoContext(key, pepper, "node-token");
  const token = Buffer.from(node.token);
  return transaction(pool, async (db) => {
    const [database] = await rows<{ name: string }>(
      db,
      "SELECT DATABASE() AS name",
    );
    if (database?.name !== "relay_test")
      throw new Error("Disposable target database required");
    const [existing] = await rows(
      db,
      "SELECT id FROM servers WHERE id=? FOR UPDATE",
      [uuid],
    );
    if (existing) {
      const [matched] = await rows<{ cipher: Buffer }>(
        db,
        `SELECT n.token_cipher AS cipher FROM servers s
        JOIN nodes n ON n.id=s.node_id JOIN allocations a ON a.id=s.allocation_id AND a.node_id=s.node_id
        JOIN users u ON u.id=s.owner_id JOIN eggs e ON e.id=s.egg_id JOIN nests t ON t.id=e.nest_id
        JOIN wings_provisions p ON p.server_id=s.id
        WHERE s.id=? AND s.name=? AND s.owner_id=? AND u.email='adoption@example.test' AND u.password_hash='disabled' AND u.is_admin=0
        AND s.node_id=? AND n.origin=? AND n.token_id=? AND s.egg_id=? AND e.nest_id=? AND e.version='PTDL_v2' AND e.document=?
        AND s.allocation_id=? AND a.ip='127.0.0.1' AND a.port=? AND p.phase='installed' FOR UPDATE`,
        [
          uuid,
          name,
          ownerId,
          nodeId,
          node.origin,
          node.tokenId,
          eggId,
          nestId,
          document,
          allocationId,
          port,
        ],
      );
      if (!matched)
        throw new Error("Existing Relay fixture conflicts with import");
      const saved = crypto.open(matched.cipher, nodeId);
      if (saved.length !== token.length || !timingSafeEqual(saved, token))
        throw new Error("Existing Relay fixture token differs");
      return { applied: false, counts: report.counts };
    }
    await db.execute(
      "INSERT INTO users (id,email,display_name,password_hash) VALUES (?,'adoption@example.test','Fixture','disabled')",
      [ownerId],
    );
    await db.execute(
      "INSERT INTO nests (id,name) VALUES (?,'Adoption fixture')",
      [nestId],
    );
    await db.execute(
      "INSERT INTO eggs (id,nest_id,name,version,document) VALUES (?,?,'Fixture','PTDL_v2',?)",
      [eggId, nestId, document],
    );
    await db.execute(
      "INSERT INTO nodes (id,name,origin,token_id,token_cipher) VALUES (?,'Existing node',?,?,?)",
      [nodeId, node.origin, node.tokenId, crypto.seal(token, nodeId)],
    );
    await db.execute(
      "INSERT INTO allocations (id,node_id,ip,port) VALUES (?,?,'127.0.0.1',?)",
      [allocationId, nodeId, port],
    );
    await db.execute(
      "INSERT INTO servers (id,name,node_id,owner_id,egg_id,allocation_id) VALUES (?,?,?,?,?,?)",
      [uuid, name, nodeId, ownerId, eggId, allocationId],
    );
    await db.execute(
      "INSERT INTO wings_provisions (server_id,phase) VALUES (?,'installed')",
      [uuid],
    );
    return { applied: true, counts: report.counts };
  });
}
