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
