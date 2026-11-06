/** Node-only PostgreSQL bootstrap. Startup verifies an existing, dedicated
 * target; creating empty canonical structure requires an explicit setup call. */
import { Pool, type PoolClient, type PoolConfig } from "pg";
import type { AervoxDatabase } from "../database.js";
import { assertPostgresqlSchemaName, initializePostgresqlSchema, inspectPostgresqlSchema, PostgresqlSchemaError } from "../schema/postgresql.js";
import { createPostgresQueryRuntime } from "./postgres-session.js";
import { createPostgresRepositoryConnection, type RepositoryConnection } from "./repository-connection.js";
import { proveLocalPostgresqlStorage } from "./postgresql-locality.js";
import type { PostgresqlStorageLocality } from "../storage-policy.js";

export interface PostgresqlDatabaseConfig {
  connectionString: string;
  schema: string;
  instanceId: string;
  /** Setup/migration only; ordinary startup never creates or repairs structure. */
  initializeEmpty?: boolean;
}
export interface OpenedPostgresqlDatabase {
  db: AervoxDatabase;
  client: RepositoryConnection;
  backend: "postgresql";
  closeAsync(): Promise<void>;
}
export class PostgresqlDatabaseOpenError extends Error {
  readonly code = "POSTGRESQL_DATABASE_OPEN_FAILED";
  constructor(readonly reasonCode: string) {
    super("Unable to open or verify the configured PostgreSQL target");
    this.name = "PostgresqlDatabaseOpenError";
  }
}

function localTransport(url: URL): boolean {
  const host = url.searchParams.get("host") ?? url.hostname;
  if (host.startsWith("/")) return true;
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}
/** Connection locality controls transport TLS only, never local_only data
 * eligibility: loopback can be forwarded and does not prove same-device storage. */
export function postgresqlPoolConfig(connectionString: string): PoolConfig {
  let url: URL;
  try { url = new URL(connectionString); }
  catch { throw new PostgresqlDatabaseOpenError("CONNECTION_CONFIGURATION_INVALID"); }
  if (!["postgresql:", "postgres:"].includes(url.protocol) || !url.hostname || connectionString.includes("\0")) {
    throw new PostgresqlDatabaseOpenError("CONNECTION_CONFIGURATION_INVALID");
  }
  const parameters = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (parameters.has(key)) throw new PostgresqlDatabaseOpenError("CONNECTION_PARAMETER_DUPLICATED");
    if (!["host", "port", "sslmode"].includes(key)) throw new PostgresqlDatabaseOpenError("CONNECTION_PARAMETER_UNSUPPORTED");
    parameters.add(key);
  }
  const effectiveHost = url.searchParams.get("host") ?? url.hostname;
  if (!effectiveHost || effectiveHost.includes(",") || effectiveHost.includes("\0")) throw new PostgresqlDatabaseOpenError("CONNECTION_HOST_INVALID");
  const remote = !localTransport(url);
  const mode = url.searchParams.get("sslmode");
  if (remote && mode && mode !== "verify-full") throw new PostgresqlDatabaseOpenError("VERIFIED_REMOTE_TLS_REQUIRED");
  if (!remote && mode && !["disable", "verify-full"].includes(mode)) throw new PostgresqlDatabaseOpenError("CONNECTION_TLS_MODE_UNSUPPORTED");
  const port = url.searchParams.get("port") ?? url.port;
  if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) throw new PostgresqlDatabaseOpenError("CONNECTION_PORT_INVALID");
  // node-postgres connection-string options override Pool config. Only admit
  // supported address/TLS keys, then remove the TLS flag so explicit verified
  // policy and bounded timeouts cannot be replaced by arbitrary URI options.
  url.searchParams.delete("sslmode");
  return {
    connectionString: url.toString(),
    ssl: remote || mode === "verify-full" ? { rejectUnauthorized: true } : false,
    max: 1,
    connectionTimeoutMillis: 5_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 30_000,
    client_encoding: "UTF8",
    sslnegotiation: "postgres",
    application_name: "aervox",
  };
}
function safeReason(error: unknown): string {
  if (error instanceof PostgresqlDatabaseOpenError) return error.reasonCode;
  if (error && typeof error === "object") {
    const code: unknown = Reflect.get(error, "code");
    if (typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code)) return code;
  }
  return "TARGET_UNAVAILABLE";
}

