import { useState } from "react";
import type { Locale } from "./i18n";
import { Button } from "./ui";

const fields = [
  "cpuAbsolute",
  "memoryBytes",
  "memoryLimitBytes",
  "diskBytes",
  "uptimeMs",
  "rxBytes",
  "txBytes",
] as const;
type Metrics = Record<(typeof fields)[number], number>;
export function ServerMetrics({ id, locale }: { id: string; locale: Locale }) {
  const en = locale === "en";
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function load() {
    setBusy(true);
    setMetrics(null);
    setError(false);
    try {
      const response = await fetch(
        `/api/v1/servers/${encodeURIComponent(id)}/stats`,
        {
          cache: "no-store",
          credentials: "same-origin",
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok) throw new Error("Metrics unavailable");
      const data = (await response.json()) as Metrics;
      if (
        !data ||
        !fields.every(
          (field) => Number.isFinite(data[field]) && data[field] >= 0,
        )
      )
        throw new Error("Invalid metrics");
      setMetrics(data);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const mib = (bytes: number) => `${number.format(bytes / 1048576)} MiB`;
  return (
    <div aria-busy={busy}>
      <Button onClick={() => void load()} disabled={busy}>
        {en ? "Read resource usage" : "Baca penggunaan sumber daya"}
      </Button>
      {error && (
        <p role="alert">
          {en
            ? "Resource usage is unavailable or restricted to the owner."
            : "Penggunaan sumber daya tidak tersedia atau hanya dapat dibaca oleh pemilik."}
        </p>
      )}
      {metrics && (
        <dl
          aria-label={
            en ? "Wings resource snapshot" : "Cuplikan sumber daya Wings"
          }
        >
          <dt>CPU</dt>
          <dd>{number.format(metrics.cpuAbsolute)}%</dd>
          <dt>{en ? "Memory" : "Memori"}</dt>
          <dd>
            {mib(metrics.memoryBytes)} / {mib(metrics.memoryLimitBytes)}
          </dd>
          <dt>{en ? "Disk" : "Disk"}</dt>
          <dd>{mib(metrics.diskBytes)}</dd>
          <dt>{en ? "Uptime" : "Waktu aktif"}</dt>
          <dd>{number.format(metrics.uptimeMs / 1000)} s</dd>
          <dt>
            {en ? "Network received / sent" : "Jaringan diterima / dikirim"}
          </dt>
          <dd>
            {mib(metrics.rxBytes)} / {mib(metrics.txBytes)}
          </dd>
        </dl>
      )}
    </div>
  );
}
