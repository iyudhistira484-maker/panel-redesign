import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerRemote } from "./remote";
import { WingsClient, type WingsNode } from "./client";

async function main() {
  if (process.env.RELAY_DISPOSABLE_WINGS_CI !== "1")
    throw new Error("Disposable CI only");
  const node: WingsNode = {
    origin: "http://127.0.0.1:18080",
    tokenId: process.env.RELAY_WINGS_TEST_TOKEN_ID ?? "",
    token: process.env.RELAY_WINGS_TEST_TOKEN ?? "",
  };
  const app = Fastify({ logger: false });
  const successes = new Set<string>();
  app.addHook("onResponse", async (request, reply) => {
    if (reply.statusCode < 300 && request.routeOptions.url)
      successes.add(request.routeOptions.url);
  });
  await app.register((instance) => registerRemote(instance, node), {
    prefix: "/api/remote",
  });
  await app.listen({ host: "127.0.0.1", port: 13200 });
  try {
    const client = new WingsClient(node);
    for (let attempt = 0; attempt < 35; attempt++) {
      let health: Awaited<ReturnType<WingsClient["health"]>> | undefined;
      try {
        health = await client.health();
      } catch {
        /* daemon may still be booting */
      }
      if (
        health &&
        successes.has("/api/remote/servers") &&
        successes.has("/api/remote/servers/reset")
      ) {
        const anonymous = await fetch(`${node.origin}/api/system`, {
          signal: AbortSignal.timeout(3000),
        });
        assert.equal(anonymous.status, 401);
        await anonymous.body?.cancel();
        console.log(
          `Wings ${health.version}: authenticated system info, bootstrap list and reset verified`,
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(
      `Daemon contract timed out; successful callback paths: ${[...successes].join(", ") || "none"}`,
    );
  } finally {
    await app.close();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Wings test failed");
  process.exitCode = 1;
});
