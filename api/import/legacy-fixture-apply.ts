import { isDeepStrictEqual } from "node:util";
import { timingSafeEqual } from "node:crypto";
import type { Pool } from "mysql2/promise";
import { rows, transaction } from "../db";
import { cryptoContext } from "../security";
import { UUID_V4, validateNode, type WingsNode } from "../wings/client";
import { disposableEgg } from "../wings/provision";
import { legacyPreflight } from "./legacy-preflight";

type Credentials = {
  nodes: ReadonlyMap<string, WingsNode>;
  key: Buffer;
  pepper: Buffer;
  allocations: ReadonlyMap<string, string>;
  collaborator: string;
  outsider: string;
};
const name = "Existing staging workload";
const document = Buffer.from(disposableEgg);

/** Two-row allowlisted adoption fixture. Uses disabled fixture identities, never legacy credentials. */
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
      const configured = credentials.nodes.get(nodeId);
      if (!configured) throw new Error("Missing fixture node map");
      const node = validateNode(configured);
      return {
        uuid,
        ownerId,
        nodeId,
        eggId,
        nestId,
        port,
        allocationId,
        node,
        token: Buffer.from(node.token),
      };
    })
    .sort((a, b) => a.port - b.port);
  const [first, second] = batch;
  if (
    batch.length !== 2 ||
    report.counts.nodes !== 2 ||
    report.counts.users !== 3 ||
    report.counts.nests !== 1 ||
    report.counts.eggs !== 2 ||
    report.counts.allocations !== 2 ||
    report.counts.subusers !== 1 ||
    first.port !== 25610 ||
    second.port !== 25611 ||
    first.node.origin !== "http://127.0.0.1:18080" ||
    second.node.origin !== "http://127.0.0.1:18081" ||
    first.nodeId === second.nodeId
  )
    throw new Error("Only the reviewed two-server fixture is supported");
  const accounts = [
    first.ownerId,
    credentials.collaborator,
    credentials.outsider,
  ];
  const grant = report.grants[0];
  if (
    accounts.some((id) => !UUID_V4.test(id)) ||
    new Set(accounts).size !== 3 ||
    second.ownerId !== first.ownerId ||
    !isDeepStrictEqual(grant, {
      userId: credentials.collaborator,
      serverId: first.uuid,
      permissions: ["activity.read", "control.start"],
    })
  )
    throw new Error("Invalid fixture account or grant mapping");
  const emails = [
    "adoption@example.test",
    "collaborator@example.test",
    "outsider@example.test",
  ];
  const crypto = cryptoContext(key, pepper, "node-token");

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
        node,
        token,
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
      for (const [i, id] of accounts.entries()) {
        const matched = await rows(
          db,
          "SELECT id FROM users WHERE id=? AND email=? AND password_hash='disabled' AND is_admin=0 FOR UPDATE",
          [id, emails[i]],
        );
        if (matched.length !== 1)
          throw new Error("Existing Relay account conflicts with import");
      }
      const savedGrants = await rows<{
        userId: string;
        serverId: string;
        permissions: unknown;
      }>(
        db,
        "SELECT user_id AS userId,server_id AS serverId,permissions FROM server_grants WHERE server_id IN (?,?) FOR UPDATE",
        [first.uuid, second.uuid],
      );
      if (
        !isDeepStrictEqual(
          savedGrants.map((row) => ({
            ...row,
            permissions:
              typeof row.permissions === "string"
                ? JSON.parse(row.permissions)
                : row.permissions,
          })),
          [grant],
        )
      )
        throw new Error("Existing Relay grants conflict with import");
      return { applied: false, counts: report.counts };
    }
    const { ownerId, nestId } = first;
    for (const [i, id] of accounts.entries())
      await db.execute(
        "INSERT INTO users (id,email,display_name,password_hash) VALUES (?,?,'Fixture','disabled')",
        [id, emails[i]],
      );
    await db.execute(
      "INSERT INTO nests (id,name) VALUES (?,'Adoption fixture')",
      [nestId],
    );
    for (const {
      uuid,
      eggId,
      port,
      allocationId,
      nodeId,
      node,
      token,
    } of batch) {
      await db.execute(
        "INSERT INTO nodes (id,name,origin,token_id,token_cipher) VALUES (?,'Existing node',?,?,?)",
        [nodeId, node.origin, node.tokenId, crypto.seal(token, nodeId)],
      );
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
    await db.execute(
      "INSERT INTO server_grants (user_id,server_id,permissions) VALUES (?,?,?)",
      [credentials.collaborator, first.uuid, JSON.stringify(grant.permissions)],
    );
    return { applied: true, counts: report.counts };
  });
}
