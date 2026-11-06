/** Conservative same-device storage proof shared by migration and runtime.
 * User management, TLS, TCP loopback and a separate local vault are insufficient. */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { Socket } from "node:net";
import path from "node:path";
import { inspectUnixSocketPeer } from "@aervox/native-runtime";
import type { PostgresqlQueryPort } from "../schema/postgresql.js";

const MAX_POSTMASTER_PID_BYTES = 16 * 1024;

async function matchesPostmaster(directory: string, owner: number, peer: { pid: number; parentPid: number }, backendPid: number, port: string): Promise<boolean> {
  const handle = await fs.open(path.join(directory, "postmaster.pid"), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== owner || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
      || stat.size < 1 || stat.size > MAX_POSTMASTER_PID_BYTES) return false;
    const buffer = Buffer.alloc(MAX_POSTMASTER_PID_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (bytesRead !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return false;
    const lines = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)).split("\n");
    if (lines.length < 5 || !/^[1-9][0-9]*$/.test(lines[0] ?? "") || lines[1] !== directory || lines[3] !== port) return false;
    const postmasterPid = Number(lines[0]);
    if (!Number.isSafeInteger(postmasterPid)) return false;
    // Linux can retain the postmaster's connection credentials. macOS reports
    // the backend child, whose OS parent must be that same private postmaster.
    return peer.pid === postmasterPid || (peer.parentPid === postmasterPid && peer.pid === backendPid);
  } finally { await handle.close(); }
}

export async function proveLocalPostgresqlStorage(client: PostgresqlQueryPort, connectionString: string): Promise<boolean> {
  try {
    const url = new URL(connectionString);
    const hosts = url.searchParams.getAll("host");
    const socket = hosts[0];
    if (hosts.length !== 1 || !socket?.startsWith("/") || socket.includes("\0") || url.searchParams.has("hostaddr") || process.getuid === undefined) return false;
    const port = (url.searchParams.get("port") ?? url.port) || "5432";
    if (!/^[1-9][0-9]*$/.test(port) || Number(port) > 65535 || url.searchParams.getAll("port").length > 1) return false;
    const owner = process.getuid();
    const directory = await fs.lstat(socket);
    if (!directory.isDirectory() || directory.uid !== owner || (directory.mode & 0o077) !== 0) return false;
    // Inspect the current connection's descriptor. A second connection or a
    // matching local path cannot establish the peer of a forwarded socket.
    const connection: unknown = Reflect.get(client, "connection");
    if (!connection || typeof connection !== "object") return false;
    const stream: unknown = Reflect.get(connection, "stream");
    if (!(stream instanceof Socket)) return false;
    const peer = await inspectUnixSocketPeer(stream);
    if (!peer || peer.uid !== owner || !Number.isSafeInteger(peer.pid) || peer.pid < 1
      || !Number.isSafeInteger(peer.parentPid) || peer.parentPid < 0
      || !["postgres", "postmaster"].includes(path.basename(peer.executable))) return false;
    const locality = await client.query("SELECT inet_server_addr() AS address, current_setting('data_directory') AS directory, pg_backend_pid() AS backend_pid");
    const row = locality.rows[0];
    if (locality.rows.length !== 1 || row?.address !== null || typeof row.directory !== "string" || !row.directory.startsWith("/")
      || typeof row.backend_pid !== "number" || !Number.isSafeInteger(row.backend_pid) || row.backend_pid < 1) return false;
    const data = await fs.lstat(row.directory);
    if (!data.isDirectory() || data.uid !== owner || (data.mode & 0o077) !== 0) return false;
    if (!await matchesPostmaster(row.directory, owner, peer, row.backend_pid, port)) return false;
    const storage = await client.query("SELECT pg_tablespace_location(dattablespace) AS tablespace, current_setting('default_tablespace') AS table_default FROM pg_database WHERE datname=current_database()");
    return storage.rows.length === 1 && storage.rows[0]?.tablespace === "" && storage.rows[0]?.table_default === "";
  } catch { return false; }
}
