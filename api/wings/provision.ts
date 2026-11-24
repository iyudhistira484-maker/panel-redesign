import { timingSafeEqual } from "node:crypto";
import type { Pool } from "mysql2/promise";
import { rows, transaction, type Executor } from "../db";
import type { Actor } from "../policy";
import { cryptoContext } from "../security";
import { validateNode, WingsClient, type WingsNode } from "./client";
import { lifecycleFixture } from "./lifecycle-fixture";
import type { WorkloadProvider } from "./remote";

// Exact allowlisted document. Imported scripts and images are NEVER executed in this slice.
export const disposableEgg = JSON.stringify({
  meta: { version: "PTDL_v2" },
  name: "Relay Disposable Shell",
  docker_images: { Shell: "~relay-wings-contract-workload:ci" },
  config: {},
  scripts: { installation: {} },
  variables: [],
});
export type Phase =
  | "dispatching"
  | "installing"
  | "installed"
  | "install_failed"
  | "uncertain";
type ServerRow = {
  uuid: string;
  name: string;
  port: number;
  eggId: string;
  document: Buffer;
  origin: string;
  tokenId: string;
  cipher: Buffer;
  nodeId: string;
  phase: Phase | null;
};
const select = `SELECT s.id AS uuid,s.name,a.port,s.egg_id AS eggId,e.document,n.origin,n.token_id AS tokenId,n.token_cipher AS cipher,n.id AS nodeId,p.phase
 FROM servers s JOIN nodes n ON n.id=s.node_id JOIN allocations a ON a.id=s.allocation_id JOIN eggs e ON e.id=s.egg_id LEFT JOIN wings_provisions p ON p.server_id=s.id`;
export class ProvisionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export function createProvisioner(
  pool: Pool,
  rawNode: WingsNode,
  key: Buffer,
  pepper: Buffer,
) {
  const node = validateNode(rawNode);
  const crypt = cryptoContext(key, pepper, "node-token");
  const client = new WingsClient(node);
  const fromNode = (s: ServerRow) => {
    if (s.origin !== node.origin || s.tokenId !== node.tokenId) return false;
    const saved = crypt.open(s.cipher, s.nodeId),
      expected = Buffer.from(node.token);
    return saved.length === expected.length && timingSafeEqual(saved, expected);
  };
  const load = async (db: Executor, id: string, lock = false) =>
    (
      await rows<ServerRow>(
        db,
        `${select} WHERE s.id=?${lock ? " FOR UPDATE" : ""}`,
        [id],
      )
    )[0];
  const eligible = (s: ServerRow) =>
    fromNode(s) && s.document.equals(Buffer.from(disposableEgg));
  async function installStatus(
    server: ServerRow,
    result: { successful: boolean; reinstall: boolean },
  ) {
    if (result.reinstall) return;
    await transaction(pool, async (db) => {
      const current = await load(db, server.uuid, true);
      if (
        !current ||
        !eligible(current) ||
        !current.phase ||
        !["dispatching", "installing", "uncertain"].includes(current.phase)
      )
        return;
      const phase = result.successful ? "installed" : "install_failed";
      await db.execute(
        "UPDATE wings_provisions SET phase=? WHERE server_id=?",
        [phase, server.uuid],
      );
      await db.execute(
        "INSERT INTO audit_log (event,subject_id) VALUES (?,?)",
        [`wings.${phase}`, server.uuid],
      );
    });
  }
  const workload = (s: ServerRow) =>
    lifecycleFixture((result) => installStatus(s, result), s);
  const provider: WorkloadProvider = {
    lookup: async (id) => {
      const s = await load(pool, id);
      return s?.phase && eligible(s) ? workload(s) : undefined;
    },
    list: async (page, perPage) => {
      // Only the configured test node is served. The catalog enforces unique origin/token ID.
      const registered = (
        await rows<{ token_cipher: Buffer; id: string }>(
          pool,
          "SELECT id,token_cipher FROM nodes WHERE origin=? AND token_id=?",
          [node.origin, node.tokenId],
        )
      )[0];
      if (!registered) return { data: [], total: 0 };
      const decrypted = crypt.open(registered.token_cipher, registered.id),
        expected = Buffer.from(node.token);
      if (
        decrypted.length !== expected.length ||
        !timingSafeEqual(decrypted, expected)
      )
        return { data: [], total: 0 };
      const scoped = "s.node_id=? AND p.phase='installed' AND e.document=?";
      const args = [registered.id, Buffer.from(disposableEgg)];
      const total = (
        await rows<{ total: number }>(
          pool,
          `SELECT COUNT(*) AS total FROM (${select} WHERE ${scoped}) AS installed`,
          args,
        )
      )[0].total;
      const records = await rows<ServerRow>(
        pool,
        `${select} WHERE ${scoped} ORDER BY s.id LIMIT ? OFFSET ?`,
        [...args, perPage, (page - 1) * perPage],
      );
      return {
        total,
        data: records.map((s) => ({
          uuid: s.uuid,
          ...workload(s).configuration,
        })),
      };
    },
  };
  return {
    provider,
    async provision(id: string, actor: Actor) {
      // Lock the server before writing a durable dispatch marker. Do not hold DB locks during network calls.
      await transaction(pool, async (db) => {
        const s = await load(db, id, true);
        if (!s) throw new ProvisionError(404, "server_not_found");
        const role = (
          await rows<{ is_admin: number }>(
            db,
            "SELECT is_admin FROM users WHERE id=? FOR UPDATE",
            [actor.id],
          )
        )[0];
        if (!role?.is_admin || actor.channel !== "session")
          throw new ProvisionError(403, "forbidden");
        if (s.phase)
          throw new ProvisionError(409, "provision_already_dispatched");
        if (!eligible(s))
          throw new ProvisionError(422, "disposable_fixture_required");
        await db.execute(
          "INSERT INTO wings_provisions (server_id,phase) VALUES (?,'dispatching')",
          [id],
        );
        await db.execute(
          "INSERT INTO audit_log (actor_id,event,subject_id) VALUES (?,'wings.provision_requested',?)",
          [actor.id, id],
        );
      });
      let next: Phase = "installing";
      try {
        await client.create(id);
      } catch {
        next = "uncertain";
      }
      // A callback can win the race before create returns. Never overwrite a terminal result.
      await pool.execute(
        "UPDATE wings_provisions SET phase=? WHERE server_id=? AND phase='dispatching'",
        [next, id],
      );
      return (await load(pool, id))?.phase ?? next;
    },
  };
}
