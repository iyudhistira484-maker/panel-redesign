import { useEffect, useState } from "react";
import type { Locale } from "./i18n";
import { Button } from "./ui";

type Action = "start" | "stop" | "restart";
async function read(base: string, signal?: AbortSignal) {
  const response = await fetch(`${base}/runtime`, {
    cache: "no-store",
    credentials: "same-origin",
    signal: signal ?? AbortSignal.timeout(6000),
  });
  if (!response.ok) return null;
  const data = await response.json();
  return data?.presence === "present" && typeof data.state === "string"
    ? data.state
    : null;
}
export function ServerPower({ id, locale }: { id: string; locale: Locale }) {
  const en = locale === "en";
  const [state, setState] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [message, setMessage] = useState<
    | "unavailable"
    | "denied"
    | "unknown"
    | "restartAccepted"
    | "pending"
    | "verified"
    | null
  >(null);
  const [desired, setDesired] = useState<string | null>(null);
  const base = `/api/v1/servers/${encodeURIComponent(id)}`;
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(6000),
    ]);
    void read(base, signal)
      .catch(() => null)
      .then((result) => {
        if (!controller.signal.aborted) {
          setState(result);
          setMessage(result ? null : "unavailable");
          setBusy(false);
        }
      });
    return () => controller.abort();
  }, [base]);
  async function refresh() {
    setBusy(true);
    setConfirm(null);
    try {
      const result = await read(base);
      setState(result);
      setMessage(
        !result
          ? "unavailable"
          : desired === result
            ? "verified"
            : desired
              ? "pending"
              : result === state && message === "verified"
                ? "verified"
                : null,
      );
      if (desired === result) setDesired(null);
    } catch {
      setState(null);
      setMessage("unavailable");
    } finally {
      setBusy(false);
    }
  }
  async function send(action: Action) {
    if (busy) return;
    setBusy(true);
    setConfirm(null);
    setMessage(null);
    setState(null);
    try {
      const response = await fetch(`${base}/power`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "x-relay-request": "1", "content-type": "application/json" },
        body: JSON.stringify({ action, confirm: true }),
        signal: AbortSignal.timeout(10000),
      });
      if (response.status !== 202) {
        setDesired(null);
        setMessage(
          [401, 403, 404, 409, 422, 429].includes(response.status)
            ? "denied"
            : "unknown",
        );
        return;
      }
      if (action === "restart") {
        setDesired(null);
        setState(await read(base).catch(() => null));
        setMessage("restartAccepted");
        return;
      }
      const target = action === "start" ? "running" : "offline";
      setDesired(target);
      const result = await read(base).catch(() => null);
      setState(result);
      setMessage(result === target ? "verified" : "pending");
      if (result === target) setDesired(null);
    } catch {
      setDesired(null);
      setMessage("unknown");
    } finally {
      setBusy(false);
    }
  }
  const action =
    state === "offline" ? "start" : state === "running" ? "stop" : null;
  const labels = en
    ? {
        unavailable: "Wings status unavailable.",
        denied: "Request rejected or not available for this server.",
        unknown: "The outcome is unknown. Check status before retrying.",
        pending:
          "Request accepted. The target state is not yet confirmed; refresh status.",
        restartAccepted:
          "Restart requested. Running status alone does not confirm a restart.",
        verified: "Target state verified by Wings.",
      }
    : {
        unavailable: "Status Wings tidak tersedia.",
        denied: "Permintaan ditolak atau tidak tersedia untuk server ini.",
        unknown: "Hasil belum diketahui. Periksa status sebelum mencoba lagi.",
        pending:
          "Permintaan diterima. Status tujuan belum terverifikasi; perbarui status.",
        restartAccepted:
          "Restart diminta. Status berjalan saja tidak membuktikan restart.",
        verified: "Status tujuan terverifikasi oleh Wings.",
      };
  return (
    <div aria-busy={busy}>
      <p>
        {en ? "Wings status:" : "Status Wings:"} {state ?? "—"}
      </p>
      <Button disabled={busy} onClick={() => void refresh()}>
        {en ? "Refresh status" : "Perbarui status"}
      </Button>
      {!confirm && action && !desired && (
        <Button disabled={busy} onClick={() => setConfirm(action)}>
          {action === "start" ? "Start" : "Stop"}
        </Button>
      )}
      {!confirm && state === "running" && !desired && (
        <Button disabled={busy} onClick={() => setConfirm("restart")}>
          Restart
        </Button>
      )}
      {confirm && (
        <div>
          <p>{en ? `Confirm ${confirm}?` : `Konfirmasi ${confirm}?`}</p>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void send(confirm)}
          >
            {en ? "Confirm action" : "Konfirmasi aksi"}
          </Button>
          <Button onClick={() => setConfirm(null)}>
            {en ? "Cancel" : "Batal"}
          </Button>
        </div>
      )}
      {message && <output>{labels[message]}</output>}
    </div>
  );
}
