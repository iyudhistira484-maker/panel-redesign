import { randomUUID } from "node:crypto";
import { stagingPool } from "./db";
import { migrate } from "./migrate";
import { passwordHash } from "./security";
import { prune, recordEvent } from "./events";

async function main() {
  const pool = stagingPool();
  try {
    const command = process.argv[2];
    if (command === "up") await migrate(pool, "up");
    else if (
      command === "down" &&
      process.env.RELAY_CONFIRM_DOWN === "drop-staging-identity"
    )
      await migrate(pool, "down");
    else if (command === "prune") {
      await prune(pool);
      await recordEvent(pool, "system.retention");
    } else if (
      command === "create-user" ||
      (command === "create-admin" &&
        process.env.RELAY_CONFIRM_ADMIN === "create-staging-admin")
    ) {
      const email = process.argv[3]?.toLowerCase();
      if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+$/.test(email))
        throw new Error("Invalid staging email");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 512) throw new Error("Password input too long");
        chunks.push(bytes);
      }
      const value = Buffer.concat(chunks)
        .toString("utf8")
        .replace(/\r?\n$/, "");
      if ([...value].length < 12 || [...value].length > 128)
        throw new Error("Password length must be 12–128");
      await pool.execute(
        "INSERT INTO users (id,email,display_name,password_hash,is_admin) VALUES (?,?,?,?,?)",
        [
          randomUUID(),
          email,
          email.slice(0, 120),
          await passwordHash(value),
          command === "create-admin",
        ],
      );
    } else
      throw new Error("Unknown CLI command or missing rollback confirmation");
    console.log("OK");
  } finally {
    await pool.end();
  }
}
void main().catch(() => {
  console.error(
    "Staging command failed. Check configuration, migration state or input.",
  );
  process.exitCode = 1;
});
