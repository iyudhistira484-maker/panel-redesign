import { useId, useState } from "react";
import type { Locale } from "./i18n";
import { Button } from "./ui";

type Policy = {
  adapter: "wings" | "s3";
  intervalMinutes: number;
  keep: number;
  nextRunAt: string;
};
type Snapshot = {
  schedule: Policy | null;
  runs: {
    slot: string;
    adapter: string;
    outcome: string;
    backupId: string | null;
  }[];
};
export function BackupSchedule({
  id,
  locale,
  s3,
}: {
  id: string;
  locale: Locale;
  s3: boolean;
}) {
  const en = locale === "en";
  const title = en ? "Backup schedule" : "Jadwal backup";
  const prefix = useId();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [adapter, setAdapter] = useState<Policy["adapter"]>("wings");
  const [interval, setIntervalMinutes] = useState("60");
  const [keep, setKeep] = useState("1");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState("");
  const endpoint = `/api/v1/servers/${encodeURIComponent(id)}/backup-schedule`;
  const date = (value: string) =>
    new Date(value).toLocaleString(en ? "en" : "id-ID");
  const outcomes: Record<string, string> = en
    ? {
        reserved: "Waiting for Wings",
        unconfirmed: "Not confirmed",
        ready: "Backup ready",
        create_failed: "Backup failed",
        not_offline: "Skipped: server not offline or unreachable",
        busy: "Skipped: backup operation in progress",
        quota: "Skipped: quota reached",
      }
    : {
        reserved: "Menunggu Wings",
        unconfirmed: "Belum dikonfirmasi",
        ready: "Backup siap",
        create_failed: "Backup gagal",
        not_offline: "Dilewati: server tidak offline atau tidak terjangkau",
        busy: "Dilewati: operasi backup masih berjalan",
        quota: "Dilewati: kuota penuh",
      };
  async function run(method: "GET" | "PUT" | "DELETE") {
    setBusy(true);
    setConfirm(false);
    setMessage("");
    try {
      const request = (verb: string) =>
        fetch(endpoint, {
          method: verb,
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
          headers:
            verb === "GET"
              ? undefined
              : {
                  "x-relay-request": "1",
                  ...(verb === "PUT"
                    ? { "content-type": "application/json" }
                    : {}),
                },
          body:
            verb === "PUT"
              ? JSON.stringify({
                  adapter,
                  intervalMinutes: Number(interval),
                  keep: Number(keep),
                })
              : undefined,
        });
      let result = await request(method);
      if (!result.ok) throw new Error("Schedule request failed");
      if (method === "DELETE") result = await request("GET");
      if (!result.ok) throw new Error("Schedule refresh failed");
      const data = (await result.json()) as Snapshot;
      setSnapshot(data);
      setAdapter(data.schedule?.adapter ?? "wings");
      setIntervalMinutes(String(data.schedule?.intervalMinutes ?? 60));
      setKeep(String(data.schedule?.keep ?? 1));
      if (method !== "GET")
        setMessage(
          method === "PUT"
            ? en
              ? "Schedule saved."
              : "Jadwal disimpan."
            : en
              ? "Schedule disabled. Backups were not deleted."
              : "Jadwal dinonaktifkan. Backup tidak dihapus.",
        );
    } catch {
      setMessage(
        en
          ? "Could not confirm schedule changes. Reload to check."
          : "Perubahan jadwal belum terkonfirmasi. Muat ulang untuk mengecek.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label={title}>
      <h3>{title}</h3>
      <Button disabled={busy} onClick={() => void run("GET")}>
        {snapshot
          ? en
            ? "Refresh schedule and history"
            : "Muat ulang jadwal dan riwayat"
          : en
            ? "Load backup schedule"
            : "Muat jadwal backup"}
      </Button>
      {message && <output>{message}</output>}
      {snapshot && (
        <>
          <p>
            {snapshot.schedule
              ? (en ? "Next run: " : "Jadwal berikutnya: ") +
                date(snapshot.schedule.nextRunAt)
              : en
                ? "No active schedule."
                : "Tidak ada jadwal aktif."}
          </p>
          <p>
            {en
              ? "Runs only when the server is offline. Retention keeps the newest scheduled backups and preserves locked backups."
              : "Hanya berjalan saat server offline. Retensi menyimpan backup terjadwal terbaru dan mempertahankan backup yang terkunci."}
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run("PUT");
            }}
          >
            <fieldset disabled={busy}>
              <legend>{en ? "Schedule settings" : "Pengaturan jadwal"}</legend>
              <label htmlFor={`${prefix}-destination`}>
                {en ? "Destination" : "Penyimpanan"}
              </label>{" "}
              <select
                id={`${prefix}-destination`}
                value={adapter}
                onChange={(event) =>
                  setAdapter(event.target.value === "s3" ? "s3" : "wings")
                }
              >
                <option value="wings">{en ? "Local" : "Lokal"}</option>
                {s3 && <option value="s3">S3</option>}
              </select>{" "}
              <label htmlFor={`${prefix}-interval`}>
                {en ? "Interval (minutes)" : "Interval (menit)"}
              </label>{" "}
              <input
                id={`${prefix}-interval`}
                type="number"
                required
                min={15}
                max={1440}
                value={interval}
                onChange={(event) => setIntervalMinutes(event.target.value)}
              />{" "}
              <label htmlFor={`${prefix}-retention`}>
                {en
                  ? "Scheduled backups to keep"
                  : "Jumlah backup terjadwal yang disimpan"}
              </label>{" "}
              <select
                id={`${prefix}-retention`}
                value={keep}
                onChange={(event) => setKeep(event.target.value)}
              >
                <option value="1">1</option>
                <option value="2">2</option>
              </select>{" "}
              <Button type="submit">
                {en ? "Save schedule" : "Simpan jadwal"}
              </Button>
            </fieldset>
          </form>
          {snapshot.schedule &&
            (confirm ? (
              <p>
                {en ? "Disable future runs?" : "Nonaktifkan jadwal berikutnya?"}{" "}
                <Button disabled={busy} onClick={() => void run("DELETE")}>
                  {en ? "Confirm disable" : "Konfirmasi nonaktifkan"}
                </Button>{" "}
                <Button onClick={() => setConfirm(false)}>
                  {en ? "Cancel" : "Batal"}
                </Button>
              </p>
            ) : (
              <Button disabled={busy} onClick={() => setConfirm(true)}>
                {en ? "Disable schedule" : "Nonaktifkan jadwal"}
              </Button>
            ))}
          <h4>{en ? "Recent runs" : "Riwayat jadwal"}</h4>
          {snapshot.runs.length ? (
            <ol>
              {snapshot.runs.map((run) => (
                <li key={run.slot}>
                  <time dateTime={run.slot}>{date(run.slot)}</time> ·{" "}
                  {run.adapter === "s3" ? "S3" : en ? "Local" : "Lokal"} ·{" "}
                  {outcomes[run.outcome] ?? run.outcome}
                </li>
              ))}
            </ol>
          ) : (
            <p>{en ? "No runs recorded yet." : "Belum ada riwayat jadwal."}</p>
          )}
        </>
      )}
    </section>
  );
}
