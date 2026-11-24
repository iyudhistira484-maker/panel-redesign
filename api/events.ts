import type { Executor } from "./db";
// Store only reviewed event identifiers and message keys, not arbitrary payloads.
const catalog = {
  "system.retention": {
    severity: "info",
    detail: "events.retention_completed",
  },
} as const;
export async function recordEvent(db: Executor, type: keyof typeof catalog) {
  const kind = catalog[type];
  await db.execute(
    "INSERT INTO events (type,server_id,severity,detail) VALUES (?,NULL,?,?)",
    [type, kind.severity, kind.detail],
  );
}
export async function prune(db: Executor) {
  for (const table of [
    "sessions",
    "password_resets",
    "auth_throttles",
    "totp_enrollments",
    "api_keys",
  ] as const)
    await db.execute(
      `DELETE FROM ${table} WHERE expires_at<=UTC_TIMESTAMP(3) LIMIT 1000`,
    );
  await db.execute(
    "DELETE FROM events WHERE created_at<UTC_TIMESTAMP(3)-INTERVAL 30 DAY ORDER BY created_at LIMIT 1000",
  );
}
