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
  allocations: ReadonlyMap<string, string>;
};
const name = "Existing staging workload";
const document = Buffer.from(disposableEgg);

/** Two-row allowlisted adoption fixture. No source database connection, SQL dump or account migration. */
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
  const { key, pepper, allocations } = credentials;
  const node = validateNode(credentials.node);
  const batch = report.servers
    .map(({ uuid, ownerId, nodeId, eggId, nestId, port }) => {
      if (
        typeof uuid !== "string" ||
        typeof ownerId !== "string" ||
        typeof nodeId !== "string" ||
        typeof eggId !== "string" ||
        typeof nestId !== "string" ||
        (port !== 25610 && port !== 25611)
      )
        throw new Error("Invalid staging fixture placement");
      const allocationId = allocations.get(uuid);
      if (!allocationId || !UUID_V4.test(allocationId))
        throw new Error("Missing fixture allocation map");
      return { uuid, ownerId, nodeId, eggId, nestId, port, allocationId };
    })
    .sort((a, b) => a.port - b.port);
  const [first, second] = batch;
  if (
    batch.length !== 2 ||
    report.counts.nodes !== 1 ||
    report.counts.users !== 1 ||
    report.counts.nests !== 1 ||
    report.counts.eggs !== 2 ||
    report.counts.allocations !== 2 ||
    report.counts.subusers !== 0 ||
    first.port !== 25610 ||
    second.port !== 25611 ||
    node.origin !== "http://127.0.0.1:18080"
  )
    throw new Error("Only the reviewed two-server fixture is supported");
  const crypto = cryptoContext(key, pepper, "node-token");
  const token = Buffer.from(node.token);
  return transaction(pool, async (db) => {
    const [database] = await rows<{ name: string }>(
      db,
      "SELECT DATABASE() AS name",
    );
    if (database?.name !== "relay_test")
      throw new Error("Disposable target database required");
    const existing = await rows(
      db,
      "SELECT id FROM servers WHERE id IN (?,?) ORDER BY id FOR UPDATE",
      [first.uuid, second.uuid],
    );
    if (existing.length && existing.length !== batch.length)
      throw new Error("Partial Relay fixture conflicts with import");
    if (existing.length) {
      for (const {
        uuid,
        ownerId,
        nodeId,
        eggId,
        nestId,
        port,
        allocationId,
      } of batch) {
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
      }
      return { applied: false, counts: report.counts };
    }
    const { ownerId, nestId, nodeId } = first;
    await db.execute(
      "INSERT INTO users (id,email,display_name,password_hash) VALUES (?,'adoption@example.test','Fixture','disabled')",
      [ownerId],
    );
    await db.execute(
      "INSERT INTO nests (id,name) VALUES (?,'Adoption fixture')",
      [nestId],
    );
    await db.execute(
      "INSERT INTO nodes (id,name,origin,token_id,token_cipher) VALUES (?,'Existing node',?,?,?)",
      [nodeId, node.origin, node.tokenId, crypto.seal(token, nodeId)],
    );
    for (const { uuid, eggId, port, allocationId } of batch) {
      await db.execute(
        "INSERT INTO eggs (id,nest_id,name,version,document) VALUES (?,?,?,'PTDL_v2',?)",
        [eggId, nestId, `Fixture ${port}`, document],
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
    }
    return { applied: true, counts: report.counts };
  });
}
