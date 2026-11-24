import { useEffect, useId, useState, type FormEvent } from "react";
import type { Locale } from "./i18n";
import { Button, TextInput } from "./ui";

const labels = {
  id: {
    forgot: "Lupa kata sandi",
    reset: "Atur ulang kata sandi",
    email: "Email",
    password: "Kata sandi baru",
    send: "Kirim tautan",
    save: "Simpan kata sandi",
    sent: "Jika akun tersedia, tautan akan dikirim ke email tersebut.",
    saved: "Kata sandi berhasil diperbarui.",
    invalid: "Tautan tidak valid atau sudah kedaluwarsa. Minta tautan baru.",
    failure: "Permintaan belum berhasil. Coba lagi nanti.",
    back: "Kembali ke halaman masuk",
  },
  en: {
    forgot: "Forgot password",
    reset: "Reset password",
    email: "Email",
    password: "New password",
    send: "Send reset link",
    save: "Save password",
    sent: "If the account exists, a reset link will be sent to that email address.",
    saved: "Your password has been updated.",
    invalid: "This link is invalid or expired. Request a new one.",
    failure: "The request could not be completed. Try again later.",
    back: "Back to sign in",
  },
};
export function PasswordRecovery({
  mode,
  locale,
}: {
  mode: "forgot" | "reset";
  locale: Locale;
}) {
  const t = labels[locale],
    id = useId();
  const [token] = useState(() => {
    if (mode !== "reset") return "";
    const raw =
      new URLSearchParams(location.hash.split("?", 2)[1] ?? "").get("token") ??
      "";
    return /^[A-Za-z0-9_-]{43}$/.test(raw) ? raw : "";
  });
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<
    "idle" | "pending" | "sent" | "saved" | "invalid" | "failure"
  >(mode === "reset" && !token ? "invalid" : "idle");
  useEffect(() => {
    if (mode === "reset" && location.hash.startsWith("#reset-password?"))
      history.replaceState(
        null,
        "",
        `${location.pathname}${location.search}#reset-password`,
      );
  }, [mode]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "pending" || (mode === "reset" && !token)) return;
    setStatus("pending");
    try {
      const response = await fetch(
        `/api/v1/auth/${mode === "forgot" ? "forgot-password" : "reset-password"}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            "x-relay-request": "1",
          },
          body: JSON.stringify(
            mode === "forgot" ? { email: value } : { token, password: value },
          ),
          signal: AbortSignal.timeout(10000),
        },
      );
      if (mode === "forgot" && response.status === 202) {
        setStatus("sent");
        setValue("");
      } else if (mode === "reset" && response.status === 204) {
        setStatus("saved");
        setValue("");
      } else if (mode === "reset" && response.status === 400) {
        setStatus("invalid");
        setValue("");
      } else setStatus("failure");
    } catch {
      setStatus("failure");
    }
  }
  const canSubmit =
    status === "idle" || status === "pending" || status === "failure";
  return (
    <>
      <h1>{t[mode]}</h1>
      {canSubmit && (
        <form className="recovery-form" onSubmit={submit}>
          <label htmlFor={id}>{mode === "forgot" ? t.email : t.password}</label>
          <TextInput
            id={id}
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            type={mode === "forgot" ? "email" : "password"}
            autoComplete={mode === "forgot" ? "email" : "new-password"}
            required
            minLength={mode === "reset" ? 12 : undefined}
            maxLength={mode === "forgot" ? 254 : 128}
          />
          <Button
            variant="primary"
            type="submit"
            disabled={status === "pending"}
          >
            {mode === "forgot" ? t.send : t.save}
          </Button>
        </form>
      )}
      {status !== "idle" && status !== "pending" && (
        <p
          role={
            status === "failure" || status === "invalid" ? "alert" : "status"
          }
        >
          {t[status]}
        </p>
      )}
      {status === "invalid" && (
        <a className="button secondary" href="#forgot-password">
          {t.forgot}
        </a>
      )}
      <a className="button ghost" href="#authView">
        {t.back}
      </a>
    </>
  );
}
