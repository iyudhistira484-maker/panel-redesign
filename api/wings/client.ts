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
    body?: object,
    allowMissing = false,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.request(`${this.#node.origin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#node.token}`,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
    } catch {
      throw new WingsUnavailable("transport");
    }
    if (response.status !== expected) {
      await response.body?.cancel().catch(() => {});
      throw new WingsUnavailable(
        allowMissing && response.status === 404 ? "not_found" : "http",
      );
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
  async power(id: string, action: "start" | "stop") {
    if (action !== "start" && action !== "stop")
      throw new Error("Unsupported power action");
    const response = await this.#send(
      `${this.#server(id)}/power`,
      202,
      "POST",
      { action, wait_seconds: 10 },
    );
    await response.body?.cancel();
  }
  async state(id: string) {
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
        return data.state;
      default:
        throw new WingsUnavailable("payload");
    }
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
    const root = this.#server(id);
    const list = async (path: string) => {
      const response = await this.#send(
        `${root}/files/list-directory?directory=${encodeURIComponent(path)}`,
        200,
      );
      let data: unknown;
      try {
        data = JSON.parse(
          (await this.#read(response, 131072)).toString("utf8"),
        );
      } catch {
        throw new WingsUnavailable("payload");
      }
      if (!Array.isArray(data) || data.length > 100)
        throw new WingsUnavailable("payload");
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
        if (
          row.directory === true &&
          row.file === false &&
          typeof row.mode === "string" &&
          row.mode.startsWith("d")
        )
          return [{ name: row.name, directory: true, size: Number(row.size) }];
        if (
          row.directory === false &&
          row.file === true &&
          typeof row.mode === "string" &&
          row.mode.startsWith("-")
        )
          return [{ name: row.name, directory: false, size: Number(row.size) }];
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
