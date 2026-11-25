import {
  createPool,
  type Pool,
  type PoolConnection,
  type RowDataPacket,
} from "mysql2/promise";
export type Executor = Pick<Pool, "execute"> | Pick<PoolConnection, "execute">;
export async function rows<T>(
  db: Executor,
  sql: string,
  args: (string | number | Buffer | null | boolean)[] = [],
): Promise<T[]> {
  const [result] = await db.execute<RowDataPacket[]>(sql, args);
  return result as T[];
}
export async function transaction<T>(
  pool: Pool,
  run: (db: PoolConnection) => Promise<T>,
): Promise<T> {
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const result = await run(c);
    await c.commit();
    return result;
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
}
export function stagingPool(address = process.env.RELAY_STAGING_DATABASE_URL) {
  if (!address || process.env.RELAY_ENV !== "staging")
    throw new Error("A dedicated staging database is required");
  const url = new URL(address);
  if (
    url.protocol !== "mysql:" ||
    !/^\/relay_(staging|test)(_[a-z0-9]+)?$/.test(url.pathname) ||
    !["127.0.0.1", "localhost", "mysql"].includes(url.hostname) ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Only dedicated local or Compose staging databases are permitted",
    );
  return createPool({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    timezone: "Z",
    dateStrings: true,
    connectionLimit: 8,
    multipleStatements: false,
  });
}
