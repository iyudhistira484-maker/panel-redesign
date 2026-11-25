import { TotpEnrollment } from "./totp-enrollment";
import { useEffect, useId, useState, type FormEvent } from "react";
import type { Locale } from "./i18n";
import { Button, TextInput } from "./ui";

const copy = {
  id: {
    title: "Masuk",
    email: "Email",
    password: "Kata sandi",
    challenge: "Verifikasi dua langkah",
    code: "Kode autentikator atau pemulihan",
    confirm: "Verifikasi",
    logout: "Keluar",
    back: "Kembali ke masuk",
    signed: "Sesi aktif",
    failed: "Permintaan belum berhasil. Coba lagi.",
    invalid: "Email, kata sandi, atau kode tidak valid.",
    limited: "Terlalu banyak percobaan. Tunggu sebelum mencoba lagi.",
  },
  en: {
    title: "Sign in",
    email: "Email",
    password: "Password",
    challenge: "Two-step verification",
    code: "Authenticator or recovery code",
    confirm: "Verify",
    logout: "Sign out",
    back: "Back to sign in",
    signed: "Active session",
    failed: "The request failed. Try again.",
    invalid: "The email, password, or code is invalid.",
    limited: "Too many attempts. Wait before trying again.",
  },
};
const request = (path: string, options: RequestInit = {}) =>
  fetch(`/api/v1/${path}`, {
    ...options,
    credentials: "same-origin",
    signal: options.signal ?? AbortSignal.timeout(10000),
  });
function post(path: string, body?: object) {
  return request(`auth/${path}`, {
    method: "POST",
    headers: {
      "x-relay-request": "1",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function account(signal?: AbortSignal) {
  const result = await request("account", { signal });
  if (!result.ok) return null;
  const data: unknown = await result.json();
  if (
    !data ||
    typeof data !== "object" ||
    !("displayName" in data) ||
    typeof data.displayName !== "string"
  )
    return null;
  return {
    name: data.displayName,
    canEnroll: "twoFactor" in data && data.twoFactor === false,
  };
}
export function SignIn({ locale }: { locale: Locale }) {
  const t = copy[locale],
    id = useId();
  const [phase, setPhase] = useState<
    "checking" | "login" | "challenge" | "signed"
  >("checking");
  const [name, setName] = useState("");
  const [canEnroll, setCanEnroll] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [email, setEmail] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"failed" | "invalid" | "limited" | null>(
    null,
  );
  useEffect(() => {
    const abort = new AbortController();
    void account(AbortSignal.any([abort.signal, AbortSignal.timeout(6000)]))
      .then((value) => {
        if (abort.signal.aborted) return;
        if (value !== null) {
          setName(value.name);
          setCanEnroll(value.canEnroll);
          setPhase("signed");
        } else setPhase("login");
      })
      .catch(() => {
        if (!abort.signal.aborted) setPhase("login");
      });
    return () => abort.abort();
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result =
        phase === "challenge"
          ? await post("challenge", { code: secret.trim() })
          : await post("login", { email, password: secret });
      setSecret("");
      if (!result.ok) {
        setError(
          result.status === 401
            ? "invalid"
            : result.status === 429
              ? "limited"
              : "failed",
        );
        return;
      }
      const status: unknown = await result.json();
      if (
        status &&
        typeof status === "object" &&
        "twoFactorRequired" in status &&
        status.twoFactorRequired === true
      ) {
        setPhase("challenge");
        return;
      }
      const profile = await account();
      if (profile === null) {
        setError("failed");
        setPhase("login");
        return;
      }
      setName(profile.name);
      setCanEnroll(profile.canEnroll);
      setPhase("signed");
    } catch {
      setSecret("");
      setError("failed");
    } finally {
      setBusy(false);
    }
  }
  async function leave() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await post("logout");
      if (result.status !== 204) {
        setError("failed");
        return;
      }
      setName("");
      setSecret("");
      setPhase("login");
    } catch {
      setError("failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h1>
        {phase === "challenge"
          ? t.challenge
          : phase === "signed"
            ? t.signed
            : t.title}
      </h1>
      {phase === "signed" ? (
        <>
          <p>{name}</p>
          {canEnroll && (
            <TotpEnrollment locale={locale} onBusy={setEnrolling} />
          )}
          <Button onClick={leave} disabled={busy || enrolling}>
            {t.logout}
          </Button>
        </>
      ) : (
        <form
          className="recovery-form"
          onSubmit={submit}
          aria-busy={busy || phase === "checking"}
        >
          {phase !== "challenge" && (
            <>
              <label htmlFor={`${id}-email`}>{t.email}</label>
              <TextInput
                id={`${id}-email`}
                required
                maxLength={254}
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.currentTarget.value)}
                disabled={busy || phase === "checking"}
              />
            </>
          )}
          <label htmlFor={`${id}-secret`}>
            {phase === "challenge" ? t.code : t.password}
          </label>
          <TextInput
            key={phase}
            id={`${id}-secret`}
            type={phase === "challenge" ? "text" : "password"}
            autoComplete={
              phase === "challenge" ? "one-time-code" : "current-password"
            }
            required
            maxLength={phase === "challenge" ? 43 : 128}
            value={secret}
            onChange={(e) => setSecret(e.currentTarget.value)}
            disabled={busy || phase === "checking"}
          />
          <Button
            variant="primary"
            type="submit"
            disabled={busy || phase === "checking"}
          >
            {phase === "challenge" ? t.confirm : t.title}
          </Button>
          {phase === "challenge" && (
            <Button variant="ghost" onClick={leave} disabled={busy}>
              {t.back}
            </Button>
          )}
        </form>
      )}
      {error && <p role="alert">{t[error]}</p>}
    </>
  );
}
