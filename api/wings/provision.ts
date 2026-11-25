import { fixturePathSegment } from "./client";
import {
  upstreamProfiles,
  registeredWorkload,
  mumbleEgg,
  upstreamWorkload,
} from "../eggs/upstream-workload";
import {
  reviewedHttpEggs,
  reviewedWorkload,
  type FixtureMode,
} from "../eggs/reviewed-workload";
import { WingsSocket, SocketError } from "./socket";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Pool } from "mysql2/promise";
import { rows, transaction, type Executor } from "../db";
import { canServer, type Actor } from "../policy";
import { cryptoContext } from "../security";
import {
  validateNode,
  WingsClient,
  WingsUnavailable,
  type WingsNode,
} from "./client";
import { lifecycleFixture } from "./lifecycle-fixture";
import type { WorkloadProvider } from "./remote";

// Default shell fixture; additional reviewed documents are exact-byte staging allowlists.
export const disposableEgg = JSON.stringify({
  meta: { version: "PTDL_v2" },
  name: "Relay Disposable Shell",
  docker_images: { Shell: "~relay-wings-contract-workload:ci" },
  config: {},
  scripts: { installation: {} },
  variables: [],
});
export type Phase =
  | "dispatching"
  | "installing"
  | "installed"
  | "transferring"
  | "install_failed"
  | "uncertain"
  | "reinstalling"
  | "reinstall_uncertain"
  | "deleting"
  | "delete_uncertain"
  | "deleted";
type ServerRow = {
  uuid: string;
  name: string;
  ownerId: string;
  port: number;
  eggId: string;
  document: Buffer;
  origin: string;
  tokenId: string;
  cipher: Buffer;
  nodeId: string;
  phase: Phase | null;
  fixtureMode: FixtureMode | null;
  mumbleMaxUsers: string | null;
};
const select = `SELECT s.id AS uuid,s.owner_id AS ownerId,s.name,s.fixture_mode AS fixtureMode,s.mumble_max_users AS mumbleMaxUsers,a.port,s.egg_id AS eggId,e.document,n.origin,n.token_id AS tokenId,n.token_cipher AS cipher,n.id AS nodeId,p.phase
 FROM servers s JOIN nodes n ON n.id=s.node_id JOIN allocations a ON a.id=s.allocation_id JOIN eggs e ON e.id=s.egg_id LEFT JOIN wings_provisions p ON p.server_id=s.id`;
