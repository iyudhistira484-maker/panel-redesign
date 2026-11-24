import { createConnection, type RowDataPacket } from "mysql2/promise";
import { legacyColumns, legacyPreflight } from "./legacy-preflight";

/** Connect only to an offline copy, using a dedicated SELECT-only account. */
export async function readLegacySnapshot(uri: string) {
  const url = new URL(uri);
  if (
    process.env.RELAY_ENV !== "staging" ||
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    !url.username ||
    !url.password ||
    url.search ||
    url.hash ||
    !/^\/panel_snapshot_[a-z0-9_]+$/.test(url.pathname)
  )
    throw new Error("A local staging Panel snapshot is required");

  const db = await createConnection({
    uri,
    connectTimeout: 5000,
    dateStrings: true,
  });
  try {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await db.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    const manifest: Record<string, RowDataPacket[]> = {};
    for (const [table, columns] of Object.entries(legacyColumns)) {
      const identifiers = columns.map((column) => `\`${column}\``).join(", ");
      const [rows] = await db.query<RowDataPacket[]>({
        sql: `SELECT ${identifiers} FROM \`${table}\` ORDER BY id LIMIT 10001`,
        timeout: 5000,
      });
      if (rows.length > 10000)
        throw new Error("Panel snapshot row limit exceeded");
      if (table === "subusers")
        for (const row of rows) {
          if (typeof row.permissions === "string")
            row.permissions = JSON.parse(row.permissions);
        }
      manifest[table] = rows;
    }

    return { manifest, report: legacyPreflight(manifest) };
  } catch {
    throw new Error("Panel snapshot could not be read or failed validation");
  } finally {
    db.destroy();
  }
}
