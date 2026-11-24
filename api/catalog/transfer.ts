import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection } from "mysql2/promise";
import { rows, transaction } from "../db";

export async function lockFreeAllocation(
  db: PoolConnection,
  node: string,
  id: string,
) {
  if (
    !(
      await rows(
        db,
        "SELECT id FROM allocations WHERE id=? AND node_id=? FOR UPDATE",
        [id, node],
      )
    ).length
  )
    return false;
  if (
    (
      await rows(
        db,
        "SELECT id FROM servers WHERE allocation_id=? FOR UPDATE",
        [id],
      )
    ).length
  )
    return false;
  return !(
    await rows(
      db,
      "SELECT id FROM wings_transfers WHERE active_allocation=? FOR UPDATE",
      [id],
    )
  ).length;
}
type Transfer = {
  id: string;
  server_id: string;
  source_node_id: string;
  source_allocation_id: string;
  target_node_id: string;
  target_allocation_id: string;
  phase: "reserved" | "uncertain" | "completed" | "cancelled";
};
/** Internal persistence only. No dispatch, public route, or caller-controlled proof. */
export function transferLedger(pool: Pool) {
  return {
    async reserve(server: string, node: string, allocation: string) {
      return transaction(pool, async (db) => {
        const [current] = await rows<{
          node_id: string;
          allocation_id: string;
          phase: string;
        }>(
          db,
          "SELECT s.node_id,s.allocation_id,p.phase FROM servers s JOIN wings_provisions p ON p.server_id=s.id WHERE s.id=? FOR UPDATE",
          [server],
        );
        if (
          !current ||
          current.phase !== "installed" ||
          current.node_id === node ||
          !(await lockFreeAllocation(db, node, allocation))
        )
          return undefined;
        const id = randomUUID();
        await db.execute(
          "INSERT INTO wings_transfers (id,server_id,source_node_id,source_allocation_id,target_node_id,target_allocation_id,phase) VALUES (?,?,?,?,?,?,'reserved')",
          [
            id,
            server,
            current.node_id,
            current.allocation_id,
            node,
            allocation,
          ],
        );
        await db.execute(
          "UPDATE wings_provisions SET phase='transferring' WHERE server_id=?",
          [server],
        );
        return id;
      });
    },
    async settle(
      id: string,
      result:
        | { kind: "not_dispatched" }
        | { kind: "ambiguous" }
        | { kind: "verified_destination"; node: string; server: string },
    ) {
      return transaction(pool, async (db) => {
        const [entry] = await rows<Transfer>(
          db,
          "SELECT * FROM wings_transfers WHERE id=? FOR UPDATE",
          [id],
        );
        if (!entry || entry.phase !== "reserved") return false;
        if (result.kind === "ambiguous") {
          await db.execute(
            "UPDATE wings_transfers SET phase='uncertain' WHERE id=?",
            [id],
          );
          return true;
        }
        const [current] = await rows<{
          node_id: string;
          allocation_id: string;
          phase: string;
        }>(
          db,
          "SELECT s.node_id,s.allocation_id,p.phase FROM servers s JOIN wings_provisions p ON p.server_id=s.id WHERE s.id=? FOR UPDATE",
          [entry.server_id],
        );
        if (
          !current ||
          current.phase !== "transferring" ||
          current.node_id !== entry.source_node_id ||
          current.allocation_id !== entry.source_allocation_id
        )
          return false;
        if (result.kind === "verified_destination") {
          if (
            result.node !== entry.target_node_id ||
            result.server !== entry.server_id
          )
            return false;
          await db.execute(
            "UPDATE servers SET node_id=?,allocation_id=? WHERE id=?",
            [entry.target_node_id, entry.target_allocation_id, entry.server_id],
          );
        }
        await db.execute(
          "UPDATE wings_provisions SET phase='installed' WHERE server_id=?",
          [entry.server_id],
        );
        await db.execute("UPDATE wings_transfers SET phase=? WHERE id=?", [
          result.kind === "not_dispatched" ? "cancelled" : "completed",
          id,
        ]);
        return true;
      });
    },
  };
}
