import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import Fastify from "fastify";
import { createPool } from "mysql2/promise";
import { registerApplicationInventory } from "./application-compat";
import { registerClientCompatibility } from "./client-compat";
import { createProvisioner } from "./wings/provision";

const origin = "https://relay.example.test";
const normalize = (path: string) =>
  path
    .replace(/\{[^}]+\}|:[A-Za-z_][A-Za-z0-9_]*/g, ":param")
    .replace(/\/$/, "");

async function registered(withWings: boolean) {
  const app = Fastify();
  // Register routes only; no handlers are invoked and no database connection is opened.
  const pool = createPool({ host: "127.0.0.1", database: "relay_test" });
  const routes = new Set<string>();
  app.addHook("onRoute", ({ method, url }) => {
    for (const verb of [method].flat()) {
      if (verb !== "HEAD") routes.add(`${verb} ${normalize(url)}`);
    }
  });
  try {
    const wings = withWings
      ? createProvisioner(
          pool,
          {
            origin: "http://127.0.0.1:18080",
            tokenId: "paritynode",
            token: "0".repeat(64),
          },
          Buffer.alloc(32, 1),
          Buffer.alloc(32, 2),
          origin,
        )
      : undefined;
    registerClientCompatibility(
      app,
      pool,
      origin,
      async () => null,
      wings?.compatResources,
      wings
        ? (id, action, actor) => wings.power(id, action, actor, "compat")
        : undefined,
      wings?.compatCommand,
      wings?.compatStream,
      wings?.compatFiles,
    );
    registerApplicationInventory(
      app,
      pool,
      origin,
      () => Buffer.alloc(32),
      wings?.applicationCreate,
    );
    await app.ready();
    return routes;
  } finally {
    await app.close();
    await pool.end();
  }
}

async function main() {
  const base = await registered(false);
  const staging = await registered(true);
  const lines = [
    "# API route parity audit",
    "",
    "Baseline: Panel Pterodactyl v1.15.2 inventories. Generated from Relay route registrations (no network or DB handlers invoked). **Registered does not mean compatible**: permissions, response formats, lifecycle and supported workloads still need behavior tests. A Relay-native `/api/v1` endpoint does not count as a compatibility route.",
    "",
  ];
  for (const family of ["client", "application"]) {
    const upstream = await readFile(`docs/stage-0/api-${family}.md`, "utf8");
    const methods = [...upstream.matchAll(/^\| ([A-Z]+) \| `([^`]+)` \|$/gm)];
    assert.ok(methods.length > 0);
    const prefix = `/api/${family}`;
    const counts = { base: 0, staging: 0, missing: 0 };
    const entries = methods.map(([, method, path]) => {
      const signature = `${method} ${normalize(prefix + path)}`;
      const force = path.includes("{force?}");
      const status =
        !force && base.has(signature)
          ? "base"
          : !force && staging.has(signature)
            ? "staging"
            : "missing";
      counts[status]++;
      return `| ${method} | \`${path}\` | ${status === "base" ? "Registered" : status === "staging" ? "Disposable Wings only" : "Not registered"} |`;
    });
    lines.push(
      `## ${family}`,
      "",
      `${methods.length} upstream entries: **${counts.base} registered**, **${counts.staging} disposable Wings only**, **${counts.missing} not registered**.`,
      "",
      "| Method | Upstream path | Relay registration |",
      "| --- | --- | --- |",
      ...entries,
      "",
    );
  }
  lines.push(
    "See [replacement gates](pterodactyl-replacement.md) for UI, migration, operator and rollout work outside this API audit.",
    "",
  );
  const path = "docs/stage-10/api-parity-audit.md";
  const report = lines.join("\n");
  if (process.argv.includes("--write")) await writeFile(path, report);
  else
    assert.equal(
      await readFile(path, "utf8"),
      report,
      "Update the API audit with npx tsx api/parity-audit.ts --write",
    );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