export class ProvisionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export function createProvisioner(
  pool: Pool,
  rawNode: WingsNode,
  key: Buffer,
  pepper: Buffer,
  origin: string,
) {
  const node = validateNode(rawNode);
  const crypt = cryptoContext(key, pepper, "node-token");
  const client = new WingsClient(node);
  const socket = new WingsSocket(node, origin);
  const fromNode = (s: ServerRow) => {
    if (s.origin !== node.origin || s.tokenId !== node.tokenId) return false;
    const saved = crypt.open(s.cipher, s.nodeId),
      expected = Buffer.from(node.token);
    return saved.length === expected.length && timingSafeEqual(saved, expected);
  };
  const load = async (db: Executor, id: string, lock = false) =>
    (
      await rows<ServerRow>(
        db,
        `${select} WHERE s.id=?${lock ? " FOR UPDATE" : ""}`,
        [id],
      )
    )[0];
  const experimentalGitea =
    process.env.RELAY_EXPERIMENTAL_GITEA === "1" &&
    process.env.RELAY_DISPOSABLE_WINGS_CI === "1" &&
    process.env.RUNNER_ENVIRONMENT === "github-hosted";
  const approvedDocuments = [
    disposableEgg,
    ...reviewedHttpEggs,
    mumbleEgg,
    ...(experimentalGitea ? upstreamProfiles.map((row) => row.document) : []),
  ].map((text) => Buffer.from(text));
  const eligible = (s: ServerRow) =>
    fromNode(s) &&
    approvedDocuments.some((document) => s.document.equals(document));
  async function installStatus(
    server: ServerRow,
    result: { successful: boolean; reinstall: boolean },
  ) {
    const eligiblePhases = result.reinstall
      ? ["reinstalling", "reinstall_uncertain"]
      : ["dispatching", "installing", "uncertain"];
    await transaction(pool, async (db) => {
      const current = await load(db, server.uuid, true);
      if (
        !current ||
        !eligible(current) ||
        !current.phase ||
        !eligiblePhases.includes(current.phase)
      )
        return;
      const phase = result.successful ? "installed" : "install_failed";
      await db.execute(
        "UPDATE wings_provisions SET phase=? WHERE server_id=?",
        [phase, server.uuid],
      );
      await db.execute(
        "INSERT INTO audit_log (event,subject_id) VALUES (?,?)",
        [`wings.${phase}`, server.uuid],
      );
    });
  }
  const workload = (s: ServerRow) => {
    const installed: ReturnType<typeof lifecycleFixture>["installed"] = (
      result,
    ) => installStatus(s, result);
    if (s.document.equals(approvedDocuments[0]))
      return lifecycleFixture(installed, s);
    if (s.document.equals(Buffer.from(mumbleEgg)))
      return upstreamWorkload(installed, s, s.mumbleMaxUsers);
    const profile =
      experimentalGitea &&
      upstreamProfiles.find((row) =>
        s.document.equals(Buffer.from(row.document)),
      );
    if (profile) return registeredWorkload(profile, installed, s);
    const reviewed = reviewedWorkload(s.document, s, installed, s.fixtureMode);
    if (!reviewed) throw new ProvisionError(422, "egg_not_approved");
    return reviewed;
  };
  const withAllocations = async (s: ServerRow) => {
    const result = workload(s);
    const extras = await rows<{ ip: string; port: number }>(
      pool,
      "SELECT a.ip,a.port FROM server_secondary_allocations x JOIN allocations a ON a.id=x.allocation_id WHERE x.server_id=? ORDER BY a.ip,a.port",
      [s.uuid],
    );
    const configuration = (
      result.configuration.settings as Record<string, unknown>
    ).allocations as {
      mappings: Record<string, number[]>;
    };
    for (const { ip, port } of extras) {
      configuration.mappings[ip] ??= [];
      configuration.mappings[ip].push(port);
    }
    return result;
  };
  const provider: WorkloadProvider = {
    lookup: async (id) => {
      const s = await load(pool, id);
      return s?.phase &&
        !["deleting", "delete_uncertain", "deleted"].includes(s.phase) &&
        eligible(s)
        ? withAllocations(s)
        : undefined;
    },
    list: async (page, perPage) => {
      // Only the configured test node is served. The catalog enforces unique origin/token ID.
      const registered = (
        await rows<{ token_cipher: Buffer; id: string }>(
          pool,
          "SELECT id,token_cipher FROM nodes WHERE origin=? AND token_id=?",
          [node.origin, node.tokenId],
        )
      )[0];
      if (!registered) return { data: [], total: 0 };
      const decrypted = crypt.open(registered.token_cipher, registered.id),
        expected = Buffer.from(node.token);
      if (
        decrypted.length !== expected.length ||
        !timingSafeEqual(decrypted, expected)
      )
        return { data: [], total: 0 };
      const scoped = `s.node_id=? AND p.phase IN ('installed','transferring') AND e.document IN (${approvedDocuments.map(() => "?").join(",")})`;
      const args = [registered.id, ...approvedDocuments];
      const total = (
        await rows<{ total: number }>(
          pool,
          `SELECT COUNT(*) AS total FROM (${select} WHERE ${scoped}) AS installed`,
          args,
        )
      )[0].total;
      const records = await rows<ServerRow>(
        pool,
        `${select} WHERE ${scoped} ORDER BY s.id LIMIT ? OFFSET ?`,
        [...args, perPage, (page - 1) * perPage],
      );
      return {
        total,
        data: await Promise.all(
          records.map(async (s) => ({
            uuid: s.uuid,
            ...(await withAllocations(s)).configuration,
          })),
        ),
      };
    },
  };
  async function authorized(
    db: Executor,
    id: string,
    actor: Actor,
    write = false,
  ) {
    const role = (
      await rows<{ is_admin: number }>(
        db,
        `SELECT is_admin FROM users WHERE id=?${write ? " FOR UPDATE" : ""}`,
        [actor.id],
      )
    )[0];
    if (!role?.is_admin || actor.channel !== "session")
      throw new ProvisionError(403, "forbidden");
    const server = await load(db, id, write);
    if (!server) throw new ProvisionError(404, "server_not_found");
    if (!eligible(server))
      throw new ProvisionError(422, "disposable_fixture_required");
    return server;
  }
  async function observe(id: string) {
    try {
      return { presence: "present" as const, state: await client.state(id) };
    } catch (error) {
      return {
        presence:
          error instanceof WingsUnavailable && error.reason === "not_found"
            ? ("absent" as const)
            : ("unreachable" as const),
        state: null,
      };
    }
  }
  const sending = new Set<string>();
  async function exclusive<T>(id: string, run: () => Promise<T>) {
    if (sending.has(id))
      throw new ProvisionError(409, "lifecycle_dispatch_in_progress");
    sending.add(id);
    try {
      return await run();
    } finally {
      sending.delete(id);
    }
  }
  return {
    provider,
    async files(
      id: string,
      actor: Actor,
      path: string,
      preview?: string,
      download = false,
    ) {
      const server = await load(pool, id);
      if (!server || actor.channel !== "session" || server.ownerId !== actor.id)
        throw new ProvisionError(404, "server_not_found");
      if (!eligible(server))
        throw new ProvisionError(422, "disposable_fixture_required");
      if (server.phase !== "installed")
        throw new ProvisionError(409, "server_not_installed");
      const segments = path === "/" ? [] : path.slice(1).split("/");
      if (
        !path.startsWith("/") ||
        segments.length > 4 ||
        !segments.every(fixturePathSegment)
      )
        throw new ProvisionError(400, "invalid_directory");
      try {
        if (preview === undefined)
          return await client.fixtureDirectory(id, segments);
        if (!fixturePathSegment(preview) || !preview.endsWith(".txt"))
          throw new ProvisionError(400, "invalid_text_file");
        const result = await client.fixtureText(id, segments, preview);
        if (result === null)
          throw new ProvisionError(422, "text_preview_unavailable");
        return download
          ? result.bytes
          : {
              name: preview,
              text: result.text,
              version: createHash("sha256").update(result.bytes).digest("hex"),
            };
      } catch (error) {
        if (error instanceof WingsUnavailable)
          throw new ProvisionError(
            error.reason === "not_found" ? 404 : 502,
            "directory_unavailable",
          );
        throw error;
      }
    },
    async editFixtureText(
      id: string,
      actor: Actor,
      version: string,
      text: string,
    ) {
      return exclusive(id, async () => {
        const server = await load(pool, id);
        if (
          !server ||
          actor.channel !== "session" ||
          server.ownerId !== actor.id
        )
          throw new ProvisionError(404, "server_not_found");
        if (!eligible(server))
          throw new ProvisionError(422, "disposable_fixture_required");
        if (server.phase !== "installed")
          throw new ProvisionError(409, "server_not_installed");
        const bytes = Buffer.from(text, "utf8");
        if (
          bytes.length > 16384 ||
          bytes.toString("utf8") !== text ||
          [...bytes].some(
            (byte) =>
              (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) ||
              byte === 127,
          )
        )
          throw new ProvisionError(422, "invalid_text_file");
        try {
          if ((await client.state(id)) !== "offline")
            throw new ProvisionError(409, "server_not_offline");
          const current = await client.fixtureText(
            id,
            ["fixture-docs"],
            "example.txt",
          );
          if (!current)
            throw new ProvisionError(422, "text_preview_unavailable");
          if (
            createHash("sha256").update(current.bytes).digest("hex") !== version
          )
            throw new ProvisionError(409, "file_version_conflict");
          await client.writeFixtureText(id, text);
          const observed = await client.fixtureText(
            id,
            ["fixture-docs"],
            "example.txt",
          );
          if (!observed?.bytes.equals(bytes))
            throw new ProvisionError(502, "file_write_unverified");
          return {
            name: "example.txt",
            text: observed.text,
            version: createHash("sha256").update(observed.bytes).digest("hex"),
          };
        } catch (error) {
          if (error instanceof WingsUnavailable)
            throw new ProvisionError(
              error.reason === "not_found" ? 404 : 502,
              "file_write_unverified",
            );
          throw error;
        }
      });
    },
    async compatResources(id: string) {
      const server = await load(pool, id);
      if (!server || !eligible(server) || server.phase !== "installed")
        throw new ProvisionError(503, "fixture_unavailable");
      try {
        return await client.clientResources(id);
      } catch (error) {
        if (error instanceof WingsUnavailable)
          throw new ProvisionError(502, "wings_resources_unavailable");
        throw error;
      }
    },
    async stats(id: string, actor: Actor, scope: "admin" | "user" = "admin") {
      const server =
        scope === "admin"
          ? await authorized(pool, id, actor)
          : await load(pool, id);
      if (
        !server ||
        (scope === "user" &&
          (actor.channel !== "session" || server.ownerId !== actor.id))
      )
        throw new ProvisionError(404, "server_not_found");
      if (!eligible(server))
        throw new ProvisionError(422, "disposable_fixture_required");
      if (server.phase !== "installed")
        throw new ProvisionError(409, "server_not_installed");
      try {
        return await socket.stats(id, actor.id);
      } catch (error) {
        if (error instanceof SocketError)
          throw new ProvisionError(
            error.reason === "capacity" ? 429 : 502,
            "wings_stats_unavailable",
          );
        throw error;
      }
    },
    async console(id: string, actor: Actor, scope: "admin" | "user" = "admin") {
      const server =
        scope === "admin"
          ? await authorized(pool, id, actor)
          : await load(pool, id);
      if (
        !server ||
        (scope === "user" &&
          (actor.channel !== "session" || server.ownerId !== actor.id))
      )
        throw new ProvisionError(404, "server_not_found");
      if (!eligible(server))
        throw new ProvisionError(422, "disposable_fixture_required");
      if (server.phase !== "installed")
        throw new ProvisionError(409, "server_not_installed");
      try {
        return await socket.console(id, actor.id);
      } catch (error) {
        if (error instanceof SocketError)
          throw new ProvisionError(
            error.reason === "capacity" ? 429 : 502,
            "wings_console_unavailable",
          );
        throw error;
      }
    },
    async runtime(id: string, actor: Actor, scope: "admin" | "user" = "admin") {
      const server =
        scope === "admin"
          ? await authorized(pool, id, actor)
          : await load(pool, id);
      if (!server) throw new ProvisionError(404, "server_not_found");
      if (scope === "user") {
        const [visible] = await rows(
          pool,
          `SELECT 1 FROM servers s WHERE s.id=? AND (s.owner_id=? OR EXISTS (SELECT 1 FROM server_grants g WHERE g.server_id=s.id AND g.user_id=? AND JSON_LENGTH(g.permissions)>0))`,
          [id, actor.id, actor.id],
        );
        if (!visible || actor.channel !== "session")
          throw new ProvisionError(404, "server_not_found");
        if (!eligible(server))
          throw new ProvisionError(422, "disposable_fixture_required");
      }
      if (server.phase !== "installed")
        throw new ProvisionError(409, "server_not_installed");
      return observe(id);
    },
    async power(
      id: string,
      action: "start" | "stop" | "restart",
      actor: Actor,
      scope: "admin" | "user" | "compat" = "admin",
    ) {
      return exclusive(id, async () => {
        await transaction(pool, async (db) => {
          const server =
            scope === "admin"
              ? await authorized(db, id, actor, true)
              : await load(db, id, true);
          if (!server) throw new ProvisionError(404, "server_not_found");
          if (scope !== "admin") {
            const [role] = await rows<{ is_admin: number }>(
              db,
              "SELECT is_admin FROM users WHERE id=? FOR UPDATE",
              [actor.id],
            );
            const [grant] = await rows<{ allowed: number }>(
              db,
              "SELECT JSON_CONTAINS(permissions,JSON_QUOTE(?)) AS allowed FROM server_grants WHERE server_id=? AND user_id=? FOR UPDATE",
              [`control.${action}`, id, actor.id],
            );
            const permission = `control.${action}`;
            if (scope === "compat") {
              const [key] = await rows(
                db,
                "SELECT id FROM api_keys WHERE id=? AND user_id=? AND client_power=TRUE AND expires_at>UTC_TIMESTAMP(3) FOR UPDATE",
                [actor.keyId ?? "", actor.id],
              );
              if (actor.channel !== "api-key" || !key)
                throw new ProvisionError(403, "power_scope_required");
              if (
                !role ||
                (server.ownerId !== actor.id && grant?.allowed !== 1)
              )
                throw new ProvisionError(404, "server_not_found");
            } else if (
              !role ||
              !canServer(
                { ...actor, admin: !!role.is_admin },
                { id, owner: server.ownerId },
                grant?.allowed === 1
                  ? { user: actor.id, server: id, permissions: [permission] }
                  : null,
                permission,
              )
            )
              throw new ProvisionError(404, "server_not_found");
            if (!eligible(server))
              throw new ProvisionError(422, "disposable_fixture_required");
          }
          if (server.phase !== "installed")
            throw new ProvisionError(409, "server_not_installed");
          await db.execute(
            "INSERT INTO audit_log (actor_id,event,subject_id) VALUES (?,?,?)",
            [actor.id, `wings.power_${action}_requested`, id],
          );
        });
        try {
          await client.power(id, action);
        } catch {
          await pool.execute(
            "INSERT INTO audit_log (actor_id,event,subject_id) VALUES (?,?,?)",
            [actor.id, `wings.power_${action}_uncertain`, id],
          );
          throw new ProvisionError(502, "power_outcome_unknown");
        }
        return { accepted: true };
      });
    },
    async destructive(
      id: string,
      action: "reinstall" | "delete",
      actor: Actor,
    ) {
      return exclusive(id, async () => {
        const before = await authorized(pool, id, actor);
        if (before.phase !== "installed")
          throw new ProvisionError(409, "server_not_installed");
        const runtime = await observe(id);
        if (runtime.presence !== "present" || runtime.state !== "offline")
          throw new ProvisionError(409, "server_must_be_offline");
        const pending = action === "reinstall" ? "reinstalling" : "deleting";
        await transaction(pool, async (db) => {
          const current = await authorized(db, id, actor, true);
          if (current.phase !== "installed")
            throw new ProvisionError(409, "server_not_installed");
          await db.execute(
            "UPDATE wings_provisions SET phase=? WHERE server_id=?",
            [pending, id],
          );
          await db.execute(
            "INSERT INTO audit_log (actor_id,event,subject_id) VALUES (?,?,?)",
            [actor.id, `wings.${action}_requested`, id],
          );
        });
        let outcome: Phase = pending;
        try {
          if (action === "reinstall") await client.reinstall(id);
          else {
            await client.remove(id);
            outcome = "deleted";
          }
        } catch {
          outcome =
            action === "reinstall" ? "reinstall_uncertain" : "delete_uncertain";
        }
        // Preserve a terminal reinstall callback even if it beats the HTTP result.
        if (outcome !== pending)
          await transaction(pool, async (db) => {
            const current = await load(db, id, true);
            if (current?.phase !== pending) return;
            await db.execute(
              "UPDATE wings_provisions SET phase=? WHERE server_id=?",
              [outcome, id],
            );
            await db.execute(
              "INSERT INTO audit_log (actor_id,event,subject_id) VALUES (?,?,?)",
              [actor.id, `wings.${outcome}`, id],
            );
          });
        return { phase: (await load(pool, id))?.phase ?? outcome };
      });
    },
    async reconcile(id: string, actor: Actor) {
      const s = await authorized(pool, id, actor);
      if (
        !s.phase ||
        !(
          [
            "dispatching",
            "installing",
            "uncertain",
            "reinstalling",
            "reinstall_uncertain",
            "deleting",
            "delete_uncertain",
          ] as const
        ).some((phase) => phase === s.phase)
      )
        throw new ProvisionError(409, "reconcile_not_applicable");
      const observation = await observe(id);
      // Daemon presence, absence and power state cannot attest to installation completion.
      // Keep the durable dispatch marker and never retry based on this observation.
      return transaction(pool, async (db) => {
        const latest = await authorized(db, id, actor, true);
        await db.execute(
          "INSERT INTO audit_log (actor_id,event,subject_id) VALUES (?,?,?)",
          [actor.id, `wings.reconcile_${observation.presence}`, id],
        );
        return { phase: latest.phase, ...observation };
      });
    },
    async provision(id: string, actor: Actor) {
      // Lock the server before writing a durable dispatch marker. Do not hold DB locks during network calls.
      await transaction(pool, async (db) => {
        const s = await authorized(db, id, actor, true);
        if (s.phase)
          throw new ProvisionError(409, "provision_already_dispatched");
        await db.execute(
          "INSERT INTO wings_provisions (server_id,phase) VALUES (?,'dispatching')",
          [id],
        );
        await db.execute(
          "INSERT INTO audit_log (actor_id,event,subject_id) VALUES (?,'wings.provision_requested',?)",
          [actor.id, id],
        );
      });
      let next: Phase = "installing";
      try {
        await client.create(id);
      } catch {
        next = "uncertain";
      }
      // A callback can win the race before create returns. Never overwrite a terminal result.
      await pool.execute(
        "UPDATE wings_provisions SET phase=? WHERE server_id=? AND phase='dispatching'",
        [next, id],
      );
      return (await load(pool, id))?.phase ?? next;
    },
  };
}
