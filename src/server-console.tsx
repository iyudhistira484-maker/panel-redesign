import { consoleSnapshotLimit, isConsoleMarker } from "./console-markers";
import { useState } from "react";
import type { Locale } from "./i18n";
import { Button } from "./ui";

type Snapshot = { lines: string[]; truncated: boolean };
export function ServerConsole({ id, locale }: { id: string; locale: Locale }) {
  const en = locale === "en";
  const [result, setResult] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  async function load() {
    setResult(null);
    setStatus("loading");
    try {
      const response = await fetch(
        `/api/v1/servers/${encodeURIComponent(id)}/console`,
        {
          cache: "no-store",
          credentials: "same-origin",
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok) throw new Error("Console unavailable");
      const data = (await response.json()) as Snapshot;
      if (
        !Array.isArray(data?.lines) ||
        data.lines.length > consoleSnapshotLimit ||
        !data.lines.every(isConsoleMarker) ||
        typeof data.truncated !== "boolean"
      )
        throw new Error("Invalid fixture snapshot");
      setResult(data);
      setStatus("idle");
    } catch {
      setStatus("error");
    }
  }
  return (
    <div aria-busy={status === "loading"}>
      <Button disabled={status === "loading"} onClick={() => void load()}>
        {en ? "Read staging console" : "Baca konsol staging"}
      </Button>
      <p>
        {en
          ? "Read-only snapshot of approved staging markers."
          : "Cuplikan baca-saja, terbatas pada penanda staging yang diizinkan."}
      </p>
      {status === "error" && (
        <p role="alert">
          {en
            ? "Console snapshot unavailable or restricted to the owner."
            : "Cuplikan konsol tidak tersedia atau hanya dapat dibaca oleh pemilik."}
        </p>
      )}
      {result &&
        (result.lines.length ? (
          <section
            aria-label={en ? "Wings console snapshot" : "Cuplikan konsol Wings"}
          >
            <pre>{result.lines.join("\n")}</pre>
          </section>
        ) : (
          <output>
            {en
              ? "No approved console marker found."
              : "Tidak ada penanda konsol yang diizinkan."}
          </output>
        ))}
      {result?.truncated && (
        <p>{en ? "Snapshot truncated." : "Cuplikan dipotong."}</p>
      )}
    </div>
  );
}
