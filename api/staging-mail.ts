import nodemailer from "nodemailer";
import type { ResetMessage } from "./app";

export function stagingMail(origin: string) {
  const mail = nodemailer.createTransport({
    host: "127.0.0.1",
    port: 1025,
    ignoreTLS: true,
    connectionTimeout: 2000,
    socketTimeout: 5000,
  });
  return {
    close: () => mail.close(),
    async deliverReset({ email, locale, token }: ResetMessage) {
      if (!/^[A-Z0-9._%+-]+@example\.test$/i.test(email))
        throw new Error("Only staging mail recipients are permitted");
      const id = locale === "id";
      // Fragment prevents the token entering reverse-proxy access logs. UI wiring is Stage 4.
      const url = new URL("/#reset-password", origin);
      url.hash = `reset-password?token=${token}`;
      await mail.sendMail({
        from: "relay@example.test",
        to: email,
        subject: id
          ? "Atur ulang kata sandi Relay"
          : "Reset your Relay password",
        text: `${id ? "Gunakan tautan ini dalam 30 menit. Abaikan email ini jika kamu tidak meminta pengaturan ulang." : "Use this link within 30 minutes. Ignore this message if you did not request a password reset."}\n\n${url.href}`,
      });
    },
  };
}
