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
    super(`Wings health check: ${reason}`);
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
  async health(): Promise<WingsHealth> {
    let response: Response;
    try {
      response = await this.request(`${this.#node.origin}/api/system`, {
        headers: {
          authorization: `Bearer ${this.#node.token}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      });
    } catch {
      throw new WingsUnavailable("transport");
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw new WingsUnavailable("http");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new WingsUnavailable("payload");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > 16384) throw new Error("response too large");
        chunks.push(result.value);
      }
      const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof raw !== "object" || raw === null)
        throw new Error("invalid object");
      const data = raw as Record<string, unknown>;
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
    } catch (error) {
      if (error instanceof WingsUnavailable) throw error;
      throw new WingsUnavailable("payload");
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}
