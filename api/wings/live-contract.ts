import { upstreamProfiles, mumbleEgg } from "../eggs/upstream-workload";
import { reviewedHttpEggs } from "../eggs/reviewed-workload";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { connect as connectTls } from "node:tls";
import { promisify } from "node:util";
import { WingsSocket } from "./socket";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../app";
import { rows, stagingPool } from "../db";
import { migrate } from "../migrate";
import { passwordHash } from "../security";
import { WingsClient, type WingsNode } from "./client";
import { disposableEgg } from "./provision";

async function until(
  label: string,
  condition: () => boolean | Promise<boolean>,
  attempts = 40,
) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`::error::Contract did not reach ${label}`);
}
async function main() {
  if (
    process.env.RELAY_DISPOSABLE_WINGS_CI !== "1" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    !process.env.RELAY_STAGING_DATABASE_URL?.endsWith("/relay_test")
  )
    throw new Error("Disposable CI only");
  const node: WingsNode = {
    origin: "http://127.0.0.1:18080",
    tokenId: process.env.RELAY_WINGS_TEST_TOKEN_ID ?? "",
    token: process.env.RELAY_WINGS_TEST_TOKEN ?? "",
  };
  const pool = stagingPool();
  const origin = "https://relay.example.test";
  const app = await createApp({
    pool,
    origin,
    key: randomBytes(32),
    pepper: randomBytes(32),
    catalogNodeKey: randomBytes(32),
    allowedCatalogNodeOrigins: [node.origin],
    wingsTestNode: node,
    enableDisposableProvisioning: true,
    deliverReset: async () => {},
  });
  try {
    await migrate(pool, "up");
    const id = randomUUID(),
      password = randomBytes(24).toString("hex");
    await pool.execute(
      "INSERT INTO users (id,email,display_name,password_hash,is_admin) VALUES (?,?,?,?,1)",
      [
        id,
        "contract@example.test",
        "Contract operator",
        await passwordHash(password),
      ],
    );
    await app.listen({ host: "127.0.0.1", port: 13200 });
    const headers = { origin, "x-relay-request": "1" };
    const logged = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers,
      payload: { email: "contract@example.test", password },
    });
    assert.equal(logged.statusCode, 200, "admin fixture login");
    const session = logged.cookies.find(
      (cookie) => cookie.name === "__Host-relay_session",
    );
    assert.ok(session);
    let testClientAddress = "127.0.0.1";
    const admin = (
      method: "GET" | "POST" | "PUT",
      path: string,
      payload?: object,
    ) =>
      app.inject({
        method,
        remoteAddress: testClientAddress,
        url: `/api/v1/admin/${path}`,
        headers: { ...headers, cookie: `${session.name}=${session.value}` },
        payload,
      });
    const add = async (path: string, payload: object) => {
      const result = await admin("POST", path, payload);
      assert.equal(result.statusCode, 201, `catalog ${path}: ${result.body}`);
      return result.json<{ id: string }>().id;
    };
    const nodeId = await add("nodes", { ...node, name: "Disposable Wings" });
    const nestId = await add("nests", { name: "Disposable fixture" });
    const eggId = await add("eggs", { nestId, document: disposableEgg });
    const allocationId = await add("allocations", {
      nodeId,
      ip: "127.0.0.1",
      port: 25610,
    });
    const uuid = await add("servers", {
      name: "Catalog contract workload",
      nodeId,
      eggId,
      allocationId,
      ownerId: id,
    });
    const client = new WingsClient(node);
    await until("Wings health", async () => {
      try {
        await client.health();
        return true;
      } catch {
        return false;
      }
    });
    const anonymous = await fetch(`${node.origin}/api/system`, {
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(anonymous.status, 401);
    await anonymous.body?.cancel();
    const phase = async () => {
      const result = await admin("GET", `servers/${uuid}/provision`);
      assert.equal(result.statusCode, 200);
      return result.json<{ phase: string }>().phase;
    };
    assert.equal(await phase(), "draft");
    const remoteAuth = {
      authorization: `Bearer ${node.tokenId}.${node.token}`,
    };
    const remote = (path: string) =>
      app.inject({ url: `/api/remote/${path}`, headers: remoteAuth });
    assert.equal((await remote(`servers/${uuid}`)).statusCode, 404);
    assert.equal(
      (await admin("POST", `servers/${uuid}/provision`, { confirm: false }))
        .statusCode,
      400,
    );
    // Concurrent requests may race, but only one may dispatch a create.
    const dispatch = await Promise.all([
      admin("POST", `servers/${uuid}/provision`, { confirm: true }),
      admin("POST", `servers/${uuid}/provision`, { confirm: true }),
    ]);
    assert.deepEqual(
      dispatch.map((r) => r.statusCode).sort(),
      [202, 409],
      dispatch.map((r) => r.body).join(" | "),
    );
    await until("persisted installation callback", async () => {
      const current = await phase();
      assert.notEqual(current, "install_failed");
      return current === "installed";
    });
    const listed = await remote("servers?page=0&per_page=50");
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(
      listed.json().data.map((server: { uuid: string }) => server.uuid),
      [uuid],
    );
    // A delayed negative callback must not overwrite an installed terminal result.
    const repeated = await app.inject({
      method: "POST",
      url: `/api/remote/servers/${uuid}/install`,
      headers: remoteAuth,
      payload: { successful: false, reinstall: false },
    });
    assert.equal(repeated.statusCode, 204);
    assert.equal(await phase(), "installed");
    const sample = await admin("GET", `servers/${uuid}/stats`);
    assert.equal(sample.statusCode, 200, sample.body);
    assert.deepEqual(
      Object.keys(sample.json()).sort(),
      [
        "cpuAbsolute",
        "diskBytes",
        "memoryBytes",
        "memoryLimitBytes",
        "rxBytes",
        "txBytes",
        "uptimeMs",
      ].sort(),
    );
    await assert.rejects(
      new WingsSocket(node, "https://rejected.example.test").stats(uuid, id),
      { reason: "transport" },
    );
    const runtime = async () => {
      const res = await admin("GET", `servers/${uuid}/runtime`);
      assert.equal(res.statusCode, 200);
      return res.json<{ state: string | null; presence: string }>();
    };
    const power = (action: "start" | "stop", confirm = true) =>
      admin("POST", `servers/${uuid}/power`, { action, confirm });
    const consoleSnapshot = async () => {
      const result = await admin("GET", `servers/${uuid}/console`);
      assert.equal(result.statusCode, 200, result.body);
      return result.json<{ lines: string[]; truncated: boolean }>();
    };
    assert.deepEqual(await consoleSnapshot(), { lines: [], truncated: false });
    assert.equal((await runtime()).state, "offline");
    assert.equal((await power("start", false)).statusCode, 400);
    assert.equal((await power("start")).statusCode, 202);
    await until(
      "running state via admin API",
      async () => (await runtime()).state === "running",
    );
    const replay = await consoleSnapshot();
    assert.ok(
      replay.lines.includes("RELAY_CONTRACT_READY"),
      "actual Wings console marker",
    );
    assert.ok(replay.lines.every((line) => line === "RELAY_CONTRACT_READY"));
    assert.equal(
      (await admin("POST", `servers/${uuid}/delete`, { confirm: true }))
        .statusCode,
      409,
    );
    assert.equal(
      (await admin("POST", `servers/${uuid}/reinstall`, { confirm: true }))
        .statusCode,
      409,
    );
    // The engine preserves the already-running workload. Restart only the Wings control container.
    const docker = promisify(execFile);
    const inspect = async () => {
      const result = await docker(
        "docker",
        [
          "inspect",
          "--type",
          "container",
          "--format",
          "{{.Id}} {{.State.StartedAt}}",
          uuid,
        ],
        { timeout: 5000 },
      );
      return result.stdout.trim();
    };
    const original = await inspect();
    await docker(
      "docker",
      ["restart", "--time", "10", "relay-wings-contract"],
      { timeout: 20000 },
    );
    await until("Wings to rediscover already-running workload", async () => {
      try {
        return (await client.state(uuid)) === "running";
      } catch {
        return false;
      }
    });
    assert.equal(
      await inspect(),
      original,
      "Wings restart must not recreate or restart the workload container",
    );
    assert.equal(await phase(), "installed");
    assert.deepEqual(
      await rows<{ total: number }>(
        pool,
        "SELECT COUNT(*) AS total FROM audit_log WHERE subject_id=? AND event='wings.installed'",
        [uuid],
      ),
      [{ total: 1 }],
    );
    assert.equal((await power("stop")).statusCode, 202);
    await until(
      "offline state via admin API",
      async () => (await runtime()).state === "offline",
    );
    const runtimeProfile = process.env.RELAY_BOOTSTRAP_SCENARIO === "lifecycle";
    const assertDiagnostic = async () => {
      const { stdout } = await docker(
        "docker",
        [
          "inspect",
          "--type",
          "container",
          "--format",
          "{{json .Config.Image}} {{json .HostConfig.PortBindings}}",
          uuid,
        ],
        { timeout: 5000 },
      );
      const space = stdout.indexOf(" ");
      assert.equal(
        JSON.parse(stdout.slice(0, space)),
        "relay-wings-contract-diagnostic:ci",
      );
      const bindings = JSON.parse(stdout.slice(space + 1));
      // Wings translates the catalog loopback allocation to its Docker
      // interface address when it creates the actual port bindings.
      const configPath = process.env.RELAY_ADOPTION_FIXTURE_CONFIG ?? "";
      assert.match(
        configPath,
        /^\/tmp\/tmp\.[A-Za-z0-9]+\/config\/config\.yml$/,
      );
      const config = await readFile(configPath, "utf8");
      const bindingIp = config.match(
        /^\s+interface: (\d+\.\d+\.\d+\.\d+)$/m,
      )?.[1];
      assert.ok(
        bindingIp &&
          /^(?:127\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(bindingIp),
      );
      for (const port of [25610, 25620])
        assert.ok(
          bindings[`${port}/tcp`]?.some(
            (binding: { HostIp: string; HostPort: string }) =>
              binding.HostPort === String(port) && binding.HostIp === bindingIp,
          ),
          `Fixture port ${port} bound to configured private interface`,
        );
      await until(
        "diagnostic startup marker in disposable workload logs",
        async () => {
          const logs = await docker("docker", ["logs", "--tail", "16", uuid], {
            timeout: 5000,
            maxBuffer: 8192,
          });
          return logs.stdout
            .split(/\r?\n/)
            .includes("RELAY_CONTRACT_PROFILE_DIAGNOSTIC");
        },
        6,
      );
    };
    const retained = "stored before reinstall\n";
    if (runtimeProfile) {
      testClientAddress = "127.0.0.6";
      const additional = await add("allocations", {
        nodeId,
        ip: "127.0.0.1",
        port: 25620,
      });
      const path = `servers/${uuid}/runtime-profile`;
      const request = (value: string, allocation = additional) =>
        admin("PUT", path, {
          confirm: true,
          profile: value,
          additionalAllocationId: allocation,
        });
      assert.equal((await request("arbitrary/image:tag")).statusCode, 400);
      assert.equal((await request("diagnostic", allocationId)).statusCode, 409);
      assert.equal(
        (
          await app.inject({
            method: "PUT",
            url: `/api/v1/admin/${path}`,
            headers,
            payload: {
              confirm: true,
              profile: "diagnostic",
              additionalAllocationId: additional,
            },
          })
        ).statusCode,
        401,
      );
      const updated = await request("diagnostic");
      assert.equal(updated.statusCode, 200);
      assert.equal(updated.json().appliesOnNextStart, true);
      assert.equal((await power("start")).statusCode, 202);
      await until(
        "diagnostic profile running",
        async () => (await runtime()).state === "running",
      );
      await assertDiagnostic();
      assert.equal((await request("standard")).statusCode, 409);
      await client.uploadFixtureText(uuid, "retained.txt", retained);
      assert.equal((await power("stop")).statusCode, 202);
      await until(
        "diagnostic profile offline",
        async () => (await runtime()).state === "offline",
      );
    }
    const action = (name: "reinstall" | "delete", confirm = true) =>
      admin("POST", `servers/${uuid}/${name}`, { confirm });
    assert.equal((await action("reinstall", false)).statusCode, 400);
    const reinstall = await action("reinstall");
    assert.equal(reinstall.statusCode, 202, reinstall.body);
    await until("persisted reinstall callback", async () => {
      const current = await phase();
      assert.notEqual(current, "install_failed");
      return current === "installed";
    });
    assert.deepEqual(
      await rows<{ total: number }>(
        pool,
        "SELECT COUNT(*) AS total FROM audit_log WHERE subject_id=? AND event='wings.installed'",
        [uuid],
      ),
      [{ total: 2 }],
    );
    assert.equal((await runtime()).state, "offline");
    if (runtimeProfile) {
      assert.deepEqual(
        await client.fixtureDownload(uuid, ["fixture-docs"], "retained.txt"),
        Buffer.from(retained),
      );
      assert.equal((await power("start")).statusCode, 202);
      await until(
        "diagnostic profile running after reinstall",
        async () => (await runtime()).state === "running",
      );
      await assertDiagnostic();
      assert.equal((await power("stop")).statusCode, 202);
      await until(
        "diagnostic profile offline after reinstall",
        async () => (await runtime()).state === "offline",
      );
      console.log(
        "::notice::Admin lifecycle: offline_profile_change=true approved_image_observed=true startup_marker_verified=true secondary_port_bound=true reinstall_callback=true fixture_bytes_preserved=true",
      );
    }
    assert.equal((await action("delete", false)).statusCode, 400);
    const deletion = await action("delete");
    assert.equal(deletion.statusCode, 202, deletion.body);
    assert.equal(await phase(), "deleted");
    assert.equal((await action("delete")).statusCode, 409);
    await assert.rejects(client.state(uuid), { reason: "not_found" });
    assert.equal((await remote(`servers/${uuid}`)).statusCode, 404);
    const after = await remote("servers?page=0&per_page=50");
    assert.deepEqual(after.json().data, []);
    testClientAddress = "127.0.0.1";
    for (const [index, document] of reviewedHttpEggs.entries()) {
      const eggId = await add("eggs", { nestId, document });
      const attachment = await admin("GET", `eggs/${eggId}/document`);
      assert.equal(attachment.statusCode, 200);
      assert.equal(attachment.body, document);
      const port = 25611 + index;
      const allocationId = await add("allocations", {
        nodeId,
        ip: "127.0.0.1",
        port,
      });
      const draft = {
        name: `Reviewed HTTP ${index + 1}`,
        nodeId,
        eggId,
        allocationId,
        ownerId: id,
      };
      assert.equal(
        (
          await admin("POST", "servers", {
            ...draft,
            fixtureMode: "unsupported",
          })
        ).statusCode,
        400,
      );
      const expected = index === 0 ? "alpha" : "beta";
      const serverId = await add(
        "servers",
        index === 0 ? draft : { ...draft, fixtureMode: expected },
      );
      const provision = await admin("POST", `servers/${serverId}/provision`, {
        confirm: true,
      });
      assert.equal(provision.statusCode, 202, provision.body);
      await until(`HTTP egg ${index + 1} installation`, async () => {
        const [record] = await rows<{ phase: string }>(
          pool,
          "SELECT phase FROM wings_provisions WHERE server_id=?",
          [serverId],
        );
        assert.notEqual(record?.phase, "install_failed");
        return record?.phase === "installed";
      });
      const start = await admin("POST", `servers/${serverId}/power`, {
        confirm: true,
        action: "start",
      });
      assert.equal(start.statusCode, 202, start.body);
      try {
        await until(`HTTP egg ${index + 1} response`, async () => {
          try {
            const { stdout } = await docker(
              "docker",
              ["exec", serverId, "wget", "-qO-", `http://127.0.0.1:${port}/`],
              { timeout: 2000 },
            );
            return (
              stdout.trim() ===
              (index === 2
                ? "RELAY_REVIEWED_EGG_PROPERTIES"
                : "RELAY_REVIEWED_EGG_HTTP")
            );
          } catch {
            return false;
          }
        });
      } catch (error) {
        const output = await docker(
          "docker",
          ["logs", "--tail", "4", serverId],
          { timeout: 4000 },
        ).catch(() => undefined);
        const summary = `${output?.stdout ?? ""} ${output?.stderr ?? ""}`
          .replace(/[^a-z0-9 ./_:-]/gi, " ")
          .slice(0, 240);
        if (summary.trim())
          console.log(`::warning::Reviewed HTTP fixture output: ${summary}`);
        throw error;
      }
      const fetchFixture = async (path: string) =>
        (
          await docker(
            "docker",
            [
              "exec",
              serverId,
              "wget",
              "-qO-",
              `http://127.0.0.1:${port}/${path}`,
            ],
            { timeout: 3000 },
          )
        ).stdout.trim();
      assert.equal(await fetchFixture("runtime.txt"), expected);
      if (index === 2) {
        const raw = await fetchFixture("server.properties");
        assert.match(raw, new RegExp(`^mode\\s*=\\s*${expected}$`, "m"));
        assert.match(raw, /^keep\s*=\s*true$/m);
      } else {
        assert.deepEqual(JSON.parse(await fetchFixture("settings.json")), {
          mode: expected,
          keep: true,
        });
      }
      assert.equal(
        (
          await admin("POST", `servers/${serverId}/power`, {
            confirm: true,
            action: "stop",
          })
        ).statusCode,
        202,
      );
      await until(
        `HTTP egg ${index + 1} offline`,
        async () => (await client.state(serverId)) === "offline",
      );
      assert.equal(
        (await admin("POST", `servers/${serverId}/delete`, { confirm: true }))
          .statusCode,
        202,
      );
    }
    // Exercise the separate upstream case as a second test client. Keep application limits intact.
    testClientAddress = "127.0.0.2";
    const mumbleId = await add("eggs", { nestId, document: mumbleEgg });
    assert.equal(
      (await admin("GET", `eggs/${mumbleId}/document`)).body,
      mumbleEgg,
    );
    const voicePort = 25614;
    const voiceAllocation = await add("allocations", {
      nodeId,
      ip: "127.0.0.1",
      port: voicePort,
    });
    const draft = {
      name: "Upstream Mumble",
      nodeId,
      eggId: mumbleId,
      allocationId: voiceAllocation,
      ownerId: id,
    };
    assert.equal(
      (await admin("POST", "servers", { ...draft, fixtureMode: "beta" }))
        .statusCode,
      422,
    );
    for (const value of ["100000", "+25", "25\n", "1e2"]) {
      assert.equal(
        (await admin("POST", "servers", { ...draft, mumbleMaxUsers: value }))
          .statusCode,
        400,
      );
    }
    const voice = await add("servers", { ...draft, mumbleMaxUsers: "37" });
    const provisionVoice = await admin("POST", `servers/${voice}/provision`, {
      confirm: true,
    });
    assert.equal(provisionVoice.statusCode, 202, provisionVoice.body);
    await until(
      "upstream Mumble install",
      async () => {
        const [record] = await rows<{ phase: string }>(
          pool,
          "SELECT phase FROM wings_provisions WHERE server_id=?",
          [voice],
        );
        assert.notEqual(record?.phase, "install_failed");
        return record?.phase === "installed";
      },
      160,
    );
    assert.equal(
      (
        await admin("POST", `servers/${voice}/power`, {
          confirm: true,
          action: "start",
        })
      ).statusCode,
      202,
    );
    await until("upstream Mumble listening", async () => {
      const { stdout, stderr } = await docker("docker", ["logs", voice], {
        timeout: 2000,
      }).catch(() => ({ stdout: "", stderr: "" }));
      return (
        (stdout + stderr).includes("Server listening on") &&
        (await client.state(voice)) === "running"
      );
    });
    const { stdout: ini } = await docker(
      "docker",
      ["exec", voice, "cat", "/home/container/murmur.ini"],
      { timeout: 4000 },
    );
    assert.match(ini, /^users\s*=\s*37$/m);
    assert.equal(
      (
        await admin("POST", `servers/${voice}/power`, {
          confirm: true,
          action: "stop",
        })
      ).statusCode,
      202,
    );
    await until(
      "upstream Mumble offline",
      async () => (await client.state(voice)) === "offline",
    );
    if (runtimeProfile) {
      testClientAddress = "127.0.0.7";
      const voicePower = (action: "start" | "stop") =>
        admin("POST", `servers/${voice}/power`, { action, confirm: true });
      const assertVoiceEndpoint = async () => {
        const { stdout } = await docker(
          "docker",
          [
            "inspect",
            "--format",
            '{{json .Config.Image}} {{json .HostConfig.PortBindings}} {{(index .NetworkSettings.Networks "relay-wings-contract-net").IPAddress}}',
            voice,
          ],
          { timeout: 5000 },
        );
        const boundary = stdout.indexOf(" ");
        assert.equal(
          JSON.parse(stdout.slice(0, boundary)),
          "ghcr.io/parkervcp/yolks:voice_mumble",
        );
        const end = stdout.trimEnd().lastIndexOf(" ");
        const bindings = JSON.parse(stdout.slice(boundary + 1, end));
        const address = stdout.slice(end + 1).trim();
        assert.match(address, /^172\.(?:1[6-9]|2[0-9]|3[01])\.\d+\.\d+$/);
        const binding = bindings[`${voicePort}/tcp`] as {
          HostIp: string;
          HostPort: string;
        }[];
        assert.equal(binding.length, 1);
        assert.match(
          binding[0].HostIp,
          /^(?:127\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/,
        );
        assert.equal(binding[0].HostPort, String(voicePort));
        // The disposable Mumble server generates a self-signed TLS certificate.
        // A Version frame (type 0) distinguishes it from a generic TCP listener.
        await new Promise<void>((resolve, reject) => {
          const socket = connectTls({
            host: address,
            port: voicePort,
            rejectUnauthorized: false,
          });
          let header = Buffer.alloc(0);
          socket.setTimeout(4000, () =>
            socket.destroy(new Error("Mumble Version frame timed out")),
          );
          socket.on("error", reject);
          socket.on("close", () =>
            reject(new Error("Mumble closed before Version frame")),
          );
          socket.on("data", (chunk) => {
            header = Buffer.concat([
              header,
              chunk.subarray(0, 6 - header.length),
            ]);
            if (header.length < 6) return;
            const size = header.readUInt32BE(2);
            if (header.readUInt16BE(0) !== 0 || size === 0 || size > 65536) {
              socket.destroy(new Error("Invalid Mumble Version frame"));
              return;
            }
            resolve();
            socket.destroy();
          });
        });
      };
      // Establish protocol readiness on a normal restart before comparing the
      // exact offline application database bytes across the reinstall callback.
      assert.equal((await voicePower("start")).statusCode, 202);
      await until(
        "Mumble running before reinstall",
        async () => (await client.state(voice)) === "running",
      );
      await assertVoiceEndpoint();
      assert.equal((await voicePower("stop")).statusCode, 202);
      await until(
        "Mumble offline before reinstall",
        async () => (await client.state(voice)) === "offline",
      );
      const data = process.env.RELAY_WINGS_CONTRACT_DATA ?? "";
      assert.match(data, /^\/tmp\/tmp\.[A-Za-z0-9]+\/data\/volumes$/);
      const dbDigest = async () => {
        const { stdout } = await docker(
          "sudo",
          ["-n", "sha256sum", `${data}/${voice}/murmur.sqlite`],
          { timeout: 5000 },
        );
        const digest = stdout.split(" ")[0];
        assert.match(digest, /^[a-f0-9]{64}$/);
        return digest;
      };
      const beforeReinstall = await dbDigest();
      const reinstalled = await admin("POST", `servers/${voice}/reinstall`, {
        confirm: true,
      });
      assert.equal(reinstalled.statusCode, 202, reinstalled.body);
      await until(
        "Mumble reinstall callback",
        async () => {
          const [record] = await rows<{ phase: string; completed: number }>(
            pool,
            `SELECT p.phase,(SELECT COUNT(*) FROM audit_log WHERE subject_id=p.server_id AND event='wings.installed') AS completed FROM wings_provisions p WHERE p.server_id=?`,
            [voice],
          );
          assert.notEqual(record?.phase, "install_failed");
          return (
            record?.phase === "installed" && Number(record.completed) === 2
          );
        },
        160,
      );
      assert.equal(await dbDigest(), beforeReinstall);
      assert.equal((await voicePower("start")).statusCode, 202);
      await until(
        "Mumble running after reinstall",
        async () => (await client.state(voice)) === "running",
      );
      await assertVoiceEndpoint();
      assert.match(
        (
          await docker(
            "docker",
            ["exec", voice, "cat", "/home/container/murmur.ini"],
            { timeout: 4000 },
          )
        ).stdout,
        /^users\s*=\s*37$/m,
      );
      assert.equal((await voicePower("stop")).statusCode, 202);
      await until(
        "Mumble offline after reinstall",
        async () => (await client.state(voice)) === "offline",
      );
      console.log(
        "::notice::Mumble lifecycle approved_image=true tls_version_frame_before_after=true reinstall_callback=true sqlite_bytes_preserved=true max_users_preserved=true",
      );
    }
    assert.equal(
      (await admin("POST", `servers/${voice}/delete`, { confirm: true }))
        .statusCode,
      202,
    );
    if (process.env.RELAY_EXPERIMENTAL_GITEA === "1")
      for (const [index, profile] of upstreamProfiles.entries()) {
        const giteaEgg = profile.document;
        testClientAddress = `127.0.0.${3 + index}`;
        const gitEgg = await add("eggs", { nestId, document: giteaEgg });
        assert.equal(
          (await admin("GET", `eggs/${gitEgg}/document`)).body,
          giteaEgg,
        );
        const gitPort = 25615 + index;
        const gitAllocation = await add("allocations", {
          nodeId,
          ip: "127.0.0.1",
          port: gitPort,
        });
        const gitDraft = {
          name: `Upstream ${profile.name}`,
          nodeId,
          eggId: gitEgg,
          allocationId: gitAllocation,
          ownerId: id,
        };
        assert.equal(
          (
            await admin("POST", "servers", {
              ...gitDraft,
              mumbleMaxUsers: "37",
            })
          ).statusCode,
          422,
        );
        const gitServer = await add("servers", gitDraft);
        const gitProvision = await admin(
          "POST",
          `servers/${gitServer}/provision`,
          {
            confirm: true,
          },
        );
        assert.equal(gitProvision.statusCode, 202, gitProvision.body);
        await until(
          `upstream ${profile.name} install`,
          async () => {
            const [record] = await rows<{ phase: string }>(
              pool,
              "SELECT phase FROM wings_provisions WHERE server_id=?",
              [gitServer],
            );
            assert.notEqual(record?.phase, "install_failed");
            return record?.phase === "installed";
          },
          160,
        );
        // The upstream installer does not fail on all HTTP errors. Verify it produced a real executable.
        const data = process.env.RELAY_WINGS_CONTRACT_DATA;
        assert.ok(data);
        const candidate = `${data}/${gitServer}/${profile.executable}`;
        const imageHeader = await docker(
          "sudo",
          ["-n", "od", "-An", "-tx1", "-N4", candidate],
          { timeout: 3000 },
        )
          .then((result) => result.stdout.trim().replace(/\s+/g, " "))
          .catch(() => "missing");
        assert.equal(
          imageHeader,
          "7f 45 4c 46",
          "Upstream Gitea installer did not produce an ELF executable",
        );
        assert.equal(
          (
            await admin("POST", `servers/${gitServer}/power`, {
              confirm: true,
              action: "start",
            })
          ).statusCode,
          202,
        );
        try {
          await until(
            `upstream ${profile.name} listening`,
            async () => (await client.state(gitServer)) === "running",
            120,
          );
        } catch (error) {
          const log = await docker(
            "docker",
            ["logs", "--tail", "10", gitServer],
            {
              timeout: 3000,
            },
          ).catch(() => ({ stdout: "", stderr: "" }));
          const runtime = await docker(
            "docker",
            [
              "inspect",
              "-f",
              "{{.State.Status}}/{{.State.ExitCode}}/{{.State.OOMKilled}}",
              gitServer,
            ],
            { timeout: 3000 },
          )
            .then((result) => result.stdout.trim())
            .catch(() => "not-created");
          console.log(`::warning::Gitea container state: ${runtime}`);
          const text = log.stdout + log.stderr;
          const hints = [
            "not found",
            "Permission denied",
            "syntax error",
            "exec format error",
            "Listen:",
            "bad interpreter",
            "failed",
            "Gitea version",
            "Invalid",
            "address already in use",
            "OOM",
            "Killed",
          ].filter((marker) =>
            text.toLowerCase().includes(marker.toLowerCase()),
          );
          console.log(
            `::warning::Gitea boot diagnostics: ${hints.join(", ") || "no recognized markers"}`,
          );
          throw error;
        }
        assert.equal(
          (
            await admin("POST", `servers/${gitServer}/power`, {
              confirm: true,
              action: "stop",
            })
          ).statusCode,
          202,
        );
        await until(
          `upstream ${profile.name} offline`,
          async () => (await client.state(gitServer)) === "offline",
        );
        assert.equal(
          (
            await admin("POST", `servers/${gitServer}/delete`, {
              confirm: true,
            })
          ).statusCode,
          202,
        );
      }
    console.log(
      "Real Wings verified via admin: create, install, start, stop, reinstall and delete",
    );
  } finally {
    await app.close();
    await pool.end();
  }
}
void main().catch((error) => {
  console.error(
    `::error::${error instanceof Error ? `${error.message} ${error.stack?.split("\n").find((line) => line.includes("live-contract.ts:")) ?? ""}`.replaceAll("\n", "%0A") : "Wings integration failed"}`,
  );
  process.exitCode = 1;
});
