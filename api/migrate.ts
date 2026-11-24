import type { Pool } from "mysql2/promise";
import { readFile } from "node:fs/promises";
import { rows } from "./db";
export async function migrate(pool: Pool, direction: "up" | "down") {
  const connection = await pool.getConnection();
  try {
    const database = (
      await rows<{ name: string }>(connection, "SELECT DATABASE() AS name")
    )[0]?.name;
    if (!/^relay_(staging|test)(_[a-z0-9]+)?$/.test(database ?? ""))
      throw new Error("Dedicated staging database required");
    const lock = `${database}:relay-migrations`;
    if (
      (
        await rows<{ ok: number }>(connection, "SELECT GET_LOCK(?,10) AS ok", [
          lock,
        ])
      )[0]?.ok !== 1
    )
      throw new Error("Migration lock unavailable");
    try {
      await connection.execute(
        "CREATE TABLE IF NOT EXISTS relay_migrations (version INT PRIMARY KEY, state ENUM('applying','ready','reverting') NOT NULL) ENGINE=InnoDB",
      );
      const prior = (
        await rows<{ state: string }>(
          connection,
          "SELECT state FROM relay_migrations WHERE version=1",
        )
      )[0];
      if (direction === "up" && prior?.state === "ready") return;
      if (direction === "up" && prior)
        throw new Error(
          "Incomplete migration; inspect staging and restore or roll back before retry",
        );
      if (direction === "down" && !prior) return;
      if (direction === "up") {
        const existing = await rows<{ name: string }>(
          connection,
          "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME<>'relay_migrations'",
        );
        if (existing.length)
          throw new Error("Refusing to migrate a nonempty staging database");
      }
      const statements = (
        await readFile(
          new URL(
            `../migrations/001_identity.${direction}.sql`,
            import.meta.url,
          ),
          "utf8",
        )
      )
        .split(";")
        .map((x) => x.trim())
        .filter(Boolean);
      if (direction === "up")
        await connection.execute(
          "INSERT INTO relay_migrations (version,state) VALUES (1,'applying')",
        );
      else
        await connection.execute(
          "UPDATE relay_migrations SET state='reverting' WHERE version=1",
        );
      for (const statement of statements) await connection.execute(statement);
      if (direction === "up")
        await connection.execute(
          "UPDATE relay_migrations SET state='ready' WHERE version=1",
        );
      else
        await connection.execute(
          "DELETE FROM relay_migrations WHERE version=1",
        );
    } finally {
      await connection.execute("SELECT RELEASE_LOCK(?)", [lock]);
    }
  } finally {
    connection.release();
  }
}
