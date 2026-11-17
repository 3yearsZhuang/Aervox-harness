/** Browser-safe storage policy. Host-verified locality belongs to the exact
 * database/transaction handle; a loopback hostname or a separate vault cannot
 * establish that derived conversation and notification writes stay local. */
import { backendFor, type DatabaseBackend } from "./database-backend.js";

export type PostgresqlStorageLocality = "verified-local" | "remote-or-unverified";
export interface DatabaseStoragePolicy {
  readonly backend: DatabaseBackend;
  readonly locality: "sqlite-local" | PostgresqlStorageLocality;
  readonly localOnlyAllowed: boolean;
}
const sqlitePolicy: DatabaseStoragePolicy = Object.freeze({ backend: "sqlite", locality: "sqlite-local", localOnlyAllowed: true });
const unverifiedPolicy: DatabaseStoragePolicy = Object.freeze({ backend: "postgresql", locality: "remote-or-unverified", localOnlyAllowed: false });
const verifiedPolicy: DatabaseStoragePolicy = Object.freeze({ backend: "postgresql", locality: "verified-local", localOnlyAllowed: true });
const storagePolicies = new WeakMap<object, DatabaseStoragePolicy>();

export function databaseStoragePolicyFor(database: object): DatabaseStoragePolicy {
  if (backendFor(database) === "sqlite") return sqlitePolicy;
  return storagePolicies.get(database) ?? unverifiedPolicy;
}
/** Only the host's native opener may attest a PostgreSQL handle. The caller
 * must have inspected the exact connection before admitting protected work. */
export function registerPostgresqlStorageLocality(database: object, locality: PostgresqlStorageLocality): void {
  if (backendFor(database) !== "postgresql") throw new Error("POSTGRESQL_STORAGE_HANDLE_REQUIRED");
  const policy = locality === "verified-local" ? verifiedPolicy : unverifiedPolicy;
  const prior = storagePolicies.get(database);
  if (prior && prior !== policy) throw new Error("DATABASE_STORAGE_LOCALITY_CONFLICT");
  storagePolicies.set(database, policy);
}
export class LocalOnlyStorageRequiredError extends Error {
  readonly code = "LOCAL_ONLY_STORAGE_REQUIRED";
  readonly statusCode = 503;
  constructor() {
    super("Protected profile and proactive processing require verified local main-database storage");
    this.name = "LocalOnlyStorageRequiredError";
  }
}
export function assertLocalOnlyStorage(database: object): void {
  if (!databaseStoragePolicyFor(database).localOnlyAllowed) throw new LocalOnlyStorageRequiredError();
}

/** Protected facts remain in the independent SQLite Vault declared by ADR-034.
 * Verified local PostgreSQL permits their derived main-database outputs, but
 * does not imply these SQLite-specific Vault repositories are PostgreSQL ports. */
export function assertProactiveVaultStorage(database: object): void {
  assertLocalOnlyStorage(database);
  if (backendFor(database) !== "sqlite") {
    const error = new Error("Protected profile facts require the independent local SQLite Vault");
    Object.assign(error, { code: "PROACTIVE_SQLITE_VAULT_REQUIRED", statusCode: 503 });
    throw error;
  }
}
