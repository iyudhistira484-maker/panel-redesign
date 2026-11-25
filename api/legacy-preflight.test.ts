import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { legacyPreflight } from "./import/legacy-preflight";

const fixture = () => ({
  users: [{ id: 1, uuid: randomUUID() }],
  subusers: [] as {
    id: number;
    user_id: number;
    server_id: number;
    permissions: string[];
  }[],
  nodes: [{ id: 2, uuid: randomUUID() }],
  nests: [{ id: 3, uuid: randomUUID() }],
  eggs: [{ id: 4, uuid: randomUUID(), nest_id: 3 }],
  allocations: [
    { id: 5, node_id: 2, server_id: 6, ip: "127.0.0.1", port: 25610 },
  ],
  servers: [
    {
      id: 6,
      uuid: randomUUID(),
      owner_id: 1,
      node_id: 2,
      egg_id: 4,
      nest_id: 3,
      allocation_id: 5,
      status: null as string | null,
      installed_at: "2026-11-24 00:00:00",
    },
  ],
});

test("legacy preflight is deterministic and preserves mapped UUIDs without changing input", () => {
  const manifest = fixture();
  const original = structuredClone(manifest);
  const report = legacyPreflight(manifest);
  assert.deepEqual(report, legacyPreflight(manifest));
  assert.deepEqual(manifest, original);
  assert.deepEqual(report.servers, [
    {
      uuid: manifest.servers[0].uuid,
      externalId: null,
      ownerId: manifest.users[0].uuid,
      nodeId: manifest.nodes[0].uuid,
      eggId: manifest.eggs[0].uuid,
      nestId: manifest.nests[0].uuid,
      port: 25610,
    },
  ]);
});

test("legacy preflight rejects duplicate identities, cross-linked allocations, active operations and extra fields", () => {
  const duplicate = fixture();
  duplicate.nodes.push({ ...duplicate.nodes[0], id: 9 });
  assert.throws(() => legacyPreflight(duplicate), /Invalid legacy UUID/);
  const orphan = fixture();
  orphan.allocations[0].server_id = 7;
  assert.throws(
    () => legacyPreflight(orphan),
    /Invalid legacy allocation owner/,
  );
  const installing = fixture();
  installing.servers[0].status = "installing";
  assert.throws(() => legacyPreflight(installing), /not installed and normal/);
  const extras = fixture();
  Object.assign(extras.nodes[0], { token: "not-permitted" });
  assert.throws(() => legacyPreflight(extras), /Invalid legacy row/);
});

test("permission preflight preserves server scope and denies unknown or duplicate grants", () => {
  const manifest = fixture();
  const delegate = randomUUID();
  manifest.users.push({ id: 7, uuid: delegate });
  const grant = {
    id: 1,
    user_id: 7,
    server_id: 6,
    permissions: ["file.read", "control.start"],
  };
  manifest.subusers.push(grant);
  assert.deepEqual(legacyPreflight(manifest).grants, [
    {
      userId: delegate,
      serverId: manifest.servers[0].uuid,
      permissions: grant.permissions,
    },
  ]);
  manifest.subusers.push({ ...grant, id: 2 });
  assert.throws(
    () => legacyPreflight(manifest),
    /Duplicate legacy grant scope/,
  );
  manifest.subusers.pop();
  grant.permissions.push("*");
  assert.throws(
    () => legacyPreflight(manifest),
    /Unsupported legacy permission grant/,
  );
});
