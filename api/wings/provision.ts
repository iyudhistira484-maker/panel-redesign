import { lockFreeAllocation } from "../catalog/transfer";
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
  runtimeProfile: "standard" | "diagnostic" | null;
};
const select = `SELECT s.id AS uuid,s.owner_id AS ownerId,s.name,s.fixture_mode AS fixtureMode,s.mumble_max_users AS mumbleMaxUsers,a.port,s.egg_id AS eggId,e.document,n.origin,n.token_id AS tokenId,n.token_cipher AS cipher,n.id AS nodeId,p.phase,p.runtime_profile AS runtimeProfile
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
  applicationDispatchRequest?: typeof fetch,
  verifyApplicationDeletion?: (id: string) => Promise<boolean>,
) {
  const node = validateNode(rawNode);
  const crypt = cryptoContext(key, pepper, "node-token");
  const client = new WingsClient(node);
  const appDispatch = applicationDispatchRequest
    ? new WingsClient(node, applicationDispatchRequest)
    : client;
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
      return lifecycleFixture(installed, {
        ...s,
        runtimeProfile: s.runtimeProfile ?? "standard",
        diskMiB:
          process.env.RELAY_BOOTSTRAP_SCENARIO === "offhost-restore" &&
          process.env.RELAY_DISPOSABLE_WINGS_CI === "1" &&
          process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
          process.env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
          process.env.GITHUB_WORKFLOW === "Relay Wings off-host staging"
            ? 512
            : 64,
      });
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
  async function editFixtureText(
    id: string,
    actor: Actor,
    version: string,
    text: string,
    compat = false,
  ) {
    return exclusive(id, async () => {
      const server = await load(pool, id);
      if (
        !server ||
        actor.channel !== (compat ? "api-key" : "session") ||
        server.ownerId !== actor.id
      )
        throw new ProvisionError(404, "server_not_found");
      if (
        !eligible(server) ||
        (compat && !server.document.equals(Buffer.from(disposableEgg)))
      )
        throw new ProvisionError(422, "disposable_fixture_required");
      if (server.phase !== "installed")
        throw new ProvisionError(409, "server_not_installed");
      const allowed = async () =>
        (
          await rows(
            pool,
            "SELECT id FROM api_keys WHERE id=? AND user_id=? AND client_edit_file=TRUE AND expires_at>UTC_TIMESTAMP(3)",
            [actor.keyId ?? "", actor.id],
          )
        ).length === 1;
      if (compat && !(await allowed()))
        throw new ProvisionError(403, "file_edit_scope_required");
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
        if (!current) throw new ProvisionError(422, "text_preview_unavailable");
        if (
          createHash("sha256").update(current.bytes).digest("hex") !== version
        )
          throw new ProvisionError(409, "file_version_conflict");
        if (compat && !(await allowed()))
          throw new ProvisionError(403, "file_edit_scope_required");
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
  }
  async function ownerFileScope(
    id: string,
    actor: Actor,
    scope: "upload" | "delete",
  ) {
    const server = await load(pool, id);
    if (
      !server ||
      server.ownerId !== actor.id ||
      !fromNode(server) ||
      !server.document.equals(Buffer.from(disposableEgg)) ||
      server.phase !== "installed" ||
      actor.channel !== "api-key" ||
      !actor.keyId
    )
      return false;
    return (
      (
        await rows(
          pool,
          `SELECT id FROM api_keys WHERE id=? AND user_id=? AND ${scope === "upload" ? "client_upload_file" : "client_delete_file"}=TRUE AND expires_at>UTC_TIMESTAMP(3)`,
          [actor.keyId, actor.id],
        )
      ).length === 1
    );
  }
  const uploadAllowed = (id: string, actor: Actor) =>
    ownerFileScope(id, actor, "upload");
  async function dispatchInstallation(id: string, transport = client) {
    let next: Phase = "installing";
    try {
      await transport.create(id);
    } catch {
      next = "uncertain";
    }
    // A callback can win the race before create returns. Never overwrite a terminal result.
    await pool.execute(
      "UPDATE wings_provisions SET phase=? WHERE server_id=? AND phase='dispatching'",
      [next, id],
    );
    return (await load(pool, id))?.phase ?? next;
  }
  async function releaseApplicationAllocation(
    db: Executor,
    id: string,
    actor: string,
    phase: Phase,
  ) {
    const current = await load(db, id, true);
    if (current?.phase !== phase)
      throw new ProvisionError(409, "delete_reservation_changed");
    await db.execute("DELETE FROM wings_provisions WHERE server_id=?", [id]);
    await db.execute("DELETE FROM servers WHERE id=?", [id]);
    await db.execute(
      "INSERT INTO audit_log (actor_id,event,subject_id) VALUES (?,'wings.application_deleted',?)",
      [actor, id],
    );
  }
  return {
    provider,
    applicationCreate: {
      async claim(db: Executor, id: string, actorId: string) {
        const server = await load(db, id, true);
        if (
          !server ||
          !fromNode(server) ||
          !server.document.equals(Buffer.from(disposableEgg)) ||
          server.port < 1024
        )
          throw new ProvisionError(422, "fixture_placement_not_supported");
        await db.execute(
          "INSERT INTO wings_provisions (server_id,phase,application_origin) VALUES (?,'dispatching',TRUE)",
          [id],
        );
        await db.execute(
          "INSERT INTO audit_log (actor_id,event,subject_id) VALUES (?,'wings.application_provision_requested',?)",
          [actorId, id],
        );
      },
      dispatch: (id: string) => dispatchInstallation(id, appDispatch),
      async delete(
        id: string,
        authorize: (db: Executor) => Promise<string | false>,
      ) {
        return exclusive(id, async () => {
          async function check(db: Executor, lock = false) {
            const server = await load(db, id, lock);
            const [marker] = await rows<{ application_origin: number }>(
              db,
              "SELECT application_origin FROM wings_provisions WHERE server_id=?",
              [id],
            );
            if (
              !server ||
              !marker?.application_origin ||
              !fromNode(server) ||
              !server.document.equals(Buffer.from(disposableEgg))
            )
              throw new ProvisionError(404, "fixture_not_found");
            if (server.phase !== "installed")
              throw new ProvisionError(409, "fixture_not_installed");
          }
          await check(pool);
          const before = await observe(id);
          if (before.presence === "unreachable")
            throw new ProvisionError(502, "offline_status_unverified");
          if (before.presence !== "present" || before.state !== "offline")
            throw new ProvisionError(409, "fixture_not_offline");
          const actor = await transaction(pool, async (db) => {
            const actor = await authorize(db);
            if (!actor) return false;
            await check(db, true);
            const history = await rows(
              db,
              "SELECT id FROM wings_transfers WHERE server_id=? LIMIT 1 FOR UPDATE",
              [id],
            );
            const secondary = await rows(
              db,
              "SELECT allocation_id FROM server_secondary_allocations WHERE server_id=? LIMIT 1 FOR UPDATE",
              [id],
            );
            if (history.length || secondary.length)
              throw new ProvisionError(409, "fixture_has_placement_history");
            await db.execute(
              "UPDATE wings_provisions SET phase='deleting' WHERE server_id=?",
              [id],
            );
            await db.execute(
              "INSERT INTO audit_log (actor_id,event,subject_id) VALUES (?,'wings.application_delete_requested',?)",
              [actor, id],
            );
            return actor;
          });
          if (!actor) return "denied" as const;
          try {
            await appDispatch.remove(id);
            if ((await observe(id)).presence !== "absent")
              throw new Error("Wings absence not confirmed");
            await transaction(pool, (db) =>
              releaseApplicationAllocation(db, id, actor, "deleting"),
            );
            return "deleted" as const;
          } catch {
            await transaction(pool, async (db) => {
              await db.execute(
                "UPDATE wings_provisions SET phase='delete_uncertain' WHERE server_id=? AND phase='deleting'",
                [id],
              );
              await db.execute(
                "INSERT INTO audit_log (actor_id,event,subject_id) VALUES (?,'wings.application_delete_uncertain',?)",
                [actor, id],
              );
            });
            return "delete_uncertain" as const;
          }
        });
      },
      async reconcileDeletion(
        id: string,
        authorize: (db: Executor) => Promise<string | false>,
      ) {
        return exclusive(id, async () => {
          async function check(db: Executor, lock = false) {
            const current = await load(db, id, lock);
            const [marker] = await rows<{ application_origin: number }>(
              db,
              "SELECT application_origin FROM wings_provisions WHERE server_id=?",
              [id],
            );
            if (
              !current ||
              !marker?.application_origin ||
              !fromNode(current) ||
              !current.document.equals(Buffer.from(disposableEgg))
            )
              throw new ProvisionError(404, "fixture_not_found");
            if (current.phase !== "delete_uncertain")
              throw new ProvisionError(
                409,
                "delete_reconciliation_not_applicable",
              );
          }
          await check(pool);
          const observed = await observe(id);
          let verified = false;
          if (observed.presence === "absent" && verifyApplicationDeletion) {
            try {
              verified = (await verifyApplicationDeletion(id)) === true;
            } catch {
              /* fail closed */
            }
          }
          return transaction(pool, async (db) => {
            const actor = await authorize(db);
            if (!actor) return null;
            await check(db, true);
            await db.execute(
              "INSERT INTO audit_log (actor_id,event,subject_id) VALUES (?,?,?)",
              [
                actor,
                `wings.application_delete_reconcile_${observed.presence}`,
                id,
              ],
            );
            if (verified)
              await releaseApplicationAllocation(
                db,
                id,
                actor,
                "delete_uncertain",
              );
            return {
              phase: verified ? "deleted" : "delete_uncertain",
              ...observed,
              cleanup_verified: verified,
              allocation_released: verified,
            };
          });
        });
      },
      async probe(id: string) {
        const server = await load(pool, id);
        if (
          !server ||
          !fromNode(server) ||
          !server.document.equals(Buffer.from(disposableEgg))
        )
          throw new ProvisionError(404, "fixture_not_found");
        return observe(id);
      },
    },
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
    async renameFixture(
      id: string,
      actor: Actor,
      source: string,
      target: string,
    ) {
      return exclusive(id, async () => {
        if (
          source === target ||
          ![source, target].every(
            (name) => fixturePathSegment(name) && name.endsWith(".txt"),
          )
        )
          throw new ProvisionError(400, "invalid_rename");
        const authorize = async (db: Executor, lock = false) => {
          const server = await load(db, id, lock);
          if (
            !server ||
            actor.channel !== "session" ||
            server.ownerId !== actor.id ||
            !eligible(server) ||
            server.phase !== "installed"
          )
            throw new ProvisionError(404, "server_not_found");
        };
        await authorize(pool);
        try {
          if ((await client.state(id)) !== "offline")
            throw new ProvisionError(409, "server_not_offline");
          if (await client.fixtureUploadTargetExists(id, target))
            throw new ProvisionError(409, "file_exists");
          const [receipt] = await rows<{ digest: string }>(
            pool,
            "SELECT digest FROM client_uploaded_files WHERE server_id=? AND name=?",
            [id, source],
          );
          if (!receipt) throw new ProvisionError(404, "upload_not_found");
          const original = await client.fixtureDownload(
            id,
            ["fixture-docs"],
            source,
          );
          if (
            createHash("sha256").update(original).digest("hex") !==
            receipt.digest
          )
            throw new ProvisionError(409, "uploaded_file_changed");
          await transaction(pool, async (db) => {
            await authorize(db, true);
            const [locked] = await rows<{ digest: string }>(
              db,
              "SELECT digest FROM client_uploaded_files WHERE server_id=? AND name=? FOR UPDATE",
              [id, source],
            );
            if (locked?.digest !== receipt.digest)
              throw new ProvisionError(409, "upload_changed");
            await db.execute(
              "DELETE FROM client_uploaded_files WHERE server_id=? AND (name=? OR name=?)",
              [id, source, target],
            );
            await db.execute(
              "INSERT INTO audit_log (actor_id,event,subject_id) VALUES (?,'wings.fixture_file_rename_requested',?)",
              [actor.id, id],
            );
          });
          await client.renameUploadedFixture(id, source, target);
          if (
            (await client.fixtureUploadTargetExists(id, source)) ||
            !(
              await client.fixtureDownload(id, ["fixture-docs"], target)
            ).equals(original)
          )
            throw new ProvisionError(502, "file_rename_unverified");
          await pool.execute(
            "INSERT INTO client_uploaded_files (server_id,name,digest) VALUES (?,?,?)",
            [id, target, receipt.digest],
          );
          return { name: target, size: original.length };
        } catch (error) {
          if (error instanceof WingsUnavailable)
            throw new ProvisionError(502, "file_rename_unverified");
          throw error;
        }
      });
    },
    editFixtureText,
    compatFiles: {
      async deleteUpload(id: string, actor: Actor, name: string) {
        return exclusive(id, async () => {
          if (!fixturePathSegment(name) || !name.endsWith(".txt"))
            throw new ProvisionError(400, "invalid_delete_target");
          if (!(await ownerFileScope(id, actor, "delete")))
            throw new ProvisionError(403, "delete_scope_required");
          const [record] = await rows<{ digest: string }>(
            pool,
            "SELECT digest FROM client_uploaded_files WHERE server_id=? AND name=?",
            [id, name],
          );
          if (!record) throw new ProvisionError(404, "upload_not_found");
          if ((await client.state(id)) !== "offline")
            throw new ProvisionError(409, "server_not_offline");
          const current = await client.fixtureDownload(
            id,
            ["fixture-docs"],
            name,
          );
          if (
            createHash("sha256").update(current).digest("hex") !== record.digest
          )
            throw new ProvisionError(409, "uploaded_file_changed");
          if (!(await ownerFileScope(id, actor, "delete")))
            throw new ProvisionError(403, "delete_scope_required");
          // Consume provenance before dispatch: an uncertain delete must not be replayed.
          const consumed = await transaction(pool, async (db) => {
            const [locked] = await rows<{ digest: string }>(
              db,
              "SELECT digest FROM client_uploaded_files WHERE server_id=? AND name=? FOR UPDATE",
              [id, name],
            );
            if (locked?.digest !== record.digest) return false;
            await db.execute(
              "DELETE FROM client_uploaded_files WHERE server_id=? AND name=?",
              [id, name],
            );
            await db.execute(
              "INSERT INTO audit_log (actor_id,event,subject_id) VALUES (?,?,?)",
              [actor.id, "wings.fixture_file_delete_requested", id],
            );
            return true;
          });
          if (!consumed) throw new ProvisionError(404, "upload_not_found");
          try {
            await client.deleteUploadedFixture(id, name);
            if (await client.fixtureUploadTargetExists(id, name))
              throw new ProvisionError(502, "file_delete_unverified");
          } catch {
            await pool.execute(
              "INSERT INTO audit_log (actor_id,event,subject_id) VALUES (?,?,?)",
              [actor.id, "wings.fixture_file_delete_unverified", id],
            );
            throw new ProvisionError(502, "file_delete_unverified");
          }
        });
      },
      uploadAllowed,
      async upload(
        id: string,
        actor: Actor,
        name: string,
        bytes: Buffer,
        expires: number,
      ) {
        const allowed = async () => {
          if (actor.channel !== "session") return uploadAllowed(id, actor);
          const server = await load(pool, id);
          return (
            !!server &&
            server.ownerId === actor.id &&
            eligible(server) &&
            server.phase === "installed"
          );
        };
        return exclusive(id, async () => {
          if (
            !fixturePathSegment(name) ||
            !name.endsWith(".txt") ||
            bytes.length > 16384
          )
            throw new ProvisionError(400, "invalid_upload");
          let text: string;
          try {
            text = new TextDecoder("utf-8", {
              fatal: true,
              ignoreBOM: true,
            }).decode(bytes);
          } catch {
            throw new ProvisionError(400, "invalid_upload");
          }
          if (!(await allowed()))
            throw new ProvisionError(403, "upload_scope_required");
          if ((await client.state(id)) !== "offline")
            throw new ProvisionError(409, "server_not_offline");
          if (await client.fixtureUploadTargetExists(id, name))
            throw new ProvisionError(409, "file_exists");
          if (
            expires <= Date.now() ||
            !(await allowed()) ||
            expires <= Date.now()
          )
            throw new ProvisionError(403, "upload_ticket_expired_or_revoked");
          await pool.execute(
            "DELETE FROM client_uploaded_files WHERE server_id=? AND name=?",
            [id, name],
          );
          await client.uploadFixtureText(id, name, text);
          if (
            !(await client.fixtureDownload(id, ["fixture-docs"], name)).equals(
              bytes,
            )
          )
            throw new ProvisionError(502, "file_upload_unverified");
          await pool.execute(
            "INSERT INTO client_uploaded_files (server_id,name,digest) VALUES (?,?,?)",
            [id, name, createHash("sha256").update(bytes).digest("hex")],
          );
        });
      },
      contents: async (id: string) => {
        const file = await client.fixtureText(
          id,
          ["fixture-docs"],
          "example.txt",
        );
        if (!file) throw new ProvisionError(422, "text_preview_unavailable");
        return file.bytes;
      },
      edit: (id: string, actor: Actor, version: string, text: string) =>
        editFixtureText(id, actor, version, text, true),
      async allowed(id: string, actor: Actor, download: boolean) {
        const server = await load(pool, id);
        if (
          !server ||
          !fromNode(server) ||
          !server.document.equals(Buffer.from(disposableEgg)) ||
          server.phase !== "installed" ||
          actor.channel !== "api-key" ||
          !actor.keyId
        )
          return false;
        return (
          (
            await rows(
              pool,
              `SELECT k.id FROM api_keys k JOIN servers s ON s.id=? WHERE k.id=? AND k.user_id=? AND ${download ? "k.client_download" : "k.client_list_files"}=TRUE AND k.expires_at>UTC_TIMESTAMP(3) AND (s.owner_id=k.user_id OR EXISTS (SELECT 1 FROM server_grants g WHERE g.server_id=s.id AND g.user_id=k.user_id AND JSON_CONTAINS(g.permissions,JSON_QUOTE(?))))`,
              [
                id,
                actor.keyId,
                actor.id,
                download ? "file.read-content" : "file.read",
              ],
            )
          ).length === 1
        );
      },
      list: (id: string, parts: string[]) =>
        client.fixtureDirectoryMetadata(id, parts),
      read: (id: string, parts: string[], name: string, verifyOnly: boolean) =>
        client.fixtureDownload(id, parts, name, verifyOnly),
    },
    compatStream: {
      async allowed(id: string, actor: Actor) {
        const server = await load(pool, id);
        if (
          !server ||
          !fromNode(server) ||
          !server.document.equals(Buffer.from(disposableEgg)) ||
          server.phase !== "installed" ||
          actor.channel !== "api-key" ||
          !actor.keyId
        )
          return false;
        return (
          (
            await rows(
              pool,
              `SELECT k.id FROM api_keys k JOIN servers s ON s.id=? WHERE k.id=? AND k.user_id=? AND k.client_stream=TRUE AND k.expires_at>UTC_TIMESTAMP(3) AND (s.owner_id=k.user_id OR EXISTS (SELECT 1 FROM server_grants g WHERE g.server_id=s.id AND g.user_id=k.user_id AND JSON_CONTAINS(g.permissions, JSON_QUOTE('websocket.connect'))))`,
              [id, actor.keyId, actor.id],
            )
          ).length === 1
        );
      },
      connect: (id: string, actor: Actor) => socket.connectRead(id, actor.id),
    },
    async compatCommand(id: string, command: string, actor: Actor) {
      if (!/^relay-marker [a-f0-9]{24}(?![\s\S])/.test(command))
        throw new ProvisionError(400, "invalid_fixture_command");
      await exclusive(id, async () => {
        await transaction(pool, async (db) => {
          const server = await load(db, id, true);
          if (!server) throw new ProvisionError(404, "server_not_found");
          const [key] = await rows(
            db,
            "SELECT id FROM api_keys WHERE id=? AND user_id=? AND client_console=TRUE AND expires_at>UTC_TIMESTAMP(3) FOR UPDATE",
            [actor.keyId ?? "", actor.id],
          );
          if (actor.channel !== "api-key" || !key)
            throw new ProvisionError(403, "console_scope_required");
          if (server.ownerId !== actor.id) {
            const [grant] = await rows<{ allowed: number }>(
              db,
              "SELECT JSON_CONTAINS(permissions,JSON_QUOTE('control.console')) AS allowed FROM server_grants WHERE server_id=? AND user_id=? FOR UPDATE",
              [id, actor.id],
            );
            if (grant?.allowed !== 1)
              throw new ProvisionError(404, "server_not_found");
          }
          if (
            !fromNode(server) ||
            !server.document.equals(Buffer.from(disposableEgg)) ||
            server.phase !== "installed"
          )
            throw new ProvisionError(422, "disposable_fixture_required");
          await db.execute(
            "INSERT INTO audit_log (actor_id,event,subject_id) VALUES (?,?,?)",
            [actor.id, "wings.command_requested", id],
          );
        });
        try {
          await client.command(id, command);
        } catch (error) {
          if (!(error instanceof WingsUnavailable)) throw error;
          await pool.execute(
            "INSERT INTO audit_log (actor_id,event,subject_id) VALUES (?,?,?)",
            [actor.id, "wings.command_unconfirmed", id],
          );
          throw new ProvisionError(502, "command_unconfirmed");
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
    async configureFixtureRuntime(
      id: string,
      profile: "standard" | "diagnostic",
      additionalAllocationId: string,
      actor: Actor,
    ) {
      if (
        process.env.RELAY_BOOTSTRAP_SCENARIO !== "lifecycle" ||
        process.env.RELAY_DISPOSABLE_WINGS_CI !== "1" ||
        process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
        process.env.GITHUB_WORKFLOW !== "Foundation"
      )
        throw new ProvisionError(404, "fixture_runtime_not_available");
      return exclusive(id, async () => {
        const before = await authorized(pool, id, actor);
        if (!before.document.equals(approvedDocuments[0]))
          throw new ProvisionError(422, "shell_fixture_required");
        if (before.phase !== "installed")
          throw new ProvisionError(409, "server_not_installed");
        if ((await observe(id)).state !== "offline")
          throw new ProvisionError(409, "server_must_be_offline");
        return transaction(pool, async (db) => {
          const current = await authorized(db, id, actor, true);
          if (
            current.phase !== "installed" ||
            current.nodeId !== before.nodeId ||
            !current.document.equals(approvedDocuments[0])
          )
            throw new ProvisionError(409, "fixture_changed");
          const extras = await rows<{ allocation_id: string }>(
            db,
            "SELECT allocation_id FROM server_secondary_allocations WHERE server_id=? FOR UPDATE",
            [id],
          );
          if (
            !extras.some(
              (extra) => extra.allocation_id === additionalAllocationId,
            )
          ) {
            if (
              extras.length ||
              !(await lockFreeAllocation(
                db,
                current.nodeId,
                additionalAllocationId,
              ))
            )
              throw new ProvisionError(409, "allocation_unavailable");
            const [allocation] = await rows<{ ip: string }>(
              db,
              "SELECT ip FROM allocations WHERE id=?",
              [additionalAllocationId],
            );
            if (allocation?.ip !== "127.0.0.1")
              throw new ProvisionError(409, "loopback_allocation_required");
            await db.execute(
              "INSERT INTO server_secondary_allocations(allocation_id,server_id,node_id) VALUES (?,?,?)",
              [additionalAllocationId, id, current.nodeId],
            );
          }
          await db.execute(
            "UPDATE wings_provisions SET runtime_profile=? WHERE server_id=?",
            [profile, id],
          );
          await db.execute(
            "INSERT INTO audit_log(actor_id,event,subject_id) VALUES (?,'wings.fixture_runtime_configured',?)",
            [actor.id, id],
          );
          return { profile, additionalAllocationId, appliesOnNextStart: true };
        });
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
      return dispatchInstallation(id);
    },
  };
}
