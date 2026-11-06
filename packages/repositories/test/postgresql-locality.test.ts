import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proveLocalPostgresqlStorage } from "../src/driver/postgresql-locality.js";
import { databaseStoragePolicyFor, assertLocalOnlyStorage, registerPostgresqlStorageLocality } from "../src/storage-policy.js";
import { registerDatabaseBackend } from "../src/database-backend.js";
import { SqliteProactiveProfileRepository } from "../src/repositories/sqlite/proactive-profile-repository.js";
import { SqliteProactiveIntelligenceRepository } from "../src/repositories/sqlite/proactive-intelligence-repository.js";
import { SqliteProactiveSituationRepository } from "../src/repositories/sqlite/proactive-situation-repository.js";
import { SqlitePerceptionEventRepository } from "../src/repositories/sqlite/proactive-perception-repository.js";
import { SqliteProactiveBudgetRepository } from "../src/repositories/sqlite/proactive-budget-repository.js";
import { createPostgresQueryRuntime, type PostgresConnection } from "../src/driver/postgres-session.js";
import { createPostgresRepositoryConnection } from "../src/driver/repository-connection.js";

describe("PostgreSQL private local storage proof", () => {
  let root: string, socket: string, data: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-storage-proof-"));
    socket = path.join(root, "socket"); data = path.join(root, "data");
    await fs.mkdir(socket, { mode: 0o700 }); await fs.mkdir(data, { mode: 0o700 });
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const url = (directory: string) => `postgresql://user@localhost/app?host=${encodeURIComponent(directory)}`;
  function port(overrides: { address?: string | null; directory?: string; tablespace?: string; tableDefault?: string } = {}) {
    return { query: vi.fn(async (text: string) => ({ rows: text.includes("inet_server_addr")
      ? [{ address: overrides.address ?? null, directory: overrides.directory ?? data }]
      : [{ tablespace: overrides.tablespace ?? "", table_default: overrides.tableDefault ?? "" }] })) };
  }
  it("attests only private owner-controlled sockets with same-device data and default storage", async () => {
    expect(await proveLocalPostgresqlStorage(port(), url(socket))).toBe(true);
    expect(await proveLocalPostgresqlStorage(port({ address: "127.0.0.1" }), url(socket))).toBe(false);
    expect(await proveLocalPostgresqlStorage(port({ tablespace: "/external/storage" }), url(socket))).toBe(false);
    expect(await proveLocalPostgresqlStorage(port({ tableDefault: "external" }), url(socket))).toBe(false);
  });
  it("rejects TCP loopback, remote addresses and ambiguous host options before querying", async () => {
    for (const value of ["postgresql://user@localhost/app", "postgresql://user@127.0.0.1/app", "postgresql://user@remote.example/app", `${url(socket)}&host=remote.example`, `${url(socket)}&hostaddr=127.0.0.1`]) {
      const target = port(); expect(await proveLocalPostgresqlStorage(target, value)).toBe(false); expect(target.query).not.toHaveBeenCalled();
    }
  });
  it("fails closed on shared directories, symlinks, missing storage and denied server inspection", async () => {
    await fs.chmod(socket, 0o755);
    expect(await proveLocalPostgresqlStorage(port(), url(socket))).toBe(false);
    await fs.chmod(socket, 0o700); await fs.chmod(data, 0o750);
    expect(await proveLocalPostgresqlStorage(port(), url(socket))).toBe(false);
    await fs.chmod(data, 0o700);
    const linked = path.join(root, "linked"); await fs.symlink(socket, linked);
    expect(await proveLocalPostgresqlStorage(port(), url(linked))).toBe(false);
    expect(await proveLocalPostgresqlStorage(port({ directory: path.join(root, "missing") }), url(socket))).toBe(false);
    expect(await proveLocalPostgresqlStorage(port({ directory: "relative/data" }), url(socket))).toBe(false);
    expect(await proveLocalPostgresqlStorage({ query: vi.fn().mockRejectedValue(new Error("permission denied")) }, url(socket))).toBe(false);
  });
});

describe("local_only storage capability", () => {
  it("keeps SQLite compatible and rejects unverified PostgreSQL despite loopback or a local vault", () => {
    expect(databaseStoragePolicyFor({})).toEqual({ backend: "sqlite", locality: "sqlite-local", localOnlyAllowed: true });
    const pg = {}; registerDatabaseBackend(pg, "postgresql");
    expect(databaseStoragePolicyFor(pg)).toEqual({ backend: "postgresql", locality: "remote-or-unverified", localOnlyAllowed: false });
    expect(() => assertLocalOnlyStorage(pg)).toThrow(expect.objectContaining({ code: "LOCAL_ONLY_STORAGE_REQUIRED" }));
    registerPostgresqlStorageLocality(pg, "verified-local");
    expect(() => assertLocalOnlyStorage(pg)).not.toThrow();
    expect(() => registerPostgresqlStorageLocality(pg, "remote-or-unverified")).toThrow("DATABASE_STORAGE_LOCALITY_CONFLICT");
  });
  it("blocks all protected repository construction before admitting any PostgreSQL command", async () => {
    const query = vi.fn(async () => ({ rows: [], fields: [], rowCount: 0, command: "SELECT" }));
    const connection: PostgresConnection = { query, release() {} };
    const runtime = createPostgresQueryRuntime({ async connect() { return connection; }, async end() {} }, { schema: "private_data", instanceId: "owner" });
    for (const Repository of [SqliteProactiveProfileRepository, SqliteProactiveIntelligenceRepository, SqliteProactiveSituationRepository, SqlitePerceptionEventRepository, SqliteProactiveBudgetRepository]) {
      expect(() => new Repository(runtime.db)).toThrow(expect.objectContaining({ code: "LOCAL_ONLY_STORAGE_REQUIRED" }));
    }
    expect(query).not.toHaveBeenCalled();
    await runtime.closeAsync();
  });
  it("propagates exact attestation to typed and raw transaction handles", async () => {
    const query = vi.fn(async () => ({ rows: [], fields: [], rowCount: 0, command: "SELECT" }));
    const connection: PostgresConnection = { query, release() {} };
    const runtime = createPostgresQueryRuntime({ async connect() { return connection; }, async end() {} }, { schema: "private_data", instanceId: "owner", storageLocality: "verified-local" });
    const client = createPostgresRepositoryConnection(runtime);
    expect(databaseStoragePolicyFor(client).localOnlyAllowed).toBe(true);
    for (const Repository of [SqliteProactiveProfileRepository, SqliteProactiveIntelligenceRepository, SqliteProactiveSituationRepository, SqlitePerceptionEventRepository]) {
      expect(() => new Repository(runtime.db)).toThrow(expect.objectContaining({ code: "PROACTIVE_SQLITE_VAULT_REQUIRED" }));
    }
    expect(() => new SqliteProactiveBudgetRepository(runtime.db)).not.toThrow();
    await runtime.db.transaction(async tx => { expect(databaseStoragePolicyFor(tx).localOnlyAllowed).toBe(true); });
    const tx = await client.transaction("read");
    expect(databaseStoragePolicyFor(tx).localOnlyAllowed).toBe(true); await tx.rollback();
    await client.close();
  });
});
