import { rows } from "../db";
import { transferProfile } from "./transfer-profile";
import type { Pool } from "mysql2/promise";
import { transferLedger } from "../catalog/transfer";
import { WingsClient, type WingsNode } from "./client";
import { signTransferCapability } from "./transfer-token";

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
  async function profile(id: string) {
    const [egg] = await rows<{ document: Buffer }>(
      pool,
      "SELECT e.document FROM eggs e JOIN servers s ON s.egg_id=e.id WHERE s.id=?",
      [id],
    );
    return egg && transferProfile(egg.document);
  }
  return {
    async dispatch(id: string) {
      const entry = await ledger.pending(id);
      if (
        !entry ||
        !matches(entry) ||
        (await from.state(entry.server_id)) !== "offline"
      )
        return false;
      const workload = await profile(entry.server_id);
      if (!workload) return false;
      const file = await from.readFixtureFile(entry.server_id, workload.path);
      if (!file.includes(workload.marker)) return false;
      const fingerprint = await from.transferTreeDigest(entry.server_id);
      if ((await from.state(entry.server_id)) !== "offline") return false;
      const capability = signTransferCapability(
        target.node,
        issuer,
        entry.server_id,
      );
      if (!(await ledger.claim(id, fingerprint))) return false;
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
      const workload = await profile(entry.server_id);
      if (!workload) return false;
      if ((await from.state(entry.server_id)) !== "offline") return false;
      const [destination, original] = await Promise.all([
        to.transferTreeDigest(entry.server_id),
        from.transferTreeDigest(entry.server_id),
      ]);
      if (
        destination !== entry.fixture_digest ||
        original !== entry.fixture_digest ||
        (await from.state(entry.server_id)) !== "offline" ||
        (await to.state(entry.server_id)) !== "offline"
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
