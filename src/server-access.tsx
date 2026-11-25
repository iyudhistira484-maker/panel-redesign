import { useId, useState, type FormEvent } from "react";
import type { Locale } from "./i18n";
import { Button, TextInput } from "./ui";

export function ServerAccess({ id, locale }: { id: string; locale: Locale }) {
  const en = locale === "en",
    input = useId();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"grant" | "revoke" | "error" | null>(
    null,
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute(
      "value",
    );
    if (busy || (action !== "grant" && action !== "revoke")) return;
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch(
        `/api/v1/servers/${encodeURIComponent(id)}/activity-access`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            "x-relay-request": "1",
          },
          body: JSON.stringify({ email, action }),
          signal: AbortSignal.timeout(10000),
        },
      );
      setResult(response.status === 204 ? action : "error");
    } catch {
      setResult("error");
    } finally {
      setBusy(false);
    }
  }
  return (
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
  );
}
