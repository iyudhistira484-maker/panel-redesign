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
        { version: 3, file: "003_provision" },
        { version: 4, file: "004_lifecycle" },
        { version: 5, file: "005_transfer" },
        { version: 6, file: "006_transfer_dispatch" },
        { version: 7, file: "007_transfer_digest" },
        { version: 8, file: "008_fixture_mode" },
        { version: 9, file: "009_server_grants" },
        { version: 10, file: "010_mumble_max_users" },
        { version: 11, file: "011_secondary_allocations" },
        { version: 12, file: "012_client_power" },
        { version: 13, file: "013_client_console" },
        { version: 14, file: "014_client_stream" },
        { version: 15, file: "015_client_files" },
        { version: 16, file: "016_client_edit" },
        { version: 17, file: "017_client_upload" },
        { version: 18, file: "018_client_delete" },
        { version: 19, file: "019_application_inventory" },
        { version: 20, file: "020_external_server_id" },
        { version: 21, file: "021_application_placement" },
        { version: 22, file: "022_application_create" },
        { version: 23, file: "023_application_reconcile" },
        { version: 24, file: "024_application_delete" },
        { version: 25, file: "025_compat_account_profile" },
        { version: 26, file: "026_compat_sftp_keys" },
        { version: 27, file: "027_compat_sftp_key_metadata" },
        { version: 28, file: "028_local_server_backups" },
        { version: 29, file: "029_local_backup_retention" },
        { version: 30, file: "030_backup_operation_age" },
        { version: 31, file: "031_s3_fixture_receipts" },
        { version: 32, file: "032_s3_upload_expiry" },
        { version: 33, file: "033_backup_adapter" },
        { version: 34, file: "034_backup_schedules" },
        { version: 35, file: "035_backup_schedule_history" },
        { version: 36, file: "036_app_database_recovery" },
        { version: 37, file: "037_app_database_restore_observation" },
        { version: 38, file: "038_fixture_runtime_profile" },
        { version: 39, file: "039_fixture_zip_operations" },
        { version: 40, file: "040_client_chmod" },
        { version: 41, file: "041_client_rename" },
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
        if (direction === "up" && version === 3) {
          const existing = await rows(
            connection,
            "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='wings_provisions'",
          );
          if (existing.length)
            throw new Error(
              "Provision table exists outside the migration ledger",
            );
        }
        if (direction === "down" && version === 33) {
          const s3Rows = await rows(
            connection,
            "SELECT id FROM local_server_backups WHERE adapter='s3' LIMIT 1",
          );
          if (s3Rows.length)
            throw new Error(
              "Remove S3 backup receipts before dropping the backup adapter column",
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
