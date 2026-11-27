export const fixtureFolderName = (name: string) =>
  /^[a-z][a-z0-9_-]{0,47}(?![\s\S])/.test(name) &&
  !name.startsWith("zip-pending-") &&
  !name.startsWith("extract-") &&
  name !== "parent" &&
  name !== "moved" &&
  name !== "review";
import { fixtureTarLimit } from "./fixture-tar";
export type FixtureSubfolder = string;
export const fixtureMoveFolder = (name: string) =>
  name === "moved" || name === "review" || fixtureFolderPath(name);
export const fixtureFolderPath = (name: string) => {
  const parts = name.split("/");
  return parts.length <= 2 && parts.every(fixtureFolderName);
};
export const fixturePathSegment = (value: string) =>
  /^[A-Za-z0-9_][A-Za-z0-9_. -]{0,79}$/.test(value) && !/[\r\n]/.test(value);
import { createHash } from "node:crypto";
export const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const supportedWings = "1.13.5";
export type WingsNode = { origin: string; tokenId: string; token: string };
export type WingsHealth = {
  version: string;
  cpuThreads: number;
  architecture: string;
  os: string;
};
export class WingsUnavailable extends Error {
  constructor(
    readonly reason: "transport" | "http" | "payload" | "version" | "not_found",
  ) {
    super(`Wings request: ${reason}`);
  }
}
export function validateNode(node: WingsNode): WingsNode {
  const url = new URL(node.origin);
  // This first qualification slice intentionally cannot address remote or production nodes.
  if (
    url.origin !== node.origin ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new Error("A dedicated loopback Wings test origin is required");
  if (
    !/^[A-Za-z0-9_-]{8,64}$/.test(node.tokenId) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(node.token)
  )
    throw new Error("Invalid staging node credentials");
  return { ...node };
}
export class WingsClient {
  readonly #node: WingsNode;
  constructor(
    node: WingsNode,
    private readonly request: typeof fetch = fetch,
  ) {
    this.#node = validateNode(node);
  }
  async #send(
    path: string,
    expected: number,
    method = "GET",
    body?: object | string,
    allowMissing: boolean | string = false,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.request(`${this.#node.origin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#node.token}`,
          accept: "application/json",
          ...(typeof body === "string"
            ? { "content-type": "text/plain; charset=utf-8" }
            : body instanceof ArrayBuffer
              ? { "content-type": "application/octet-stream" }
              : body
                ? { "content-type": "application/json" }
                : {}),
        },
        body:
          typeof body === "string" || body instanceof ArrayBuffer
            ? body
            : body
              ? JSON.stringify(body)
              : undefined,
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
    } catch {
      throw new WingsUnavailable("transport");
    }
    if (response.status !== expected) {
      let missing = allowMissing === true && response.status === 404;
      if (typeof allowMissing === "string" && response.status === 404) {
        // A server/route 404 is not evidence that the archive is absent.
        const reader = response.body?.getReader();
        try {
          let text = "";
          for (;;) {
            const chunk = await reader?.read();
            if (!chunk || chunk.done) break;
            text += Buffer.from(chunk.value).toString("utf8");
            if (text.length > 1024) throw new Error("Oversized error");
          }
          missing = JSON.parse(text).error === allowMissing;
        } catch {
          missing = false;
        } finally {
          await reader?.cancel().catch(() => {});
        }
      } else await response.body?.cancel().catch(() => {});
      throw new WingsUnavailable(missing ? "not_found" : "http");
    }
    return response;
  }

  #server(id: string) {
    if (!UUID_V4.test(id)) throw new Error("Invalid server UUID");
    return `/api/servers/${id}`;
  }
  async create(id: string) {
    this.#server(id);
    const response = await this.#send("/api/servers", 202, "POST", {
      uuid: id,
      start_on_completion: false,
    });
    await response.body?.cancel();
  }
  async command(id: string, command: string) {
    const response = await this.#send(
      `${this.#server(id)}/commands`,
      204,
      "POST",
      { commands: [command] },
    );
    await response.body?.cancel();
  }
  async power(id: string, action: "start" | "stop" | "restart") {
    if (action !== "start" && action !== "stop" && action !== "restart")
      throw new Error("Unsupported power action");
    const response = await this.#send(
      `${this.#server(id)}/power`,
      202,
      "POST",
      { action, wait_seconds: 10 },
    );
    await response.body?.cancel();
  }
  async #serverDetails(id: string) {
    const response = await this.#send(
      this.#server(id),
      200,
      "GET",
      undefined,
      true,
    );
    const data = await this.#json(response, 65536);
    const configuration = data.configuration;
    if (
      !configuration ||
      typeof configuration !== "object" ||
      !("uuid" in configuration) ||
      configuration.uuid !== id
    )
      throw new WingsUnavailable("payload");
    switch (data.state) {
      case "starting":
      case "running":
      case "stopping":
      case "offline":
        return { data, state: data.state };
      default:
        throw new WingsUnavailable("payload");
    }
  }
  async state(id: string) {
    return (await this.#serverDetails(id)).state;
  }
  async clientResources(id: string) {
    const { data, state } = await this.#serverDetails(id);
    const usage = data.utilization as Record<string, unknown> | null;
    const network = usage?.network as Record<string, unknown> | null;
    const nonnegative = (value: unknown, integer = true) => {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        (integer && !Number.isSafeInteger(value))
      )
        throw new WingsUnavailable("payload");
      return value;
    };
    if (typeof data.is_suspended !== "boolean")
      throw new WingsUnavailable("payload");
    return {
      current_state: state,
      is_suspended: data.is_suspended,
      resources: {
        memory_bytes: nonnegative(usage?.memory_bytes),
        cpu_absolute: nonnegative(usage?.cpu_absolute, false),
        disk_bytes: nonnegative(usage?.disk_bytes),
        network_rx_bytes: nonnegative(network?.rx_bytes),
        network_tx_bytes: nonnegative(network?.tx_bytes),
        uptime: nonnegative(usage?.uptime),
      },
    };
  }
  async transferTo(id: string, target: WingsNode, capability: string) {
    const destination = validateNode(target);
    if (
      destination.origin === this.#node.origin ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(capability) ||
      capability.length > 2048
    )
      throw new Error("Invalid fixture destination");
    const result = await this.#send(
      `${this.#server(id)}/transfer`,
      202,
      "POST",
      {
        url: `${destination.origin}/api/transfers`,
        token: `Bearer ${capability}`,
        server: { uuid: id, start_on_completion: false },
      },
    );
    await result.body?.cancel();
  }
  async readFixtureFile(
    id: string,
    name: "relay-start.sh" | "site/index.html" | "murmur.ini",
  ) {
    if (
      name !== "relay-start.sh" &&
      name !== "site/index.html" &&
      name !== "murmur.ini"
    )
      throw new Error("Unsupported fixture file");
    const result = await this.#send(
      `${this.#server(id)}/files/contents?file=${encodeURIComponent(name)}`,
      200,
    );
    const data = await this.#read(result, name === "murmur.ini" ? 65536 : 8192);
    return data.toString("utf8");
  }
  async fixtureDirectory(id: string, segments: string[]) {
    return (await this.fixtureDirectoryMetadata(id, segments)).map(
      ({ name, directory, size }) => ({ name, directory, size }),
    );
  }
  async #fixtureEntries(id: string, path: string) {
    const response = await this.#send(
      `${this.#server(id)}/files/list-directory?directory=${encodeURIComponent(path)}`,
      200,
    );
    let data: unknown;
    try {
      data = JSON.parse((await this.#read(response, 131072)).toString("utf8"));
    } catch {
      throw new WingsUnavailable("payload");
    }
    if (!Array.isArray(data) || data.length > 100)
      throw new WingsUnavailable("payload");
    return data;
  }
  async fixtureUploadTargetExists(
    id: string,
    name: string,
    moved?: FixtureSubfolder,
  ) {
    if (moved && !fixtureMoveFolder(moved))
      throw new WingsUnavailable("payload");
    const segments = moved
      ? ["fixture-docs", ...moved.split("/")]
      : ["fixture-docs"];
    await this.fixtureDirectory(id, segments);
    const entries = await this.#fixtureEntries(id, `/${segments.join("/")}`);
    if (entries.some((entry) => !entry || typeof entry.name !== "string"))
      throw new WingsUnavailable("payload");
    return entries.some((entry) => entry.name === name);
  }
  async writeExtractedFixture(id: string, directory: string, text: string) {
    if (!/^extract-[0-9a-f]{32}$/.test(directory))
      throw new WingsUnavailable("payload");
    if (await this.fixtureUploadTargetExists(id, directory))
      throw new WingsUnavailable("payload");
    const created = await this.#send(
      `${this.#server(id)}/files/create-directory`,
      204,
      "POST",
      { path: "/fixture-docs", name: directory },
    );
    await created.body?.cancel();
    if (
      (await this.fixtureDirectory(id, ["fixture-docs", directory])).length !==
      0
    )
      throw new WingsUnavailable("payload");
    const written = await this.#send(
      `${this.#server(id)}/files/write?file=${encodeURIComponent(`/fixture-docs/${directory}/extracted.txt`)}`,
      204,
      "POST",
      text,
    );
    await written.body?.cancel();
  }
  async reconcileFixtureZip(
    id: string,
    suffix: string,
    manifest: { name: string; digest: string }[],
  ): Promise<"succeeded" | "retryable" | "needs_review"> {
    if (!/^[0-9a-f]{32}$/.test(suffix)) throw new WingsUnavailable("payload");
    const pending = `zip-pending-${suffix}`,
      destination = `extract-${suffix}`;
    const hasPending = await this.fixtureUploadTargetExists(id, pending);
    if (await this.fixtureUploadTargetExists(id, destination)) {
      if (hasPending) return "needs_review";
      await this.fixtureDirectory(id, ["fixture-docs", destination]);
      const actual = await this.#fixtureEntries(
        id,
        `/fixture-docs/${destination}`,
      );
      if (actual.length !== manifest.length) return "needs_review";
      for (const { name, digest } of manifest) {
        if (!actual.some((entry) => entry.name === name)) return "needs_review";
        const bytes = await this.fixtureDownload(
          id,
          ["fixture-docs", destination],
          name,
        );
        if (createHash("sha256").update(bytes).digest("hex") !== digest)
          return "needs_review";
      }
      return "succeeded";
    }
    if (hasPending) {
      await this.fixtureDirectory(id, ["fixture-docs", pending]);
      const actual = await this.#fixtureEntries(id, `/fixture-docs/${pending}`);
      for (const entry of actual) {
        const expected = manifest.find((item) => item.name === entry.name);
        if (!expected) return "needs_review";
        const bytes = await this.fixtureDownload(
          id,
          ["fixture-docs", pending],
          expected.name,
        );
        if (
          createHash("sha256").update(bytes).digest("hex") !== expected.digest
        )
          return "needs_review";
      }
      const response = await this.#send(
        `${this.#server(id)}/files/delete`,
        204,
        "POST",
        { root: "/fixture-docs", files: [pending] },
      );
      await response.body?.cancel();
    }
    return (await this.fixtureUploadTargetExists(id, pending)) ||
      (await this.fixtureUploadTargetExists(id, destination))
      ? "needs_review"
      : "retryable";
  }
  async publishFixtureZip(
    id: string,
    suffix: string,
    entries: { name: string; bytes: Buffer }[],
  ) {
    if (
      !/^[0-9a-f]{32}$/.test(suffix) ||
      !entries.length ||
      entries.length > 4 ||
      !entries.every(
        ({ name }) => fixturePathSegment(name) && name.endsWith(".txt"),
      )
    )
      throw new WingsUnavailable("payload");
    const pending = `zip-pending-${suffix}`,
      destination = `extract-${suffix}`;
    const root = "/fixture-docs",
      files = `${this.#server(id)}/files`;
    if (
      (await this.fixtureUploadTargetExists(id, pending)) ||
      (await this.fixtureUploadTargetExists(id, destination))
    )
      throw new WingsUnavailable("payload");
    try {
      await (
        await this.#send(`${files}/create-directory`, 204, "POST", {
          path: root,
          name: pending,
        })
      ).body?.cancel();
      for (const { name, bytes } of entries) {
        await (
          await this.#send(
            `${files}/write?file=${encodeURIComponent(`${root}/${pending}/${name}`)}`,
            204,
            "POST",
            bytes.toString("utf8"),
          )
        ).body?.cancel();
        if (
          !(
            await this.fixtureDownload(id, ["fixture-docs", pending], name)
          ).equals(bytes)
        )
          throw new WingsUnavailable("payload");
      }
      if (await this.fixtureUploadTargetExists(id, destination))
        throw new WingsUnavailable("payload");
      await (
        await this.#send(`${files}/rename`, 204, "PUT", {
          root,
          files: [{ from: pending, to: destination }],
        })
      ).body?.cancel();
      return `${root}/${destination}`;
    } catch (error) {
      // Never delete the published destination: a lost rename response may mean
      // it already contains the complete archive. Clean up the pending name only.
      try {
        if (await this.fixtureUploadTargetExists(id, pending))
          await (
            await this.#send(`${files}/delete`, 204, "POST", {
              root,
              files: [pending],
            })
          ).body?.cancel();
      } catch {
        /* Outcome remains unverified; do not retry automatically. */
      }
      throw error;
    }
  }
  async createFixtureFolder(id: string, name: string) {
    if (!fixtureFolderPath(name)) throw new WingsUnavailable("payload");
    const parts = name.split("/");
    const leaf = parts[parts.length - 1];
    const parent = ["fixture-docs", ...parts.slice(0, -1)];
    const response = await this.#send(
      `${this.#server(id)}/files/create-directory`,
      204,
      "POST",
      { path: `/${parent.join("/")}`, name: leaf },
    );
    await response.body?.cancel();
    await this.fixtureDirectory(id, [...parent, leaf]);
    if ((await this.#fixtureEntries(id, `/fixture-docs/${name}`)).length !== 0)
      throw new WingsUnavailable("payload");
  }
  async copyFixtureWithSuffix(id: string, source: string, original: Buffer) {
    if (
      !fixturePathSegment(source) ||
      !/\.(txt|bin)$/.test(source) ||
      source.length > 72
    )
      throw new WingsUnavailable("payload");
    const root = "/fixture-docs",
      segments = ["fixture-docs"];
    const rows = await this.#fixtureEntries(id, root);
    const before = new Set(rows.map((entry) => entry.name));
    const candidates = Array.from(
      { length: 51 },
      (_, i) =>
        `${source.slice(0, -4)} copy${i ? ` ${i}` : ""}${source.slice(-4)}`,
    );
    if (!candidates.some((name) => !before.has(name)))
      throw new WingsUnavailable("payload");
    const response = await this.#send(
      `${this.#server(id)}/files/copy`,
      204,
      "POST",
      { location: `${root}/${source}` },
    );
    await response.body?.cancel();
    const after = await this.#fixtureEntries(id, root);
    const newCopies = after.filter(
      (entry) => !before.has(entry.name) && candidates.includes(entry.name),
    );
    if (newCopies.length !== 1) throw new WingsUnavailable("payload");
    const name = newCopies[0].name as string;
    if (
      !(await this.fixtureDownload(id, segments, name)).equals(original) ||
      !(await this.fixtureDownload(id, segments, source)).equals(original)
    )
      throw new WingsUnavailable("payload");
    return name;
  }
  async loadFixtureTar(id: string, name: string) {
    if (
      !/^archive-[A-Za-z0-9+_-]+\.tar\.gz$/.test(name) ||
      !fixturePathSegment(name)
    )
      throw new WingsUnavailable("payload");
    const entry = (await this.fixtureDirectory(id, ["fixture-docs"])).find(
      (item) => item.name === name && !item.directory,
    );
    if (!entry) throw new WingsUnavailable("not_found");
    if (entry.size < 1 || entry.size > fixtureTarLimit)
      throw new WingsUnavailable("payload");
    const response = await this.#send(
      `${this.#server(id)}/files/contents?file=${encodeURIComponent(`/fixture-docs/${name}`)}&download=1`,
      200,
    );
    const bytes = await this.#read(response, fixtureTarLimit);
    if (bytes.length !== entry.size) throw new WingsUnavailable("payload");
    return bytes;
  }
  async compressFixture(id: string, files: string[]) {
    if (
      !files.length ||
      files.length > 4 ||
      !files.every((name) => fixturePathSegment(name) && name.endsWith(".txt"))
    )
      throw new WingsUnavailable("payload");
    const response = await this.#send(
      `${this.#server(id)}/files/compress`,
      200,
      "POST",
      { root: "/fixture-docs", files },
    );
    let result: Record<string, unknown>;
    try {
      result = JSON.parse((await this.#read(response, 4096)).toString("utf8"));
    } catch {
      throw new WingsUnavailable("payload");
    }
    if (
      !result ||
      typeof result.name !== "string" ||
      !/^archive-[A-Za-z0-9+_-]+\.tar\.gz$/.test(result.name) ||
      result.file !== true ||
      result.symlink !== false ||
      !Number.isSafeInteger(result.size) ||
      typeof result.size !== "number" ||
      result.size < 1 ||
      result.size > 80000
    )
      throw new WingsUnavailable("payload");
    return {
      name: result.name,
      size: result.size,
      mode: result.mode,
      mode_bits: result.mode_bits,
      created_at: result.created,
      modified_at: result.modified,
      mimetype: "application/tar+gzip",
      directory: false,
    };
  }
  async chmodFixture(id: string, name: string, mode: "600" | "644") {
    if (
      !fixturePathSegment(name) ||
      !name.endsWith(".txt") ||
      !["600", "644"].includes(mode)
    )
      throw new WingsUnavailable("payload");
    await (
      await this.#send(`${this.#server(id)}/files/chmod`, 204, "POST", {
        root: "/fixture-docs",
        files: [{ file: name, mode }],
      })
    ).body?.cancel();
    const current = (
      await this.fixtureDirectoryMetadata(id, ["fixture-docs"])
    ).find((item) => item.name === name && !item.directory);
    if (current?.mode_bits !== mode) throw new WingsUnavailable("payload");
  }
  async renameUploadedFixture(
    id: string,
    source: string,
    target: string,
    moved?: FixtureSubfolder,
    fromMoved?: FixtureSubfolder,
  ) {
    if (
      (moved && !fixtureMoveFolder(moved)) ||
      (fromMoved && !fixtureMoveFolder(fromMoved))
    )
      throw new WingsUnavailable("payload");
    if (
      ![source, target].every(
        (name) => fixturePathSegment(name) && /\.(txt|bin)$/.test(name),
      )
    )
      throw new WingsUnavailable("payload");
    const response = await this.#send(
      `${this.#server(id)}/files/rename`,
      204,
      "PUT",
      {
        root: "/fixture-docs",
        files: [
          {
            from: fromMoved ? `${fromMoved}/${source}` : source,
            to: moved ? `${moved}/${target}` : target,
          },
        ],
      },
    );
    await response.body?.cancel();
  }
  async deleteUploadedFixture(id: string, name: string) {
    if (!fixturePathSegment(name) || !name.endsWith(".txt"))
      throw new WingsUnavailable("payload");
    const response = await this.#send(
      `${this.#server(id)}/files/delete`,
      204,
      "POST",
      { root: "/fixture-docs", files: [name] },
    );
    await response.body?.cancel();
  }
  async uploadFixtureText(
    id: string,
    name: string,
    text: string | ArrayBuffer,
  ) {
    const response = await this.#send(
      `${this.#server(id)}/files/write?file=${encodeURIComponent(`/fixture-docs/${name}`)}`,
      204,
      "POST",
      text,
    );
    await response.body?.cancel();
  }
  async fixtureDirectoryMetadata(id: string, segments: string[]) {
    const list = async (path: string) => {
      const data = await this.#fixtureEntries(id, path);
      return data.flatMap((row) => {
        if (
          !row ||
          typeof row.name !== "string" ||
          !fixturePathSegment(row.name) ||
          row.symlink !== false ||
          !Number.isSafeInteger(row.size) ||
          row.size < 0
        )
          return [];
        const metadata = {
          mode: row.mode,
          mode_bits: row.mode_bits,
          mimetype: row.mime ?? "application/octet-stream",
          created_at: row.created,
          modified_at: row.modified,
        };
        if (
          row.directory === true &&
          row.file === false &&
          typeof row.mode === "string" &&
          row.mode.startsWith("d")
        )
          return [
            {
              name: row.name,
              directory: true,
              size: Number(row.size),
              ...metadata,
            },
          ];
        if (
          row.directory === false &&
          row.file === true &&
          typeof row.mode === "string" &&
          row.mode.startsWith("-")
        )
          return [
            {
              name: row.name,
              directory: false,
              size: Number(row.size),
              ...metadata,
            },
          ];
        return [];
      });
    };
    if (segments.length > 4 || !segments.every(fixturePathSegment))
      throw new WingsUnavailable("payload");
    let path = "/";
    let items = await list(path);
    for (const segment of segments) {
      if (!items.some((item) => item.directory && item.name === segment))
        throw new WingsUnavailable("not_found");
      path = path === "/" ? `/${segment}` : `${path}/${segment}`;
      items = await list(path);
    }
    return items;
  }
  async fixtureDownload(
    id: string,
    segments: string[],
    name: string,
    verifyOnly = false,
  ) {
    const entry = (await this.fixtureDirectory(id, segments)).find(
      (item) => !item.directory && item.name === name,
    );
    if (!entry) throw new WingsUnavailable("not_found");
    if (entry.size > 16384) throw new WingsUnavailable("payload");
    if (verifyOnly) return Buffer.alloc(0);
    const path = `/${[...segments, name].join("/")}`;
    const response = await this.#send(
      `${this.#server(id)}/files/contents?file=${encodeURIComponent(path)}&download=1`,
      200,
    );
    const bytes = await this.#read(response, 16384);
    if (bytes.length !== entry.size) throw new WingsUnavailable("payload");
    return bytes;
  }
  async fixtureText(id: string, directories: string[], name: string) {
    if (!fixturePathSegment(name) || !name.endsWith(".txt"))
      throw new WingsUnavailable("payload");
    const entry = (await this.fixtureDirectory(id, directories)).find(
      (item) => item.name === name && !item.directory,
    );
    if (!entry) throw new WingsUnavailable("not_found");
    if (entry.size > 16384) return null;
    const path = `/${[...directories, name].join("/")}`;
    const response = await this.#send(
      `${this.#server(id)}/files/contents?file=${encodeURIComponent(path)}`,
      200,
    );
    const data = await this.#read(response, 16384);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
      return [...text].every(
        (char) =>
          char === "\t" ||
          char === "\n" ||
          char === "\r" ||
          (char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
      )
        ? { text, bytes: data }
        : null;
    } catch {
      return null;
    }
  }
  async fixtureS3Backup(id: string, backup: string, downloadUrl?: string) {
    if (!UUID_V4.test(backup)) throw new Error("Invalid backup UUID");
    const base = `${this.#server(id)}/backup`;
    const response = downloadUrl
      ? await this.#send(`${base}/${backup}/restore`, 202, "POST", {
          adapter: "s3",
          truncate_directory: false,
          download_url: downloadUrl,
        })
      : await this.#send(base, 202, "POST", {
          adapter: "s3",
          uuid: backup,
          ignore: "",
        });
    await response.body?.cancel();
  }
  async fixtureBackup(
    id: string,
    backup: string,
    operation: "create" | "restore" | "delete",
  ) {
    if (!UUID_V4.test(backup)) throw new Error("Invalid fixture backup UUID");
    const base = `${this.#server(id)}/backup`;
    const response =
      operation === "create"
        ? await this.#send(base, 202, "POST", {
            adapter: "wings",
            uuid: backup,
            ignore: "",
          })
        : operation === "restore"
          ? await this.#send(`${base}/${backup}/restore`, 202, "POST", {
              adapter: "wings",
              truncate_directory: false,
            })
          : await this.#send(
              `${base}/${backup}`,
              204,
              "DELETE",
              undefined,
              "The requested backup was not found on this server.",
            ).catch((err: unknown) => {
              if (err instanceof WingsUnavailable && err.reason === "not_found")
                return null;
              throw err;
            });
    await response?.body?.cancel();
  }
  async writeFixtureText(id: string, text: string) {
    const response = await this.#send(
      `${this.#server(id)}/files/write?file=%2Ffixture-docs%2Fexample.txt`,
      204,
      "POST",
      text,
    );
    await response.body?.cancel();
  }
  /** Bounded digest of all visible directories and regular-file bytes; fail closed on other entries. */
  async transferTreeDigest(id: string) {
    const root = this.#server(id);
    const tree = createHash("sha256").update("relay-transfer-tree-v1\n");
    let count = 0;
    let remaining = 32 * 1024 * 1024;
    const deadline = Date.now() + 30_000;
    const validateTime = () => {
      if (Date.now() > deadline) throw new WingsUnavailable("payload");
    };
    const walk = async (dir: string, depth: number) => {
      validateTime();
      if (depth > 12) throw new WingsUnavailable("payload");
      const response = await this.#send(
        `${root}/files/list-directory?directory=${encodeURIComponent(dir || "/")}`,
        200,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          (await this.#read(response, 262144)).toString("utf8"),
        );
      } catch {
        throw new WingsUnavailable("payload");
      }
      if (!Array.isArray(parsed) || parsed.length > 256 - count)
        throw new WingsUnavailable("payload");
      count += parsed.length;
      const entries = new Map<string, { directory: boolean; size: number }>();
      for (const row of parsed) {
        if (
          !row ||
          typeof row.name !== "string" ||
          !row.name ||
          row.name === "." ||
          row.name === ".." ||
          /[\\/\ufffd]/.test(row.name) ||
          [...row.name].some((ch) => ch.charCodeAt(0) < 32) ||
          Buffer.byteLength(row.name) > 255 ||
          entries.has(row.name) ||
          row.symlink !== false ||
          typeof row.directory !== "boolean" ||
          row.file !== !row.directory ||
          typeof row.mode !== "string" ||
          (row.directory
            ? !row.mode.startsWith("d")
            : !row.mode.startsWith("-")) ||
          !Number.isSafeInteger(row.size) ||
          row.size < 0
        )
          throw new WingsUnavailable("payload");
        entries.set(row.name, { directory: row.directory, size: row.size });
      }
      for (const name of [...entries.keys()].sort()) {
        validateTime();
        const entry = entries.get(name);
        if (!entry) throw new WingsUnavailable("payload");
        const path = dir ? `${dir}/${name}` : name;
        if (entry.directory) {
          tree.update(`${JSON.stringify(["d", path])}\n`);
          await walk(path, depth + 1);
        } else {
          if (entry.size > remaining) throw new WingsUnavailable("payload");
          const result = await this.#send(
            `${root}/files/contents?file=${encodeURIComponent(path)}&download=1`,
            200,
          );
          const data = await this.#read(result, entry.size);
          if (data.length !== entry.size) throw new WingsUnavailable("payload");
          remaining -= data.length;
          tree.update(
            `${JSON.stringify([
              "f",
              path,
              entry.size,
              createHash("sha256").update(data).digest("hex"),
            ])}\n`,
          );
        }
      }
    };
    await walk("", 0);
    validateTime();
    return tree.digest("hex");
  }
  async reinstall(id: string) {
    const result = await this.#send(
      `${this.#server(id)}/reinstall`,
      202,
      "POST",
    );
    await result.body?.cancel();
  }
  async remove(id: string) {
    const response = await this.#send(this.#server(id), 204, "DELETE");
    await response.body?.cancel();
  }
  async #json(
    response: Response,
    limit: number,
  ): Promise<Record<string, unknown>> {
    try {
      const raw: unknown = JSON.parse(
        (await this.#read(response, limit)).toString("utf8"),
      );
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("Invalid payload");
      return raw as Record<string, unknown>;
    } catch {
      throw new WingsUnavailable("payload");
    }
  }
  async #read(response: Response, limit: number): Promise<Buffer> {
    const reader = response.body?.getReader();
    if (!reader) throw new WingsUnavailable("payload");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > limit) throw new Error("response too large");
        chunks.push(result.value);
      }
      return Buffer.concat(chunks);
    } catch {
      throw new WingsUnavailable("payload");
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  async health(): Promise<WingsHealth> {
    const data = await this.#json(await this.#send("/api/system", 200), 16384);
    if (
      typeof data.version !== "string" ||
      typeof data.architecture !== "string" ||
      typeof data.os !== "string" ||
      typeof data.cpu_count !== "number" ||
      !Number.isSafeInteger(data.cpu_count) ||
      data.cpu_count < 1
    )
      throw new Error("invalid payload");
    if (
      data.version !== supportedWings &&
      data.version !== `v${supportedWings}`
    )
      throw new WingsUnavailable("version");
    return {
      version: supportedWings,
      cpuThreads: data.cpu_count,
      architecture: data.architecture,
      os: data.os,
    };
  }
}
