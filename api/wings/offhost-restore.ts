import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createApp } from "../app";
import { rows, stagingPool } from "../db";
import { keyFrom } from "../security";
import { randomUUID } from "node:crypto";
import { checkpointRecord } from "./offhost-http-fixture";
import { offhostKey } from "./offhost-keys";
import { UUID_V4, WingsClient } from "./client";

async function main() {
  assert.equal(process.env.GITHUB_WORKFLOW, "Relay Wings off-host staging");
  assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.env.RELAY_DISPOSABLE_WINGS_CI, "1");
  const runtime = JSON.parse(
    await readFile(process.env.RELAY_OFFHOST_RUNTIME ?? "", "utf8"),
  );
  const { uuid, origin } = runtime;
  assert.equal(
    runtime.independentKeys,
    Boolean(process.env.RELAY_OFFHOST_RUNTIME_SEED),
  );
  if (runtime.independentKeys) assert.equal(runtime.legacyKeys, undefined);
  const node = {
    ...runtime.node,
    token: process.env.RELAY_WINGS_TEST_TOKEN ?? "",
  };
  assert.match(uuid, UUID_V4);
  assert.equal(node.origin, "http://127.0.0.1:18080");
  assert.equal(node.tokenId, "relaytestnode");
  const pool = stagingPool();
  const app = await createApp({
    pool,
    origin,
    key:
      offhostKey("identity") ??
      keyFrom(runtime.legacyKeys?.identityKey, "identityKey"),
    pepper:
      offhostKey("pepper") ?? keyFrom(runtime.legacyKeys?.pepper, "pepper"),
    catalogNodeKey:
      offhostKey("catalog") ?? keyFrom(runtime.legacyKeys?.key, "nodeKey"),
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
    const payload = await docker(
      "docker",
      [
        "exec",
        uuid,
        "sh",
        "-ec",
        `cd /home/container; set -- relay-pilot-data/*.bin; test "$#" -eq 2048; sha256sum "$@" | sha256sum`,
      ],
      { timeout: 25000 },
    );
    assert.match(runtime.payloadHash, /^[a-f0-9]{64}$/);
    assert.equal(payload.stdout.split(/\s/)[0], runtime.payloadHash);
    const port = Number(runtime.placement.port);
    assert.equal(port, 25610);
    assert.equal(runtime.placement.ip, "127.0.0.1");
    const endpoint = `http://127.0.0.1:${port}/cgi-bin/record`;
    const call = (body?: string) =>
      fetch(endpoint, {
        ...(body === undefined ? {} : { method: "POST", body }),
        signal: AbortSignal.timeout(2000),
      });
    async function readHttp(expected: string) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const response = await call().catch(() => null);
        if (response?.ok) {
          assert.equal(await response.text(), expected);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("Restored HTTP service unavailable");
    }
    await readHttp(checkpointRecord);
    const freshRecord = `restored-${randomUUID()}`;
    const write = await call(freshRecord);
    assert.equal(write.status, 200);
    assert.equal(await write.text(), freshRecord);
    await readHttp(freshRecord);
    await client.power(uuid, "stop");
    await waitState("offline");
    await client.power(uuid, "start");
    await waitState("running");
    await readHttp(freshRecord);
    const revoke = await app.inject({
      method: "POST",
      url: `/api/v1/servers/${uuid}/activity-access`,
      headers: { ...runtime.ownerSession, origin, "x-relay-request": "1" },
      payload: { email: "collaborator@example.test", action: "revoke" },
    });
    assert.equal(revoke.statusCode, 204);
    assert.equal((await activity(runtime.collaborator)).statusCode, 404);
    assert.equal((await activity(runtime.ownerSession)).statusCode, 200);
    const elapsed = Date.now() - Number(process.env.RELAY_OFFHOST_STARTED);
    assert.ok(
      elapsed >= 0 && elapsed <= 120_000,
      "Staging restore exercise exceeded 120 seconds",
    );
    assert.ok(
      runtime.checkpointToSimulatedLossMs >= 0 &&
        runtime.checkpointToSimulatedLossMs <= 30_000,
      "Staging simulated loss window exceeded 30 seconds",
    );
    console.log(
      `::notice::Relay Wings cross-host restore_ms=${elapsed} checkpoint_to_loss_ms=${runtime.checkpointToSimulatedLossMs} payload_bytes=268435456 files=2048 revocation_reapplied=true http_write_survived_restart=true independent_keys=${runtime.independentKeys}`,
    );
  } finally {
    await app.close();
    await pool.end();
  }
}
main().catch((error: unknown) => {
  const frame =
    error instanceof Error
      ? error.stack
          ?.split("\n")
          .find((line) => line.includes("offhost-restore.ts:"))
      : undefined;
  console.error("Relay/Wings isolated restore assertions failed", frame ?? "");
  process.exitCode = 1;
});
