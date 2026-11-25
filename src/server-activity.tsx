import { useState } from "react";
import type { Locale } from "./i18n";
import { Button } from "./ui";

const eventLabels = {
  "wings.power_start_requested": ["Start diminta", "Start requested"],
  "wings.power_stop_requested": ["Stop diminta", "Stop requested"],
  "wings.power_start_uncertain": [
    "Hasil Start tidak diketahui",
    "Start outcome unknown",
  ],
  "wings.power_stop_uncertain": [
    "Hasil Stop tidak diketahui",
    "Stop outcome unknown",
  ],
} as const;
type Entry = {
  id: string;
  event: string;
  created_at: string;
  actor_name: string | null;
};
export function ServerActivity({ id, locale }: { id: string; locale: Locale }) {
  const en = locale === "en";
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [status, setStatus] = useState<"idle" | "busy" | "error">("idle");
  async function load() {
    setStatus("busy");
    setEntries(null);
    try {
      const response = await fetch(
        `/api/v1/servers/${encodeURIComponent(id)}/activity`,
        {
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok) throw new Error("History unavailable");
      const result = (await response.json()) as Entry[];
      if (
        !Array.isArray(result) ||
        result.length > 100 ||
        !result.every(
          (e) =>
            typeof e?.id === "string" &&
            typeof e.event === "string" &&
            typeof e.created_at === "string" &&
            Number.isFinite(Date.parse(e.created_at)) &&
            (e.actor_name === null || typeof e.actor_name === "string"),
        )
      )
        throw new Error("Invalid history");
      setEntries(result);
      setStatus("idle");
    } catch {
      setStatus("error");
    }
  }
  const formatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
  return (
    <div aria-busy={status === "busy"}>
      <Button onClick={() => void load()} disabled={status === "busy"}>
        {en ? "Read server activity" : "Baca aktivitas server"}
      </Button>
      {status === "error" && (
        <p role="alert">
          {en
            ? "Server activity is unavailable or restricted."
            : "Aktivitas server tidak tersedia atau dibatasi."}
        </p>
      )}
      {entries?.length === 0 && (
        <output>
          {en ? "No activity recorded." : "Belum ada aktivitas tercatat."}
        </output>
      )}
      {!!entries?.length && (
        <ol aria-label={en ? "Server activity" : "Aktivitas server"}>
          {entries.map((entry) => {
            const labels = Object.hasOwn(eventLabels, entry.event)
              ? eventLabels[entry.event as keyof typeof eventLabels]
              : null;
            return (
              <li key={entry.id}>
                <strong>{labels?.[en ? 1 : 0] ?? entry.event}</strong>
                {" · "}
                {entry.actor_name ??
                  (en ? "Unknown actor" : "Pelaku tidak diketahui")}
                {" · "}
                <time dateTime={entry.created_at}>
                  {formatter.format(new Date(entry.created_at))}
                </time>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
