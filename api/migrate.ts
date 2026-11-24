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
      const migrations = [
        { version: 1, file: "001_identity" },
        { version: 2, file: "002_catalog" },
      ];
      if (direction === "down") migrations.reverse();
      for (const { version, file } of migrations) {
        const prior = (
          await rows<{ state: string }>(
            connection,
            "SELECT state FROM relay_migrations WHERE version=?",
            [version],
          )
        )[0];
        if (direction === "up" && prior?.state === "ready") continue;
        if (direction === "up" && prior)
          throw new Error(
            "Incomplete migration; inspect staging and restore or roll back before retry",
          );
        if (direction === "down" && !prior) continue;
        if (direction === "up" && version === 1) {
          const existing = await rows(
            connection,
            "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME<>'relay_migrations'",
          );
          if (existing.length)
            throw new Error("Refusing to migrate a nonempty staging database");
        }
        if (direction === "up" && version === 2) {
          const existing = await rows(
            connection,
            "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('nodes','nests','eggs','allocations','servers')",
          );
          if (existing.length)
            throw new Error(
              "Catalog tables already exist outside the migration ledger",
            );
        }
        const statements = (
          await readFile(
            new URL(`../migrations/${file}.${direction}.sql`, import.meta.url),
            "utf8",
          )
        )
          .split(";")
          .map((x) => x.trim())
          .filter(Boolean);
        await connection.execute(
          direction === "up"
            ? "INSERT INTO relay_migrations (version,state) VALUES (?,'applying')"
            : "UPDATE relay_migrations SET state='reverting' WHERE version=?",
          [version],
        );
        for (const statement of statements) await connection.execute(statement);
        await connection.execute(
          direction === "up"
            ? "UPDATE relay_migrations SET state='ready' WHERE version=?"
            : "DELETE FROM relay_migrations WHERE version=?",
          [version],
        );
      }
    } finally {
      await connection.execute("SELECT RELEASE_LOCK(?)", [lock]);
    }
  } finally {
    connection.release();
  }
}
