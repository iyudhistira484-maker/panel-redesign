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
  constructor(readonly reason: "transport" | "http" | "payload" | "version") {
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
      throw new WingsUnavailable("http");
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
    const data = await this.#json(
      await this.#send(this.#server(id), 200),
      65536,
    );
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
  async remove(id: string) {
    const response = await this.#send(this.#server(id), 204, "DELETE");
    await response.body?.cancel();
  }
  async #json(
    response: Response,
    limit: number,
  ): Promise<Record<string, unknown>> {
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
      const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof raw !== "object" || raw === null)
        throw new Error("invalid object");
      return raw as Record<string, unknown>;
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
