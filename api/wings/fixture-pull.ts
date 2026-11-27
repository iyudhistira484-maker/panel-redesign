import { fixtureTextLimit } from "./fixture-gzip";

export function validatePullSource(source: string) {
  const url = new URL(source);
  if (
    url.href !== source ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/fixture.txt"
  )
    throw new Error("Remote pull requires an exact disposable loopback source");
  return url.href;
}

export async function readPullSource(
  approved: string,
  request: typeof fetch = fetch,
) {
  const response = await request(validatePullSource(approved), {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    headers: { accept: "text/plain", "accept-encoding": "identity" },
  });
  try {
    const length = response.headers.get("content-length");
    if (
      response.status !== 200 ||
      !response.body ||
      response.headers.get("content-encoding") ||
      (length !== null &&
        (!/^\d+$/.test(length) || Number(length) > fixtureTextLimit))
    )
      throw new Error("Invalid pull response");
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > fixtureTextLimit)
          throw new Error("Pull source exceeds limit");
        parts.push(value);
      }
      if (length !== null && size !== Number(length))
        throw new Error("Incomplete pull response");
      const bytes = Buffer.concat(parts);
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } finally {
      await reader.cancel().catch(() => {});
    }
  } finally {
    if (!response.body?.locked) await response.body?.cancel().catch(() => {});
  }
}