async function connectionLocality(connection: PoolClient, connectionString: string): Promise<PostgresqlStorageLocality> {
  const version = Number((await connection.query("SHOW server_version_num")).rows[0]?.server_version_num);
  const encoding = (await connection.query("SHOW server_encoding")).rows[0]?.server_encoding;
  if (!Number.isFinite(version) || version < 160000 || encoding !== "UTF8") {
    throw new PostgresqlDatabaseOpenError("POSTGRESQL_16_UTF8_REQUIRED");
  }
  return await proveLocalPostgresqlStorage(connection, connectionString) ? "verified-local" : "remote-or-unverified";
}

async function verifyConnectionTarget(connection: PoolClient, config: PostgresqlDatabaseConfig): Promise<void> {
  await connection.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
  try {
    await connection.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1),pg_catalog.hashtext($2))", [config.schema, config.instanceId]);
    const issues = await inspectPostgresqlSchema({ client: connection, schema: config.schema, instanceId: config.instanceId });
    if (issues.length) throw new PostgresqlSchemaError(issues);
    await connection.query("COMMIT");
  } catch (error) {
    // Both callers discard failed admission, including an unacknowledged
    // rollback. No business transaction has been started on this connection.
    await connection.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function createPostgresqlDatabase(config: PostgresqlDatabaseConfig): Promise<OpenedPostgresqlDatabase> {
  config = { ...config };
  assertPostgresqlSchemaName(config.schema);
  if (!config.instanceId.trim() || config.instanceId.length > 256 || config.instanceId.includes("\0")) {
    throw new PostgresqlDatabaseOpenError("APPLICATION_INSTANCE_INVALID");
  }
  const pool = new Pool(postgresqlPoolConfig(config.connectionString));
  // pg removes a failed idle connection itself; observing the event prevents
  // EventEmitter from turning a remote disconnect into an uncaught process
  // failure. Active operations retain their own checked error acknowledgement.
  pool.on("error", () => undefined);
  let storageLocality: PostgresqlStorageLocality = "remote-or-unverified";
  try {
    const connection = await pool.connect();
    let discard: Error | undefined;
    try {
      storageLocality = await connectionLocality(connection, config.connectionString);
      const target = { client: connection, schema: config.schema, instanceId: config.instanceId };
      if (config.initializeEmpty === true) {
        await initializePostgresqlSchema(target);
      } else {
        await verifyConnectionTarget(connection, config);
      }
    } catch (error) {
      discard ??= new Error("POSTGRESQL_DISCARD_FAILED_BOOTSTRAP_CONNECTION");
      throw error;
    } finally { connection.release(discard); }
    const runtime = createPostgresQueryRuntime(pool, {
      schema: config.schema, instanceId: config.instanceId, storageLocality,
      admitConnection: async (connection: PoolClient) => {
        try {
          const currentLocality = await connectionLocality(connection, config.connectionString);
          if (storageLocality === "verified-local" && currentLocality !== "verified-local") {
            throw new PostgresqlDatabaseOpenError("POSTGRESQL_STORAGE_LOCALITY_CHANGED");
          }
          await verifyConnectionTarget(connection, config);
        } catch (error) {
          if (error instanceof PostgresqlSchemaError || error instanceof PostgresqlDatabaseOpenError) throw error;
          throw new PostgresqlDatabaseOpenError(safeReason(error));
        }
      },
    });
    const client = createPostgresRepositoryConnection(runtime);
    return { db: runtime.db, client, backend: "postgresql", closeAsync: async () => { await client.close(); } };
  } catch (error) {
    await pool.end().catch(() => undefined);
    if (error instanceof PostgresqlSchemaError || error instanceof PostgresqlDatabaseOpenError) throw error;
    // Do not retain an untrusted driver's URL/password-bearing cause in an
    // error that the API, plugin UI or diagnostic logger may serialize.
    throw new PostgresqlDatabaseOpenError(safeReason(error));
  }
}
