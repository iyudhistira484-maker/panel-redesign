import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { WingsClient, type WingsNode } from "./client";
import { lifecycleFixture } from "./lifecycle-fixture";
import { registerRemote } from "./remote";
import { signTransferCapability } from "./transfer-token";

const issuer = "http://127.0.0.1:13201";
async function eventually(label: string, fn: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 45; i++) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`Transfer contract did not reach ${label}`);
}
async function main() {
  if (
    process.env.RELAY_DISPOSABLE_WINGS_CI !== "1" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    process.env.GITHUB_EVENT_NAME !== "push"
  )
    throw new Error("Disposable CI only");
  const node = (
    port: number,
    tokenId: string,
    token: string | undefined,
  ): WingsNode => ({
    origin: `http://127.0.0.1:${port}`,
    tokenId,
    token: token ?? "",
  });
  const source = node(
    18180,
    "relaytransfersource",
    process.env.RELAY_TRANSFER_SOURCE_TOKEN,
  );
  const target = node(
    18181,
    "relaytransfertarget",
    process.env.RELAY_TRANSFER_TARGET_TOKEN,
  );
  let installed: boolean | undefined;
  let completion: boolean | undefined;
  let failure = false;
  let transferring = false;
  const fixture = lifecycleFixture((result) => {
    installed = result.successful;
  });
  const destination = lifecycleFixture(() => {}, {
    uuid: fixture.uuid,
    port: 25611,
    name: "Transfer destination fixture",
    eggId: "498aa323-143b-4ab2-ad9e-f3b711450fd0",
  });
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  await app.register(
    (instance) =>
      registerRemote(instance, source, fixture, undefined, (id, ok) => {
        if (id !== fixture.uuid || ok || !transferring) return false;
        failure = true;
        return true;
      }),
    { prefix: "/source/api/remote" },
  );
  await app.register(
    (instance) =>
      registerRemote(
        instance,
        target,
        undefined,
        {
          lookup: async (id) =>
            transferring && id === fixture.uuid ? destination : undefined,
          list: async () => ({ data: [], total: 0 }),
        },
        (id, ok) => {
          if (id !== fixture.uuid || !transferring) return false;
          completion ??= ok;
          return true;
        },
      ),
    { prefix: "/target/api/remote" },
  );
  try {
    await app.listen({ port: 13201, host: "127.0.0.1" });
    const from = new WingsClient(source),
      to = new WingsClient(target);
    for (const client of [from, to])
      await eventually("daemon health", async () => {
        try {
          await client.health();
          return true;
        } catch {
          return false;
        }
      });
    await from.create(fixture.uuid);
    await eventually("source installation", () => installed !== undefined);
    assert.equal(installed, true);
    assert.equal(await from.state(fixture.uuid), "offline");
    const digest = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    const original = await from.readFixtureFile(fixture.uuid, "relay-start.sh");
    assert.ok(original.includes("RELAY_CONTRACT_READY"));
    const forged = await app.inject({
      method: "POST",
      url: `/target/api/remote/servers/${fixture.uuid}/transfer/success`,
      headers: { authorization: `Bearer ${source.tokenId}.${source.token}` },
    });
    assert.equal(forged.statusCode, 401);
    transferring = true;
    const sourceToken = signTransferCapability(source, issuer, fixture.uuid);
    const rejected = await fetch(`${target.origin}/api/transfers`, {
      method: "POST",
      headers: { authorization: `Bearer ${sourceToken}` },
      signal: AbortSignal.timeout(3000),
    });
    assert.ok(!rejected.ok);
    await rejected.body?.cancel();
    assert.equal(completion, undefined);
    await from.transferTo(
      fixture.uuid,
      target,
      signTransferCapability(target, issuer, fixture.uuid),
    );
    await eventually(
      "destination callback",
      () => failure || completion !== undefined,
    );
    assert.equal(failure, false);
    assert.equal(completion, true);
    assert.equal(await to.state(fixture.uuid), "offline");
    assert.equal(
      digest(await to.readFixtureFile(fixture.uuid, "relay-start.sh")),
      digest(original),
    );
    assert.equal(
      digest(await from.readFixtureFile(fixture.uuid, "relay-start.sh")),
      digest(original),
    );
    await to.remove(fixture.uuid);
    await from.remove(fixture.uuid);
    console.log(
      "Wings-to-Wings transfer verified on independent Docker engines; archive matched and source preserved before cleanup",
    );
  } finally {
    await app.close();
  }
}
void main().catch((error) => {
  console.error(
    `::error::${error instanceof Error ? error.message : "Transfer contract failed"}`,
  );
  process.exitCode = 1;
});
