import { isDeepStrictEqual } from "node:util";
import { timingSafeEqual } from "node:crypto";
import type { Pool } from "mysql2/promise";
import { rows, transaction } from "../db";
import { cryptoContext } from "../security";
import { UUID_V4, validateNode, type WingsNode } from "../wings/client";
import { mumbleEgg } from "../eggs/upstream-workload";
import { disposableEgg } from "../wings/provision";
import { legacyPreflight } from "./legacy-preflight";

type Credentials = {
  nodes: ReadonlyMap<string, WingsNode>;
  key: Buffer;
  pepper: Buffer;
  allocations: ReadonlyMap<string, string>;
  secondaryAllocations?: ReadonlyMap<number, string>;
  accounts: ReadonlyMap<string, string>;
  reviewedMumbleEggs?: ReadonlySet<string>;
};
const name = "Existing staging workload";
export function reviewedAdoptionEgg(
  eggId: string,
  reviewedMumbleEggs?: ReadonlySet<string>,
) {
  return reviewedMumbleEggs?.has(eggId)
    ? { document: Buffer.from(mumbleEgg), maxUsers: "37" }
    : { document: Buffer.from(disposableEgg), maxUsers: null };
}

/** Bounded staging catalog adoption for reviewed shell and Mumble workloads. Uses disabled fixture identities, never legacy credentials. */
export async function applyLegacyFixture(
  pool: Pool,
  manifest: unknown,
  credentials: Credentials,
) {
  if (
    process.env.RELAY_DISPOSABLE_WINGS_CI !== "1" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    (process.env.GITHUB_EVENT_NAME !== "push" &&
      !(
        process.env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
        process.env.GITHUB_WORKFLOW === "Relay Wings off-host staging"
      )) ||
    !process.env.RELAY_STAGING_DATABASE_URL?.endsWith("/relay_test")
  )
    throw new Error("Disposable staging fixture only");
  const report = legacyPreflight(manifest);
  const { key, pepper, allocations } = credentials;
  if (report.primaryAllocations.some((row) => row.ip !== "127.0.0.1"))
    throw new Error("Unsupported staging primary IP");

  const batch = report.servers
    .map(({ uuid, ownerId, nodeId, eggId, nestId, port, externalId }) => {
      if (
        typeof uuid !== "string" ||
        typeof ownerId !== "string" ||
        typeof nodeId !== "string" ||
        typeof eggId !== "string" ||
        typeof nestId !== "string" ||
        typeof port !== "number"
      )
        throw new Error("Invalid staging fixture placement");
      const allocationId = allocations.get(uuid);
      if (!allocationId || !UUID_V4.test(allocationId))
        throw new Error("Missing fixture allocation map");
      const configured = credentials.nodes.get(nodeId);
      if (!configured) throw new Error("Missing fixture node map");
      const node = validateNode(configured);
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(node.origin))
        throw new Error("Loopback Wings only");
      return {
        uuid,
        externalId,
        ownerId,
        nodeId,
        eggId,
        nestId,
        port,
        allocationId,
        node,
        token: Buffer.from(node.token),
        ...reviewedAdoptionEgg(eggId, credentials.reviewedMumbleEggs),
      };
    })
    .sort((a, b) => a.port - b.port);
  const nodes = new Map(batch.map((row) => [row.nodeId, row]));
  const eggs = new Map(batch.map((row) => [row.eggId, row]));
  for (const egg of credentials.reviewedMumbleEggs ?? [])
    if (!eggs.has(egg))
      throw new Error("Reviewed Mumble egg not found in manifest");
  const nests = new Set(batch.map((row) => row.nestId));
  if (
    !batch.length ||
    batch.length > 100 ||
    report.counts.allocations !==
      batch.length + report.secondaryAllocations.length ||
    report.counts.nodes !== nodes.size ||
    report.counts.eggs !== eggs.size ||
    report.counts.nests !== nests.size
  )
    throw new Error("Unsupported staging catalog scope");
  const accounts = report.userIds.map((id) => ({
    id,
    email: credentials.accounts.get(id) ?? "",
  }));
  if (
    credentials.accounts.size !== accounts.length ||
    accounts.some(
      ({ email }) => !/^([a-z0-9._+-]{1,64})@example\.test$/.test(email),
    ) ||
    new Set(accounts.map((row) => row.email)).size !== accounts.length
  )
    throw new Error("Invalid staging account mapping");
  const grants = report.grants.map((row) => ({
    userId: String(row.userId),
    serverId: String(row.serverId),
    permissions: [...row.permissions].sort(),
  }));
  const normalize = (list: typeof grants) =>
    [...list].sort(
      (a, b) =>
        a.serverId.localeCompare(b.serverId) ||
        a.userId.localeCompare(b.userId),
    );
  const serverIds = batch.map((row) => row.uuid);
  const placeholders = serverIds.map(() => "?").join(",");
  const secondary = report.secondaryAllocations.map(({ legacyId, ...row }) => {
    const allocationId = credentials.secondaryAllocations?.get(legacyId);
    if (!allocationId || !UUID_V4.test(allocationId) || !/^127\./.test(row.ip))
      throw new Error("Missing or unsupported secondary allocation mapping");
    return { ...row, allocationId };
  });
  const orderSecondary = (items: typeof secondary) =>
    [...items].sort((a, b) => a.allocationId.localeCompare(b.allocationId));
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
      `SELECT id FROM servers WHERE id IN (${placeholders}) ORDER BY id FOR UPDATE`,
      serverIds,
    );
    if (existing.length && existing.length !== batch.length)
      throw new Error("Partial Relay fixture conflicts with import");
    if (existing.length) {
      for (const {
        uuid,
        externalId,
        ownerId,
        nodeId,
        eggId,
        nestId,
        port,
        allocationId,
        node,
        token,
        document,
        maxUsers,
      } of batch) {
        const [matched] = await rows<{ cipher: Buffer }>(
          db,
          `SELECT n.token_cipher AS cipher FROM servers s
        JOIN nodes n ON n.id=s.node_id JOIN allocations a ON a.id=s.allocation_id AND a.node_id=s.node_id
        JOIN users u ON u.id=s.owner_id JOIN eggs e ON e.id=s.egg_id JOIN nests t ON t.id=e.nest_id
        JOIN wings_provisions p ON p.server_id=s.id
        WHERE s.id=? AND s.external_id <=> ? AND s.name=? AND s.owner_id=? AND u.password_hash='disabled' AND u.is_admin=0
        AND s.node_id=? AND n.origin=? AND n.token_id=? AND s.egg_id=? AND e.nest_id=? AND e.version='PTDL_v2' AND e.document=?
        AND s.mumble_max_users <=> ? AND s.allocation_id=? AND a.ip='127.0.0.1' AND a.port=? AND p.phase='installed' FOR UPDATE`,
          [
            uuid,
            externalId,
            name,
            ownerId,
            nodeId,
            node.origin,
            node.tokenId,
            eggId,
            nestId,
            document,
            maxUsers,
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
      for (const { id, email } of accounts) {
        const matched = await rows(
          db,
          "SELECT id FROM users WHERE id=? AND email=? AND password_hash='disabled' AND is_admin=0 FOR UPDATE",
          [id, email],
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
        `SELECT user_id AS userId,server_id AS serverId,permissions FROM server_grants WHERE server_id IN (${placeholders}) FOR UPDATE`,
        serverIds,
      );
      if (
        !isDeepStrictEqual(
          normalize(
            savedGrants
              .map((row) => ({
                ...row,
                permissions:
                  typeof row.permissions === "string"
                    ? JSON.parse(row.permissions)
                    : (row.permissions as string[]),
              }))
              .map((row) => ({
                ...row,
                permissions: [...row.permissions].sort(),
              })),
          ),
          normalize(grants),
        )
      )
        throw new Error("Existing Relay grants conflict with import");
      const existingSecondary = await rows<(typeof secondary)[number]>(
        db,
        `SELECT a.id AS allocationId, a.ip,a.port,a.node_id AS nodeId,x.server_id AS serverId FROM server_secondary_allocations x JOIN allocations a ON a.id=x.allocation_id WHERE x.server_id IN (${placeholders}) FOR UPDATE`,
        serverIds,
      );
      if (
        !isDeepStrictEqual(
          orderSecondary(existingSecondary),
          orderSecondary(secondary),
        )
      )
        throw new Error(
          "Existing Relay secondary allocations conflict with import",
        );
      return { applied: false, counts: report.counts };
    }
    for (const { id, email } of accounts)
      await db.execute(
        "INSERT INTO users (id,email,display_name,password_hash) VALUES (?,?,'Fixture','disabled')",
        [id, email],
      );
    for (const nestId of nests)
      await db.execute("INSERT INTO nests (id,name) VALUES (?,?)", [
        nestId,
        `Adoption ${nestId}`,
      ]);
    for (const { nodeId, node, token } of nodes.values())
      await db.execute(
        "INSERT INTO nodes (id,name,origin,token_id,token_cipher) VALUES (?,'Existing node',?,?,?)",
        [nodeId, node.origin, node.tokenId, crypto.seal(token, nodeId)],
      );
    for (const { eggId, nestId, document } of eggs.values())
      await db.execute(
        "INSERT INTO eggs (id,nest_id,name,version,document) VALUES (?,?,?,'PTDL_v2',?)",
        [eggId, nestId, `Adoption ${eggId}`, document],
      );
    for (const {
      uuid,
      externalId,
      ownerId,
      eggId,
      port,
      allocationId,
      nodeId,
      maxUsers,
    } of batch) {
      await db.execute(
        "INSERT INTO allocations (id,node_id,ip,port) VALUES (?,?,'127.0.0.1',?)",
        [allocationId, nodeId, port],
      );
      await db.execute(
        "INSERT INTO servers (id,name,node_id,owner_id,egg_id,allocation_id,external_id,mumble_max_users) VALUES (?,?,?,?,?,?,?,?)",
        [uuid, name, nodeId, ownerId, eggId, allocationId, externalId],
      );
      await db.execute(
        "INSERT INTO wings_provisions (server_id,phase) VALUES (?,'installed')",
        [uuid],
      );
    }
    for (const allocation of secondary) {
      await db.execute(
        "INSERT INTO allocations (id,node_id,ip,port) VALUES (?,?,?,?)",
        [
          allocation.allocationId,
          allocation.nodeId,
          allocation.ip,
          allocation.port,
        ],
      );
      await db.execute(
        "INSERT INTO server_secondary_allocations (allocation_id,server_id,node_id) VALUES (?,?,?)",
        [allocation.allocationId, allocation.serverId, allocation.nodeId],
      );
    }
    for (const grant of grants)
      await db.execute(
        "INSERT INTO server_grants (user_id,server_id,permissions) VALUES (?,?,?)",
        [grant.userId, grant.serverId, JSON.stringify(grant.permissions)],
      );
    return { applied: true, counts: report.counts };
  });
}
