import { useId, useState, type FormEvent } from "react";
import type { Locale } from "./i18n";
import { Button, TextInput } from "./ui";

function randomUrl(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function base32(bytes: Uint8Array) {
  const bits = Array.from(bytes, (byte) =>
    byte.toString(2).padStart(8, "0"),
  ).join("");
  return (bits.match(/.{1,5}/g) ?? [])
    .map(
      (part) =>
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[
          Number.parseInt(part.padEnd(5, "0"), 2)
        ],
    )
    .join("");
}
async function enroll(step: string, body: object) {
  const result = await fetch(`/api/v1/account/totp/${step}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-relay-request": "1" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return result.status === 204;
}

export function TotpEnrollment({
  locale,
  onBusy,
}: {
  locale: Locale;
  onBusy: (value: boolean) => void;
}) {
  const id = useId(),
    en = locale === "en";
  const [phase, setPhase] = useState<
    "closed" | "begin" | "confirm" | "codes" | "done"
  >("closed");
  const [value, setValue] = useState("");
  const [key, setKey] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    onBusy(true);
    setFailed(false);
    try {
      if (phase === "begin") {
        const bytes = crypto.getRandomValues(new Uint8Array(20));
        if (
          !(await enroll("begin", { password: value, seed: randomUrl(bytes) }))
        ) {
          setFailed(true);
          return;
        }
        setKey(base32(bytes));
        setPhase("confirm");
      } else if (phase === "confirm") {
        const recoveryCodes = Array.from({ length: 10 }, () =>
          randomUrl(crypto.getRandomValues(new Uint8Array(12))),
        );
        if (!(await enroll("confirm", { code: value, recoveryCodes }))) {
          setFailed(true);
          return;
        }
        setKey("");
        setCodes(recoveryCodes);
        setPhase("codes");
      }
    } catch {
      setFailed(true);
    } finally {
      setValue("");
      setBusy(false);
      onBusy(false);
    }
  }
  if (phase === "closed")
    return (
      <Button onClick={() => setPhase("begin")}>
        {en
          ? "Set up two-factor authentication"
          : "Aktifkan autentikasi dua langkah"}
      </Button>
    );
  if (phase === "done")
    return (
      <output>
        {en
          ? "Two-factor authentication is enabled."
          : "Autentikasi dua langkah aktif."}
      </output>
    );
  if (phase === "codes")
    return (
      <section aria-labelledby={`${id}-recovery`}>
        <h2 id={`${id}-recovery`}>
          {en ? "Recovery codes" : "Kode pemulihan"}
        </h2>
        <p>
          {en
            ? "Save these codes somewhere safe. Each can be used once, and they won't be shown again."
            : "Simpan kode ini di tempat aman. Setiap kode hanya dapat dipakai sekali dan tidak akan ditampilkan lagi."}
        </p>
        <ul>
          {codes.map((code) => (
            <li key={code}>
              <code>{code}</code>
            </li>
          ))}
        </ul>
        <Button
          onClick={() => {
            setCodes([]);
            setPhase("done");
          }}
        >
          {en ? "I saved the codes" : "Saya sudah menyimpan kode"}
        </Button>
      </section>
    );
  const label =
    phase === "begin"
      ? en
        ? "Current password"
        : "Kata sandi saat ini"
      : en
        ? "Six-digit code"
        : "Kode enam digit";
  return (
    <form className="recovery-form" onSubmit={submit} aria-busy={busy}>
      {phase === "confirm" && (
        <p>
          {en
            ? "Enter this setup key manually in a time-based authenticator:"
            : "Masukkan kunci ini secara manual di aplikasi autentikator berbasis waktu:"}{" "}
          <code>{key}</code>
        </p>
      )}
      <label htmlFor={id}>{label}</label>
      <TextInput
        key={phase}
        id={id}
        type={phase === "begin" ? "password" : "text"}
        required
        autoComplete={phase === "begin" ? "current-password" : "one-time-code"}
        inputMode={phase === "confirm" ? "numeric" : undefined}
        pattern={phase === "confirm" ? "[0-9]{6}" : undefined}
        maxLength={phase === "confirm" ? 6 : 128}
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        disabled={busy}
      />
      <Button type="submit" variant="primary" disabled={busy}>
        {phase === "begin"
          ? en
            ? "Continue"
            : "Lanjutkan"
          : en
            ? "Enable two-factor authentication"
            : "Konfirmasi autentikasi dua langkah"}
      </Button>
      <Button
        variant="ghost"
        disabled={busy}
        onClick={() => {
          setValue("");
          setKey("");
          setFailed(false);
          setPhase("closed");
        }}
      >
        {en ? "Cancel" : "Batal"}
      </Button>
      {failed && (
        <p role="alert">
          {en
            ? "Could not complete setup. Check your password or code and try again. If setup expired, start over."
            : "Pengaturan belum berhasil. Periksa kata sandi atau kode, lalu coba lagi. Jika pengaturan kedaluwarsa, mulai ulang."}
        </p>
      )}
    </form>
  );
}
