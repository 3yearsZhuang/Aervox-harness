import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Socket } from "node:net";
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

const peerProbe = vi.hoisted(() => vi.fn());
vi.mock("@aervox/native-runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@aervox/native-runtime")>(), inspectUnixSocketPeer: peerProbe,
}));

describe("PostgreSQL private local storage proof", () => {
  let root: string, socket: string, data: string;
  let streams: Socket[];
  const postmasterPid = 12345;
  beforeEach(async () => {
    streams = [];
    peerProbe.mockReset().mockResolvedValue({ pid: postmasterPid, parentPid: 1, uid: process.getuid?.(), executable: "postgres" });
    root = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-storage-proof-"));
    socket = path.join(root, "socket"); data = path.join(root, "data");
    await fs.mkdir(socket, { mode: 0o700 }); await fs.mkdir(data, { mode: 0o700 });
    await fs.writeFile(path.join(data, "postmaster.pid"), `${postmasterPid}\n${data}\n1\n5432\n${socket}\n`, { mode: 0o600 });
  });
  afterEach(async () => { for (const stream of streams) stream.destroy(); await fs.rm(root, { recursive: true, force: true }); });
  const url = (directory: string) => `postgresql://user@localhost/app?host=${encodeURIComponent(directory)}`;
  function port(overrides: { address?: string | null; directory?: string; backendPid?: unknown; tablespace?: string; tableDefault?: string } = {}) {
    const stream = new Socket(); streams.push(stream);
    return { connection: { stream }, query: vi.fn(async (text: string) => ({ rows: text.includes("inet_server_addr")
      ? [{ address: overrides.address ?? null, directory: overrides.directory ?? data, backend_pid: overrides.backendPid ?? postmasterPid + 1 }]
      : [{ tablespace: overrides.tablespace ?? "", table_default: overrides.tableDefault ?? "" }] })) };
  }
  it("attests only private owner-controlled sockets with same-device data and default storage", async () => {
    const direct = port();
    expect(await proveLocalPostgresqlStorage(direct, url(socket))).toBe(true);
    expect(peerProbe).toHaveBeenCalledWith(direct.connection.stream);
    expect(await proveLocalPostgresqlStorage(port({ address: "127.0.0.1" }), url(socket))).toBe(false);
    expect(await proveLocalPostgresqlStorage(port({ tablespace: "/external/storage" }), url(socket))).toBe(false);
    expect(await proveLocalPostgresqlStorage(port({ tableDefault: "external" }), url(socket))).toBe(false);
  });
  it("accepts a backend child only when its OS parent matches the postmaster and SQL reports that exact peer", async () => {
    peerProbe.mockResolvedValue({ pid: postmasterPid + 1, parentPid: postmasterPid, uid: process.getuid?.(), executable: "postgres" });
    expect(await proveLocalPostgresqlStorage(port(), url(socket))).toBe(true);
    expect(await proveLocalPostgresqlStorage(port({ backendPid: postmasterPid + 2 }), url(socket))).toBe(false);
    peerProbe.mockResolvedValue({ pid: postmasterPid + 1, parentPid: postmasterPid + 2, uid: process.getuid?.(), executable: "postgres" });
    expect(await proveLocalPostgresqlStorage(port(), url(socket))).toBe(false);
  });
  it.each([
    ["unknown peer", undefined],
    ["other owner", { pid: postmasterPid, parentPid: 1, uid: (process.getuid?.() ?? 0) + 1, executable: "postgres" }],
    ["forwarding process", { pid: postmasterPid, parentPid: 1, uid: process.getuid?.(), executable: path.basename(process.execPath) }],
    ["different postmaster", { pid: postmasterPid + 1, parentPid: 1, uid: process.getuid?.(), executable: "postgres" }],
    ["invalid process", { pid: -1, parentPid: 1, uid: process.getuid?.(), executable: "postgres" }],
    ["missing OS parent", { pid: postmasterPid, uid: process.getuid?.(), executable: "postgres" }],
    ["invalid OS parent", { pid: postmasterPid, parentPid: -1, uid: process.getuid?.(), executable: "postgres" }],
  ])("refuses %s despite matching local directories and server settings", async (_name, peer) => {
    peerProbe.mockResolvedValue(peer);
    expect(await proveLocalPostgresqlStorage(port(), url(socket))).toBe(false);
  });
  it.each([0, -1, 1.5, "12346", Number.MAX_SAFE_INTEGER + 1])("rejects invalid backend PID %s", async backendPid => {
    expect(await proveLocalPostgresqlStorage(port({ backendPid }), url(socket))).toBe(false);
  });
  it("rejects unavailable native probes and objects without a real connection Socket", async () => {
    peerProbe.mockRejectedValue(new Error("native inspection unavailable"));
    expect(await proveLocalPostgresqlStorage(port(), url(socket))).toBe(false);
    peerProbe.mockClear();
    expect(await proveLocalPostgresqlStorage({ query: port().query }, url(socket))).toBe(false);
    expect(peerProbe).not.toHaveBeenCalled();
  });
  it.each(["pid", "directory", "port", "mode", "symlink", "oversized", "invalid-utf8"])("rejects a %s mismatch in the private postmaster receipt", async mutation => {
    const filename = path.join(data, "postmaster.pid");
    if (mutation === "mode") await fs.chmod(filename, 0o644);
    else if (mutation === "symlink") {
      const target = path.join(data, "receipt"); await fs.rename(filename, target); await fs.symlink(target, filename);
    } else if (mutation === "oversized") await fs.writeFile(filename, "x".repeat(16 * 1024 + 1));
    else if (mutation === "invalid-utf8") await fs.writeFile(filename, Buffer.from([0xff]));
    else await fs.writeFile(filename, `${mutation === "pid" ? postmasterPid + 1 : postmasterPid}\n${mutation === "directory" ? root : data}\n1\n${mutation === "port" ? "5433" : "5432"}\n${socket}\n`);
    expect(await proveLocalPostgresqlStorage(port(), url(socket))).toBe(false);
  });
  it("binds the explicit transport port and rejects ambiguous port declarations", async () => {
    await fs.writeFile(path.join(data, "postmaster.pid"), `${postmasterPid}\n${data}\n1\n65439\n${socket}\n`);
    expect(await proveLocalPostgresqlStorage(port(), `${url(socket)}&port=65439`)).toBe(true);
    for (const value of ["&port=65439&port=5432", "&port=0", "&port=65536", "&port=65439suffix"]) {
      expect(await proveLocalPostgresqlStorage(port(), `${url(socket)}${value}`)).toBe(false);
    }
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
    const denied = port(); denied.query.mockRejectedValue(new Error("permission denied"));
    expect(await proveLocalPostgresqlStorage(denied, url(socket))).toBe(false);
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
