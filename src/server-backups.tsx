import { useState } from "react";
import type { Locale } from "./i18n";
import { Button } from "./ui";

type Receipt = {
  id: string;
  state: string;
  locked: number;
  needsReview: number;
  sizeBytes: number | null;
};
type Action = "restore" | "delete";
export function ServerBackups({ id, locale }: { id: string; locale: Locale }) {
  const en = locale === "en";
  const base = `/api/v1/servers/${encodeURIComponent(id)}/backups`;
  const [items, setItems] = useState<Receipt[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState<{ id: string; action: Action } | null>(
    null,
  );
  async function run(method = "GET", suffix = "") {
    setBusy(true);
    setMessage("");
    setConfirm(null);
    try {
      const request = (method: string, path: string) =>
        fetch(base + path, {
          method,
          cache: "no-store",
          credentials: "same-origin",
          signal: AbortSignal.timeout(15000),
        });
      if (method !== "GET") {
        const result = await request(method, suffix);
        if (result.status === 202)
          setMessage(
            en
              ? "Request accepted. Refresh to check completion."
              : "Permintaan diterima. Muat ulang untuk mengecek hasilnya.",
          );
        else if (!result.ok)
          setMessage(
            result.status === 409
              ? en
                ? "Backup conflict: check server state, limit, or backup lock."
                : "Operasi ditolak: periksa status server, batas backup, atau kunci."
              : en
                ? "Operation not confirmed. Check the latest status before retrying."
                : "Operasi belum terkonfirmasi. Periksa status terbaru sebelum mencoba lagi.",
          );
      }
      const result = await request("GET", "");
      if (!result.ok) throw new Error("Backup list unavailable");
      setItems((await result.json()).items);
    } catch {
      setMessage(
        en ? "Backup status unavailable." : "Status backup tidak tersedia.",
      );
      setItems(null);
    } finally {
      setBusy(false);
    }
  }
  const states: Record<string, string> = en
    ? {
        ready: "Ready",
        creating: "Creating",
        restoring: "Restoring",
        create_failed: "Creation failed",
        restore_failed: "Restore failed",
        deleting: "Deletion pending",
      }
    : {
        ready: "Siap",
        creating: "Sedang dibuat",
        restoring: "Sedang dipulihkan",
        create_failed: "Gagal dibuat",
        restore_failed: "Gagal dipulihkan",
        deleting: "Penghapusan tertunda",
      };
  return (
    <section aria-label={en ? "Local backups" : "Backup lokal"}>
      <h3>{en ? "Local backups" : "Backup lokal"}</h3>
      <Button disabled={busy} onClick={() => void run()}>
        {items
          ? en
            ? "Refresh backups"
            : "Muat ulang backup"
          : en
            ? "Load backups"
            : "Muat backup"}
      </Button>
      {message && <output>{message}</output>}
      {items && (
        <>
          <p>
            {en
              ? "Stop the server before creating or restoring. Restore can overwrite files without clearing the directory."
              : "Hentikan server sebelum membuat atau memulihkan backup. Restore bisa menimpa file tanpa mengosongkan direktori."}
          </p>
          <Button
            disabled={busy || items.length >= 3}
            onClick={() => void run("POST")}
          >
            {en ? "Create backup" : "Buat backup"}
          </Button>
          {items.length === 0 && (
            <p>{en ? "No backups yet." : "Belum ada backup."}</p>
          )}
          <ul>
            {items.map((item) => (
              <li key={item.id}>
                <p>
                  <code>{item.id}</code> · {states[item.state] ?? item.state}
                  {item.locked ? ` · ${en ? "Locked" : "Terkunci"}` : ""}
                </p>
                {item.needsReview === 1 && (
                  <p>
                    {en
                      ? "Wings has not confirmed the result. Do not retry or start another backup operation; check Wings logs."
                      : "Wings belum mengonfirmasi hasil. Jangan ulangi operasi backup; periksa log Wings."}
                  </p>
                )}
                {item.state === "restore_failed" && item.locked === 1 && (
                  <Button
                    disabled={busy}
                    onClick={() => void run("POST", `/${item.id}/unlock`)}
                  >
                    {en ? "Unlock backup" : "Buka kunci backup"}
                  </Button>
                )}
                {item.state === "ready" && (
                  <>
                    <a
                      href={`${base}/${encodeURIComponent(item.id)}/download`}
                      download
                    >
                      {en ? "Download backup" : "Unduh backup"}
                    </a>{" "}
                    <Button
                      disabled={busy}
                      onClick={() =>
                        setConfirm({ id: item.id, action: "restore" })
                      }
                    >
                      {en ? "Restore backup" : "Pulihkan backup"}
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void run(
                          "POST",
                          `/${item.id}/${item.locked ? "unlock" : "lock"}`,
                        )
                      }
                    >
                      {item.locked
                        ? en
                          ? "Unlock backup"
                          : "Buka kunci backup"
                        : en
                          ? "Lock backup"
                          : "Kunci backup"}
                    </Button>
                  </>
                )}
                {!item.locked &&
                  [
                    "ready",
                    "create_failed",
                    "restore_failed",
                    "deleting",
                  ].includes(item.state) && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        setConfirm({ id: item.id, action: "delete" })
                      }
                    >
                      {item.state === "deleting"
                        ? en
                          ? "Retry deletion"
                          : "Ulangi hapus"
                        : en
                          ? "Delete backup"
                          : "Hapus backup"}
                    </Button>
                  )}
                {confirm?.id === item.id && (
                  <p>
                    {confirm.action === "delete"
                      ? en
                        ? "Permanently delete this backup?"
                        : "Hapus backup ini secara permanen?"
                      : en
                        ? "Restore and overwrite matching files?"
                        : "Pulihkan dan timpa file yang cocok?"}{" "}
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void (confirm.action === "delete"
                          ? run("DELETE", `/${item.id}`)
                          : run("POST", `/${item.id}/restore`))
                      }
                    >
                      {en ? "Confirm" : "Konfirmasi"}
                    </Button>
                    <Button onClick={() => setConfirm(null)}>
                      {en ? "Cancel" : "Batal"}
                    </Button>
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
