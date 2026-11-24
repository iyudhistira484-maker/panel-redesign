import { timingSafeEqual } from "node:crypto";
import type { Pool } from "mysql2/promise";
import { transferLedger } from "../catalog/transfer";
import { rows } from "../db";
import { cryptoContext } from "../security";
import { validateNode, type WingsNode } from "./client";
import { transferDocuments, transferProfile } from "./transfer-profile";
import type { FixtureMode } from "../eggs/reviewed-workload";
import type { WorkloadProvider } from "./remote";

export type FixtureReceiver = {
  server: string;
  target: string;
  allocation: string;
};
export function createFixtureReceiver(
  pool: Pool,
  rawNode: WingsNode,
  key: Buffer,
  pepper: Buffer,
  fixture: FixtureReceiver,
  base: WorkloadProvider,
) {
  const node = validateNode(rawNode);
  const crypto = cryptoContext(key, pepper, "node-token");
  const ledger = transferLedger(pool);
  const expected = Buffer.from(node.token);
  async function scoped(id: string) {
    if (id !== fixture.server) return undefined;
    const entry = await ledger.placement(id, fixture.target);
    if (!entry || entry.target_allocation_id !== fixture.allocation)
      return undefined;
    const [result] = await rows<{
      name: string;
      eggId: string;
      port: number;
      cipher: Buffer;
      document: Buffer;
      mode: FixtureMode | null;
      maxUsers: string | null;
    }>(
      pool,
      `SELECT e.document,s.mumble_max_users AS maxUsers,s.fixture_mode AS mode,s.name,s.egg_id AS eggId,a.port,n.token_cipher AS cipher FROM servers s
    JOIN eggs e ON e.id=s.egg_id JOIN allocations a ON a.id=? AND a.node_id=? JOIN nodes n ON n.id=a.node_id
    WHERE s.id=? AND s.node_id=? AND e.document IN (?,?,?) AND a.ip='127.0.0.1' AND n.origin=? AND n.token_id=?`,
      [
        fixture.allocation,
        fixture.target,
        id,
        entry.source_node_id,
        ...transferDocuments,
        node.origin,
        node.tokenId,
      ],
    );
    if (!result) return undefined;
    const saved = crypto.open(result.cipher, fixture.target);
    return saved.length === expected.length && timingSafeEqual(saved, expected)
      ? result
      : undefined;
  }
  return {
    provider: {
      list: base.list,
      lookup: async (id) => {
        const pending = await scoped(id);
        if (pending)
          return transferProfile(pending.document)?.workload(
            () => {},
            {
              uuid: id,
              port: pending.port,
              name: pending.name,
              eggId: pending.eggId,
            },
            pending.mode,
            pending.maxUsers,
          );
        return base.lookup(id);
      },
    } satisfies WorkloadProvider,
    onTransfer: async (id: string, successful: boolean) =>
      Boolean(await scoped(id)) &&
      (!successful || (await ledger.reportDestination(id, fixture.target))),
  };
}
