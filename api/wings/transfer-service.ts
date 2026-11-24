import { createHash } from "node:crypto";
import type { Pool } from "mysql2/promise";
import { transferLedger } from "../catalog/transfer";
import { WingsClient, type WingsNode } from "./client";
import { signTransferCapability } from "./transfer-token";

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
type Endpoint = { id: string; node: WingsNode };

/** Internal fixture orchestration. Callers must resolve the two trusted staging endpoints. */
export function fixtureTransferService(
  pool: Pool,
  source: Endpoint,
  target: Endpoint,
  issuer: string,
) {
  const ledger = transferLedger(pool);
  const from = new WingsClient(source.node),
    to = new WingsClient(target.node);
  const matches = (entry: { source_node_id: string; target_node_id: string }) =>
    entry.source_node_id === source.id && entry.target_node_id === target.id;
  return {
    async dispatch(id: string) {
      const entry = await ledger.pending(id);
      if (
        !entry ||
        !matches(entry) ||
        (await from.state(entry.server_id)) !== "offline"
      )
        return false;
      const file = await from.readFixtureFile(
        entry.server_id,
        "relay-start.sh",
      );
      if (!file.includes("RELAY_CONTRACT_READY")) return false;
      const capability = signTransferCapability(
        target.node,
        issuer,
        entry.server_id,
      );
      if (!(await ledger.claim(id, digest(file)))) return false;
      try {
        await from.transferTo(entry.server_id, target.node, capability);
        return true;
      } catch (error) {
        await ledger.settle(id, { kind: "ambiguous" });
        throw error;
      }
    },
    async finalize(id: string, actorId: string) {
      const entry = await ledger.reported(id);
      if (
        !entry ||
        !matches(entry) ||
        !entry.fixture_digest ||
        (await to.state(entry.server_id)) !== "offline"
      )
        return false;
      const destination = await to.readFixtureFile(
        entry.server_id,
        "relay-start.sh",
      );
      const original = await from.readFixtureFile(
        entry.server_id,
        "relay-start.sh",
      );
      if (
        digest(destination) !== entry.fixture_digest ||
        digest(original) !== entry.fixture_digest
      )
        return false;
      return ledger.settle(id, {
        kind: "verified_destination",
        node: target.id,
        actorId,
        server: entry.server_id,
      });
    },
  };
}
