import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createApp } from "../app";
import { rows, stagingPool } from "../db";
import { keyFrom } from "../security";
import { UUID_V4, WingsClient } from "./client";

async function main() {
  assert.equal(process.env.GITHUB_WORKFLOW, "Relay Wings off-host staging");
  assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.env.RELAY_DISPOSABLE_WINGS_CI, "1");
  const runtime = JSON.parse(
    await readFile(process.env.RELAY_OFFHOST_RUNTIME ?? "", "utf8"),
  );
  const { uuid, node, origin } = runtime;
  assert.match(uuid, UUID_V4);
  assert.equal(node.origin, "http://127.0.0.1:18080");
  assert.equal(node.tokenId, "relaytestnode");
  const pool = stagingPool();
  const app = await createApp({
    pool,
    origin,
    key: keyFrom(runtime.identityKey, "identityKey"),
    pepper: keyFrom(runtime.pepper, "pepper"),
    catalogNodeKey: keyFrom(runtime.key, "nodeKey"),
    allowedCatalogNodeOrigins: [node.origin],
    wingsTestNode: node,
    enableDisposableProvisioning: true,
    deliverReset: async () => {
      throw new Error("Mail disabled in recovery rehearsal");
    },
  });
  const client = new WingsClient(node);
  const docker = promisify(execFile);
  async function waitState(state: string) {
    for (let i = 0; i < 40; i++) {
      if ((await client.state(uuid).catch(() => null)) === state) return;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    throw new Error(`Restored workload did not reach ${state}`);
  }
  try {
    await app.listen({ host: "127.0.0.1", port: 13200 });
    const placement = await rows(
      pool,
      `SELECT s.id,s.application_id,s.external_id,s.name,s.owner_id,s.node_id,a.id AS allocation,a.ip,a.port,p.phase FROM servers s JOIN allocations a ON a.id=s.allocation_id JOIN wings_provisions p ON p.server_id=s.id WHERE s.id=?`,
      [uuid],
    );
    assert.deepEqual(placement, [runtime.placement]);
    assert.equal(
      (
        await app.inject({
          url: `/api/client/servers/${uuid}`,
          headers: { authorization: `Bearer ${runtime.relayKey}` },
        })
      ).statusCode,
      200,
    );
    const activity = (headers: { cookie: string }) =>
      app.inject({ url: `/api/v1/servers/${uuid}/activity`, headers });
    assert.equal((await activity(runtime.collaborator)).statusCode, 200);
    assert.equal((await activity(runtime.outsider)).statusCode, 404);
    await waitState("offline");
    const bytes = await client.fixtureDownload(
      uuid,
      ["fixture-docs"],
      "example.txt",
    );
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      runtime.checkpointHash,
    );
    assert.notEqual(runtime.checkpointHash, runtime.newerHash);
    await client.power(uuid, "start");
    await waitState("running");
    const { stdout } = await docker(
      "docker",
      ["exec", uuid, "sha256sum", "/home/container/fixture-docs/example.txt"],
      { timeout: 5000 },
    );
    assert.equal(stdout.split(/\s/)[0], runtime.checkpointHash);
    const mount = await docker(
      "docker",
      [
        "inspect",
        "--format",
        '{{range .Mounts}}{{if eq .Destination "/home/container"}}{{.Source}}{{end}}{{end}}',
        uuid,
      ],
      { timeout: 5000 },
    );
    assert.equal(
      mount.stdout.trim(),
      `${process.env.RELAY_WINGS_CONTRACT_DATA}/${uuid}`,
    );
    console.log(
      `::notice::Relay Wings cross-host restore_ms=${Date.now() - Number(process.env.RELAY_OFFHOST_STARTED)} checkpoint_file_verified=true checkpoint_grant_restored=true`,
    );
  } finally {
    await app.close();
    await pool.end();
  }
}
main().catch(() => {
  console.error("Relay/Wings isolated restore assertions failed");
  process.exitCode = 1;
});
