import { disposableEgg } from "./provision";
import type { Pool } from "mysql2/promise";
import type { FixtureTransfer } from "../catalog/routes";
import { rows } from "../db";
import { cryptoContext } from "../security";
import { UUID_V4, validateNode, type WingsNode } from "./client";
import type { FixtureReceiver } from "./transfer-receiver";
import { fixtureTransferService } from "./transfer-service";

type Settings = {
  role: "source" | "destination";
  server: string;
  source: string;
  target: string;
  allocation: string;
  issuer: string;
};
export function parseStagingTransfer(
  env: NodeJS.ProcessEnv,
): Settings | undefined {
  const role = env.RELAY_FIXTURE_TRANSFER_ROLE;
  if (!role || role === "off") return undefined;
  if (
    (role !== "source" && role !== "destination") ||
    env.RELAY_ENV !== "staging" ||
    env.RELAY_ENABLE_DISPOSABLE_PROVISIONING !== "1" ||
    env.RELAY_ENABLE_EMPTY_WINGS_TEST_NODE !== "1"
  )
    throw new Error("Transfer requires disposable staging configuration");
  const [server, source, target, allocation] = [
    env.RELAY_FIXTURE_TRANSFER_SERVER,
    env.RELAY_FIXTURE_TRANSFER_SOURCE,
    env.RELAY_FIXTURE_TRANSFER_TARGET,
    env.RELAY_FIXTURE_TRANSFER_ALLOCATION,
  ];
  if (
    !server ||
    !source ||
    !target ||
    !allocation ||
    ![server, source, target, allocation].every((value) =>
      UUID_V4.test(value),
    ) ||
    source === target
  )
    throw new Error("Invalid fixture transfer identifiers");
  const issuer = env.RELAY_ORIGIN ?? "";
  if (!issuer.startsWith("https://") || new URL(issuer).origin !== issuer)
    throw new Error("Invalid staging issuer");
  return { role, server, source, target, allocation, issuer };
}
export async function loadStagingTransfer(
  pool: Pool,
  settings: Settings | undefined,
  local: WingsNode | undefined,
  key: Buffer | undefined,
  pepper: Buffer,
): Promise<{
  fixtureTransfer?: FixtureTransfer;
  fixtureReceiver?: FixtureReceiver;
}> {
  if (!settings) return {};
  if (!local || !key)
    throw new Error("Missing staging node credential configuration");
  const [database] = await rows<{ name: string }>(
    pool,
    "SELECT DATABASE() AS name",
  );
  if (!/^relay_(test|staging)(_[a-z0-9]+)?$/.test(database?.name ?? ""))
    throw new Error("Dedicated staging database required");
  const crypt = cryptoContext(key, pepper, "node-token");
  const resolve = async (id: string) => {
    const [saved] = await rows<{
      origin: string;
      token_id: string;
      token_cipher: Buffer;
    }>(pool, "SELECT origin,token_id,token_cipher FROM nodes WHERE id=?", [id]);
    if (!saved) throw new Error("Fixture node missing");
    return {
      id,
      node: validateNode({
        origin: saved.origin,
        tokenId: saved.token_id,
        token: crypt.open(saved.token_cipher, id).toString("utf8"),
      }),
    };
  };
  const source = await resolve(settings.source),
    target = await resolve(settings.target);
  const active = settings.role === "source" ? source.node : target.node;
  if (
    active.origin !== local.origin ||
    active.tokenId !== local.tokenId ||
    active.token !== local.token
  )
    throw new Error("Fixture node credential mismatch");
  const [fixture] = await rows(
    pool,
    "SELECT s.id FROM servers s JOIN allocations a ON a.id=? AND a.node_id=? JOIN eggs e ON e.id=s.egg_id WHERE s.id=? AND s.node_id IN (?,?) AND a.ip='127.0.0.1' AND e.document=?",
    [
      settings.allocation,
      settings.target,
      settings.server,
      settings.source,
      settings.target,
      Buffer.from(disposableEgg),
    ],
  );
  if (!fixture) throw new Error("Fixture placement missing");
  if (settings.role === "destination")
    return {
      fixtureReceiver: {
        server: settings.server,
        target: settings.target,
        allocation: settings.allocation,
      },
    };
  const service = fixtureTransferService(pool, source, target, settings.issuer);
  return {
    fixtureTransfer: {
      server: settings.server,
      source: settings.source,
      target: settings.target,
      allocation: settings.allocation,
      ...service,
    },
  };
}
