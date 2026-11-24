import { isIP } from "node:net";
import { serverPermissions } from "../policy";
import { UUID_V4 } from "../wings/client";

const tables = [
  "servers",
  "users",
  "nodes",
  "nests",
  "eggs",
  "allocations",
  "subusers",
] as const;
type Table = (typeof tables)[number];
type Row = Record<string, unknown>;
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const record = (value: unknown): value is Row =>
  !!value && typeof value === "object" && !Array.isArray(value);
export const legacyColumns: Record<Table, string[]> = {
  servers: [
    "id",
    "uuid",
    "owner_id",
    "node_id",
    "egg_id",
    "nest_id",
    "allocation_id",
    "status",
    "installed_at",
  ],
  users: ["id", "uuid"],
  nodes: ["id", "uuid"],
  nests: ["id", "uuid"],
  eggs: ["id", "uuid", "nest_id"],
  allocations: ["id", "node_id", "server_id", "ip", "port"],
  subusers: ["id", "user_id", "server_id", "permissions"],
};

/** Read-only qualification of the allowlisted manifest schema, not a SQL dump parser. */
export function legacyPreflight(input: unknown) {
  if (!record(input) || Object.keys(input).length !== tables.length)
    throw new Error("Invalid legacy manifest");
  const map = new Map<Table, Map<number, Row>>();
  for (const table of tables) {
    const values = input[table];
    if (!Array.isArray(values) || values.length > 10000)
      throw new Error(`Invalid legacy table: ${table}`);
    const byId = new Map<number, Row>(),
      uuids = new Set<string>();
    for (const item of values) {
      if (
        !record(item) ||
        Object.keys(item).length !== legacyColumns[table].length ||
        !legacyColumns[table].every((key) => Object.hasOwn(item, key)) ||
        !integer(item.id) ||
        byId.has(item.id)
      )
        throw new Error(`Invalid legacy row: ${table}`);
      if (table !== "allocations" && table !== "subusers") {
        if (
          typeof item.uuid !== "string" ||
          !UUID_V4.test(item.uuid) ||
          uuids.has(item.uuid)
        )
          throw new Error(`Invalid legacy UUID: ${table}`);
        uuids.add(item.uuid);
      }
      byId.set(item.id, item);
    }
    map.set(table, byId);
  }
  const get = (table: Table, id: unknown) =>
    integer(id) ? map.get(table)?.get(id) : undefined;
  for (const egg of map.get("eggs")?.values() ?? [])
    if (!get("nests", egg.nest_id)) throw new Error("Invalid legacy egg nest");
  const secondaryAllocations = [];
  const allocationAddresses = new Set<string>();
  for (const allocation of map.get("allocations")?.values() ?? []) {
    if (
      typeof allocation.ip !== "string" ||
      !isIP(allocation.ip) ||
      !integer(allocation.port) ||
      allocation.port > 65535 ||
      !get("nodes", allocation.node_id)
    )
      throw new Error("Invalid legacy allocation");
    if (
      allocation.server_id !== null &&
      get("servers", allocation.server_id)?.node_id !== allocation.node_id
    )
      throw new Error("Invalid legacy allocation owner");
    const address = JSON.stringify([
      allocation.node_id,
      allocation.ip,
      allocation.port,
    ]);
    if (allocationAddresses.has(address))
      throw new Error("Duplicate legacy allocation address");
    allocationAddresses.add(address);
    const server = get("servers", allocation.server_id);
    if (server && server.allocation_id !== allocation.id)
      secondaryAllocations.push({
        legacyId: Number(allocation.id),
        serverId: String(server.uuid),
        nodeId: String(get("nodes", allocation.node_id)?.uuid),
        ip: allocation.ip,
        port: allocation.port,
      });
  }
  const servers = [];
  for (const server of map.get("servers")?.values() ?? []) {
    const owner = get("users", server.owner_id),
      node = get("nodes", server.node_id),
      egg = get("eggs", server.egg_id),
      allocation = get("allocations", server.allocation_id);
    if (
      !owner ||
      !node ||
      !egg ||
      egg.nest_id !== server.nest_id ||
      !allocation ||
      allocation.node_id !== server.node_id ||
      allocation.server_id !== server.id
    )
      throw new Error("Invalid legacy server references");
    if (
      server.status !== null ||
      typeof server.installed_at !== "string" ||
      !server.installed_at
    )
      throw new Error("Legacy server is not installed and normal");
    servers.push({
      uuid: server.uuid,
      ownerId: owner.uuid,
      nodeId: node.uuid,
      eggId: egg.uuid,
      nestId: get("nests", server.nest_id)?.uuid,
      port: allocation.port,
    });
  }
  const permissions = new Set<string>(serverPermissions);
  const pairs = new Set<string>();
  const grants = [];
  for (const grant of map.get("subusers")?.values() ?? []) {
    const user = get("users", grant.user_id),
      server = get("servers", grant.server_id);
    if (!user || !server || server.owner_id === grant.user_id)
      throw new Error("Invalid legacy grant scope");
    const pair = `${grant.server_id}:${grant.user_id}`;
    if (pairs.has(pair)) throw new Error("Duplicate legacy grant scope");
    pairs.add(pair);
    if (
      !Array.isArray(grant.permissions) ||
      grant.permissions.length > permissions.size ||
      grant.permissions.some(
        (permission) =>
          typeof permission !== "string" || !permissions.has(permission),
      ) ||
      new Set(grant.permissions).size !== grant.permissions.length
    )
      throw new Error("Unsupported legacy permission grant");
    grants.push({
      userId: user.uuid,
      serverId: server.uuid,
      permissions: [...grant.permissions],
    });
  }
  return {
    userIds: [...(map.get("users")?.values() ?? [])].map((row) =>
      String(row.uuid),
    ),
    counts: Object.fromEntries(
      tables.map((table) => [table, map.get(table)?.size ?? 0]),
    ),
    servers,
    secondaryAllocations,
    grants,
  };
}
