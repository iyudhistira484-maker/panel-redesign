import { useId, useState, type FormEvent } from "react";
import type { Locale } from "./i18n";
import { Button, TextInput } from "./ui";

type PowerPermission = "control.start" | "control.stop";
type Subuser = { id: string; email: string; permissions: string[] };
type Snapshot = { items: Subuser[]; truncated: boolean };
export function ServerAccess({ id, locale }: { id: string; locale: Locale }) {
  const en = locale === "en",
    input = useId();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState<Snapshot | null>(null);
  const [listError, setListError] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [powerChange, setPowerChange] = useState<{
    address: string;
    permission: PowerPermission;
    action: "grant" | "revoke";
  } | null>(null);
  const base = `/api/v1/servers/${encodeURIComponent(id)}`;
  async function readList() {
    setList(null);
    setListError(false);
    try {
      const response = await fetch(`${base}/subusers`, {
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("Subusers unavailable");
      const data = (await response.json()) as Snapshot;
      if (
        !Array.isArray(data?.items) ||
        data.items.length > 100 ||
        typeof data.truncated !== "boolean" ||
        !data.items.every(
          (row) =>
            typeof row?.id === "string" &&
            typeof row.email === "string" &&
            Array.isArray(row.permissions) &&
            row.permissions.every((value) => typeof value === "string"),
        )
      )
        throw new Error("Invalid subusers");
      setList(data);
    } catch {
      setListError(true);
    }
  }
  async function load() {
    setBusy(true);
    setConfirm(null);
    try {
      await readList();
    } finally {
      setBusy(false);
    }
  }
  const [result, setResult] = useState<
    "grant" | "revoke" | "power" | "subuser" | "error" | null
  >(null);
  const [subuserChange, setSubuserChange] = useState<{
    address: string;
    mode: "none" | "read" | "write" | "remove";
  } | null>(null);
  async function manageSubuser(
    address: string,
    action: "invite" | "set-sftp" | "remove",
    mode?: "none" | "read" | "write",
  ) {
    if (busy) return;
    setBusy(true);
    setResult(null);
    setSubuserChange(null);
    try {
      const response = await fetch(`${base}/subusers`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-relay-request": "1" },
        body: JSON.stringify({ email: address, action, mode }),
        signal: AbortSignal.timeout(10000),
      });
      if (response.status !== 204) throw new Error("Subuser change rejected");
      setResult(action === "invite" ? "grant" : "subuser");
      await readList();
    } catch {
      setResult("error");
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute(
      "value",
    );
    if (action === "invite") await manageSubuser(email, "invite");
    if (action === "grant" || action === "revoke") await change(email, action);
  }
  async function change(
    address: string,
    action: "grant" | "revoke",
    permission?: PowerPermission,
  ) {
    if (busy) return;
    setConfirm(null);
    setPowerChange(null);
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch(`${base}/activity-access`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-relay-request": "1",
        },
        body: JSON.stringify({ email: address, action, permission }),
        signal: AbortSignal.timeout(10000),
      });
      setResult(
        response.status === 204 ? (permission ? "power" : action) : "error",
      );
      if (list) await readList();
    } catch {
      setResult("error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <form className="recovery-form" onSubmit={submit} aria-busy={busy}>
        <h3>{en ? "Manage activity access" : "Kelola akses aktivitas"}</h3>
        <p>
          {en
            ? "Share activity only with an existing account. Other grants are not changed."
            : "Bagikan akses aktivitas saja ke akun yang sudah ada. Izin lain tidak diubah."}
        </p>
        <label htmlFor={input}>{en ? "Subuser email" : "Email subuser"}</label>
        <TextInput
          id={input}
          type="email"
          required
          maxLength={254}
          value={email}
          onChange={(event) => {
            setEmail(event.currentTarget.value);
            setResult(null);
          }}
          disabled={busy}
        />
        <Button type="submit" value="grant" disabled={busy}>
          {en ? "Grant activity access" : "Beri akses aktivitas"}
        </Button>
        <Button type="submit" value="invite" disabled={busy}>
          {en ? "Add existing account" : "Tambah akun yang sudah ada"}
        </Button>
        {result === "subuser" && (
          <output>
            {en ? "Subuser access updated." : "Akses subuser diperbarui."}
          </output>
        )}
        <Button type="submit" value="revoke" disabled={busy}>
          {en ? "Revoke activity access" : "Cabut akses aktivitas"}
        </Button>
        {result === "error" && (
          <p role="alert">
            {en
              ? "Access could not be changed. Check the account and its existing grant."
              : "Akses tidak dapat diubah. Periksa akun dan izin yang sudah ada."}
          </p>
        )}
        {result === "power" && (
          <output>
            {en
              ? "Power permission updated."
              : "Izin kontrol server diperbarui."}
          </output>
        )}
        {(result === "grant" || result === "revoke") && (
          <output>
            {result === "grant"
              ? en
                ? "Activity access granted."
                : "Akses aktivitas diberikan."
              : en
                ? "Activity access revoked."
                : "Akses aktivitas dicabut."}
          </output>
        )}
      </form>
      <section aria-busy={busy}>
        <Button onClick={() => void load()} disabled={busy}>
          {en ? "Load subusers" : "Muat daftar subuser"}
        </Button>
        {listError && (
          <p role="alert">
            {en ? "Could not load subusers." : "Daftar subuser gagal dimuat."}
          </p>
        )}
        {list?.items.length === 0 && (
          <output>
            {en ? "No active subusers." : "Tidak ada subuser aktif."}
          </output>
        )}
        {!!list?.items.length && (
          <ul aria-label={en ? "Active subusers" : "Subuser aktif"}>
            {list.items.map((row) => (
              <li key={row.id}>
                <strong>{row.email}</strong>
                <p>{row.permissions.join(", ")}</p>
                {(["read", "write", "none", "remove"] as const).map((mode) => (
                  <Button
                    key={mode}
                    disabled={busy}
                    onClick={() =>
                      setSubuserChange({ address: row.email, mode })
                    }
                  >
                    {en
                      ? {
                          read: "SFTP read only",
                          write: "SFTP read and write",
                          none: "Disable SFTP",
                          remove: "Remove subuser",
                        }[mode]
                      : {
                          read: "SFTP baca saja",
                          write: "SFTP baca dan tulis",
                          none: "Nonaktifkan SFTP",
                          remove: "Hapus subuser",
                        }[mode]}
                  </Button>
                ))}
                {subuserChange?.address === row.email && (
                  <div>
                    <p>
                      {row.email} · {subuserChange.mode}
                    </p>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void (subuserChange.mode === "remove"
                          ? manageSubuser(row.email, "remove")
                          : manageSubuser(
                              row.email,
                              "set-sftp",
                              subuserChange.mode,
                            ))
                      }
                    >
                      {en
                        ? "Confirm subuser change"
                        : "Konfirmasi perubahan subuser"}
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() => setSubuserChange(null)}
                    >
                      {en ? "Cancel" : "Batal"}
                    </Button>
                  </div>
                )}
                {(["control.start", "control.stop"] as const).map(
                  (permission) => {
                    const name =
                      permission === "control.start" ? "Start" : "Stop";
                    const action = row.permissions.includes(permission)
                      ? "revoke"
                      : "grant";
                    return (
                      <Button
                        key={permission}
                        disabled={busy}
                        onClick={() => {
                          setConfirm(null);
                          setPowerChange({
                            address: row.email,
                            permission,
                            action,
                          });
                        }}
                      >
                        {action === "grant"
                          ? en
                            ? `Grant ${name}`
                            : `Beri izin ${name}`
                          : en
                            ? `Revoke ${name}`
                            : `Cabut izin ${name}`}
                      </Button>
                    );
                  },
                )}
                {powerChange?.address === row.email && (
                  <div>
                    <p>
                      {row.email} · {powerChange.permission} ·{" "}
                      {powerChange.action}
                    </p>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void change(
                          row.email,
                          powerChange.action,
                          powerChange.permission,
                        )
                      }
                    >
                      {en
                        ? "Confirm permission change"
                        : "Konfirmasi perubahan izin"}
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() => setPowerChange(null)}
                    >
                      {en ? "Cancel" : "Batal"}
                    </Button>
                  </div>
                )}
                {row.permissions.length === 1 &&
                  row.permissions[0] === "activity.read" &&
                  (confirm === row.email ? (
                    <>
                      <p>
                        {en
                          ? `Revoke activity access for ${row.email}?`
                          : `Cabut akses aktivitas untuk ${row.email}?`}
                      </p>
                      <Button
                        onClick={() => void change(row.email, "revoke")}
                        disabled={busy}
                      >
                        {en ? "Confirm revocation" : "Konfirmasi cabut akses"}
                      </Button>
                      <Button onClick={() => setConfirm(null)} disabled={busy}>
                        {en ? "Cancel" : "Batal"}
                      </Button>
                    </>
                  ) : (
                    <Button
                      onClick={() => setConfirm(row.email)}
                      disabled={busy}
                    >
                      {en ? "Revoke access" : "Cabut akses"}
                    </Button>
                  ))}
              </li>
            ))}
          </ul>
        )}
        {list?.truncated && (
          <p>
            {en
              ? "Showing the first 100 subusers."
              : "Menampilkan 100 subuser pertama."}
          </p>
        )}
      </section>
    </>
  );
}
