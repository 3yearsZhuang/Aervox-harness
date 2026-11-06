/** Conservative same-device storage proof shared by migration and runtime.
 * User management, TLS, TCP loopback and a separate local vault are insufficient. */
import fs from "node:fs/promises";
import type { PostgresqlQueryPort } from "../schema/postgresql.js";

export async function proveLocalPostgresqlStorage(client: PostgresqlQueryPort, connectionString: string): Promise<boolean> {
  try {
    const url = new URL(connectionString);
    const hosts = url.searchParams.getAll("host");
    const socket = hosts[0];
    if (hosts.length !== 1 || !socket?.startsWith("/") || socket.includes("\0") || url.searchParams.has("hostaddr") || process.getuid === undefined) return false;
    const owner = process.getuid();
    const directory = await fs.lstat(socket);
    if (!directory.isDirectory() || directory.uid !== owner || (directory.mode & 0o077) !== 0) return false;
    const locality = await client.query("SELECT inet_server_addr() AS address, current_setting('data_directory') AS directory");
    const row = locality.rows[0];
    if (locality.rows.length !== 1 || row?.address !== null || typeof row.directory !== "string" || !row.directory.startsWith("/")) return false;
    const data = await fs.lstat(row.directory);
    if (!data.isDirectory() || data.uid !== owner || (data.mode & 0o077) !== 0) return false;
    const storage = await client.query("SELECT pg_tablespace_location(dattablespace) AS tablespace, current_setting('default_tablespace') AS table_default FROM pg_database WHERE datname=current_database()");
    return storage.rows.length === 1 && storage.rows[0]?.tablespace === "" && storage.rows[0]?.table_default === "";
  } catch { return false; }
}
