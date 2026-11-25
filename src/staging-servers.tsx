import { ServerMetrics } from "./server-metrics";
import { ServerPower } from "./server-power";
import { useState } from "react";
import type { Locale } from "./i18n";
import { Button } from "./ui";

type ServerSummary = { id: string; name: string };
export function StagingServers({ locale }: { locale: Locale }) {
  const en = locale === "en";
  const [opened, setOpened] = useState<string | null>(null);
  const [items, setItems] = useState<ServerSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [status, setStatus] = useState<
    "idle" | "busy" | "ready" | "expired" | "error"
  >("idle");
  async function load(after?: string) {
    setStatus("busy");
    if (!after) {
      setItems([]);
      setNext(null);
    }
    try {
      const response = await fetch(
        `/api/v1/servers${after ? `?after=${encodeURIComponent(after)}` : ""}`,
        {
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
        },
      );
      if (response.status === 401) {
        setItems([]);
        setNext(null);
        setStatus("expired");
        return;
      }
      if (!response.ok) throw new Error("Catalog unavailable");
      const data = (await response.json()) as {
        items: ServerSummary[];
        next: string | null;
      };
      if (
        !Array.isArray(data.items) ||
        !data.items.every(
          (item) =>
            typeof item?.id === "string" && typeof item.name === "string",
        ) ||
        (data.next !== null && typeof data.next !== "string")
      )
        throw new Error("Invalid catalog");
      setItems((current) => (after ? [...current, ...data.items] : data.items));
      setNext(data.next);
      setStatus("ready");
    } catch {
      setItems([]);
      setNext(null);
      setStatus("error");
    }
  }
  return (
    <section aria-busy={status === "busy"}>
      <h2>{en ? "Staging servers" : "Server staging"}</h2>
      <p>
        {en
          ? "Server list from the staging API."
          : "Daftar server dari API staging."}
      </p>
      <Button onClick={() => void load()} disabled={status === "busy"}>
        {en ? "Load servers" : "Muat daftar server"}
      </Button>
      {status === "expired" && (
        <p role="alert">
          {en
            ? "Session expired. Sign in again."
            : "Sesi berakhir. Masuk kembali."}
        </p>
      )}
      {status === "error" && (
        <p role="alert">
          {en ? "Could not load servers." : "Daftar server gagal dimuat."}
        </p>
      )}
      {status === "ready" && !items.length && (
        <output>
          {en
            ? "No accessible servers."
            : "Tidak ada server yang dapat diakses."}
        </output>
      )}
      {!!items.length && (
        <ul
          aria-label={en ? "Accessible servers" : "Server yang dapat diakses"}
        >
          {items.map((item) => (
            <li key={item.id} data-server-id={item.id}>
              {item.name}{" "}
              <Button
                aria-expanded={opened === item.id}
                onClick={() => setOpened(opened === item.id ? null : item.id)}
              >
                {en ? "Server detail" : "Detail server"}
              </Button>
              {opened === item.id && (
                <>
                  <ServerPower id={item.id} locale={locale} />
                  <ServerMetrics id={item.id} locale={locale} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {next && (
        <Button onClick={() => void load(next)} disabled={status === "busy"}>
          {en ? "Load more" : "Muat lagi"}
        </Button>
      )}
    </section>
  );
}
