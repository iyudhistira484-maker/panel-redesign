import { useState } from "react";
import type { Locale } from "./i18n";
import { Button } from "./ui";

type Database = {
  id: string;
  label: string;
  recoveryState: string;
  recoveryNeedsReview: number;
  recoveryBackupId: string | null;
  recoveryStartedAt: string | null;
};
type Backup = {
  id: string;
  state: string;
  sizeBytes: number | null;
  createdAt: string;
};

export function AppDatabases({ id, locale }: { id: string; locale: Locale }) {
  const en = locale === "en";
  const title = en ? "Application databases" : "Database aplikasi";
  const base = `/api/v1/servers/${encodeURIComponent(id)}/databases`;
  const [databases, setDatabases] = useState<Database[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [items, setItems] = useState<Backup[]>([]);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const current = databases?.find((database) => database.id === selected);
  const date = (timestamp: string) =>
    new Date(timestamp).toLocaleString(en ? "en" : "id-ID");
  const states: Record<string, string> = en
    ? {
        empty: "Recovery target empty",
        restoring: "Restore in progress",
        needs_review: "Review required",
        restored: "Restored",
      }
    : {
        empty: "Tujuan pemulihan kosong",
        restoring: "Sedang dipulihkan",
        needs_review: "Perlu diperiksa",
        restored: "Sudah dipulihkan",
      };
  const backupStates: Record<string, string> = en
    ? { creating: "Creating", ready: "Ready", failed: "Failed" }
    : { creating: "Sedang dibuat", ready: "Siap", failed: "Gagal" };

  async function run(
    database?: string,
    operation?: "backup" | "restore",
    backup?: string,
  ) {
    setBusy(true);
    setMessage("");
    setConfirm(null);
    if (database !== selected) {
      setSelected(null);
      setItems([]);
    }
    const path = database
      ? `${base}/${encodeURIComponent(database)}/backups`
      : "";
    const request = (url: string, method = "GET", restore = false) =>
      fetch(url, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(18000),
        headers:
          method === "GET"
            ? undefined
            : {
                "x-relay-request": "1",
                ...(restore ? { "content-type": "application/json" } : {}),
              },
        body: restore ? JSON.stringify({ confirm: true }) : undefined,
      });
    try {
      if (operation) {
        const result = await request(
          operation === "restore"
            ? `${path}/${encodeURIComponent(backup ?? "")}/restore`
            : path,
          "POST",
          operation === "restore",
        );
        setMessage(
          result.ok
            ? operation === "restore"
              ? en
                ? "Restore completed."
                : "Pemulihan selesai."
              : en
                ? "Backup created."
                : "Backup dibuat."
            : result.status === 502 && operation === "restore"
              ? en
                ? "Restore result unconfirmed. Do not retry."
                : "Hasil restore belum terkonfirmasi. Jangan ulangi."
              : en
                ? "Operation not confirmed. Refresh the status."
                : "Operasi belum terkonfirmasi. Muat ulang status.",
        );
      }
      const listing = await request(base);
      if (!listing.ok) throw new Error("Database list unavailable");
      const data = (await listing.json()) as { items: Database[] };
      if (!Array.isArray(data.items)) throw new Error("Invalid database list");
      setDatabases(data.items);
      if (database && data.items.some((item) => item.id === database)) {
        const response = await request(path);
        if (!response.ok) throw new Error("Backup list unavailable");
        const result = (await response.json()) as { items: Backup[] };
        if (!Array.isArray(result.items))
          throw new Error("Invalid backup list");
        setItems(result.items);
        setSelected(database);
      } else {
        setItems([]);
        setSelected(null);
      }
    } catch {
      setMessage(
        en
          ? "Database status unavailable. Refresh before trying again."
          : "Status database tidak tersedia. Muat ulang sebelum mencoba lagi.",
      );
      setDatabases(null);
      setSelected(null);
      setItems([]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label={title} aria-busy={busy}>
      <h3>{title}</h3>
      <Button disabled={busy} onClick={() => void run(selected ?? undefined)}>
        {databases
          ? en
            ? "Refresh database status"
            : "Muat ulang status database"
          : en
            ? "Load databases"
            : "Muat database"}
      </Button>
      {message && <output>{message}</output>}
      {databases && databases.length === 0 && (
        <p>
          {en
            ? "No database is configured for this server."
            : "Belum ada database untuk server ini."}
        </p>
      )}
      {databases && databases.length > 0 && (
        <ul>
          {databases.map((database) => (
            <li key={database.id}>
              <Button
                disabled={busy}
                aria-pressed={selected === database.id}
                onClick={() => void run(database.id)}
              >
                {database.label}
              </Button>
              {" · "}
              {database.recoveryNeedsReview
                ? states.needs_review
                : (states[database.recoveryState] ?? database.recoveryState)}
            </li>
          ))}
        </ul>
      )}
      {current && (
        <section aria-label={current.label}>
          <h4>{current.label}</h4>
          <p>
            {current.recoveryNeedsReview
              ? states.needs_review
              : (states[current.recoveryState] ?? current.recoveryState)}
          </p>
          {current.recoveryNeedsReview === 1 && (
            <p role="alert">
              {en
                ? "The target may contain a partial restore. Do not retry or connect the application until an operator verifies it."
                : "Tujuan mungkin berisi hasil restore sebagian. Jangan ulangi atau sambungkan aplikasi sebelum operator memeriksanya."}
            </p>
          )}
          {current.recoveryBackupId && (
            <p>
              {en ? "Recovery backup:" : "Backup pemulihan:"}{" "}
              <code>{current.recoveryBackupId}</code>
              {current.recoveryStartedAt && (
                <>
                  {" "}
                  ·{" "}
                  <time dateTime={current.recoveryStartedAt}>
                    {date(current.recoveryStartedAt)}
                  </time>
                </>
              )}
            </p>
          )}
          <Button
            disabled={
              busy ||
              items.length >= 3 ||
              items.some((item) => item.state === "creating")
            }
            onClick={() => void run(current.id, "backup")}
          >
            {en ? "Create database backup" : "Buat backup database"}
          </Button>
          {items.length === 0 && (
            <p>
              {en ? "No database backups yet." : "Belum ada backup database."}
            </p>
          )}
          {items.length > 0 && (
            <ul>
              {items.map((item) => (
                <li key={item.id}>
                  <p>
                    <code>{item.id}</code> ·{" "}
                    {backupStates[item.state] ?? item.state}
                    {item.sizeBytes !== null ? ` · ${item.sizeBytes} B` : ""} ·{" "}
                    <time dateTime={item.createdAt}>
                      {date(item.createdAt)}
                    </time>
                  </p>
                  {item.state === "ready" &&
                    current.recoveryState === "empty" &&
                    current.recoveryNeedsReview === 0 && (
                      <Button
                        disabled={busy}
                        onClick={() => setConfirm(item.id)}
                      >
                        {en
                          ? "Restore database backup"
                          : "Pulihkan backup database"}
                      </Button>
                    )}
                  {confirm === item.id && (
                    <p>
                      {en
                        ? "Restore to the separate, empty recovery database? The source will not be overwritten."
                        : "Pulihkan ke database tujuan yang terpisah dan kosong? Database sumber tidak akan ditimpa."}{" "}
                      <Button
                        disabled={busy}
                        onClick={() => void run(current.id, "restore", item.id)}
                      >
                        {en
                          ? "Confirm database restore"
                          : "Konfirmasi restore database"}
                      </Button>{" "}
                      <Button onClick={() => setConfirm(null)}>
                        {en ? "Cancel" : "Batal"}
                      </Button>
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  );
}
