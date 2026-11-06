import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { modelRuns, plugins, sessions, turns } from "@aervox/schema";
import { createPostgresqlDatabase, type OpenedPostgresqlDatabase } from "../src/driver/create-postgresql-database.js";
import { createPostgresQueryRuntime } from "../src/driver/postgres-session.js";
import { createPostgresRepositoryConnection, type RepositoryConnection } from "../src/driver/repository-connection.js";
import { databaseStoragePolicyFor } from "../src/storage-policy.js";
import { SqliteConversationRepository } from "../src/repositories/sqlite/conversation-repository.js";
import { collectDiaryMaterial } from "../src/repositories/sqlite/diary-material.js";

const databaseUrl = process.env.AERVOX_TEST_POSTGRES_URL;
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
describe.skipIf(!databaseUrl)("PostgreSQL opener and raw client real server contract", () => {
  let admin: Pool;
  let client: RepositoryConnection;
  const rawSchema = `aervox_raw_${randomUUID().replaceAll("-", "")}`;
  const namespaces: string[] = [];
  const owned: OpenedPostgresqlDatabase[] = [];
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${quote(rawSchema)}`);
    await admin.query(`CREATE TABLE ${quote(rawSchema)}.raw_values (id text PRIMARY KEY, count bigint NOT NULL, bytes bytea NOT NULL)`);
    client = createPostgresRepositoryConnection(createPostgresQueryRuntime(new Pool({ connectionString: databaseUrl }), { schema: rawSchema, instanceId: "raw-owner" }));
  });
  afterAll(async () => {
    await client?.close();
    for (const target of owned) await target.closeAsync();
    if (admin) {
      for (const namespace of [...namespaces, rawSchema]) await admin.query(`DROP SCHEMA IF EXISTS ${quote(namespace)} CASCADE`);
      await admin.end();
    }
  });
  const freshSchema = async (): Promise<string> => {
    const schema = `aervox_open_${randomUUID().replaceAll("-", "")}`;
    namespaces.push(schema); await admin.query(`CREATE SCHEMA ${quote(schema)}`); return schema;
  };

  it("uses native transactions for commit, rollback, bytes and exact affected counts", async () => {
    const tx = await client.transaction();
    const written = await tx.execute({ sql: "INSERT INTO raw_values(id,count,bytes) VALUES (?, ?, ?) RETURNING id,count,bytes", args: ["committed", 7, new Uint8Array([0, 128, 255])] });
    expect(written.rowsAffected).toBe(1); expect(written.columnTypes).toEqual(["TEXT", "INTEGER", "BLOB"]);
    expect(written.rows[0]?.count).toBe(7); expect([...new Uint8Array(written.rows[0]?.bytes as ArrayBuffer)]).toEqual([0, 128, 255]);
    await tx.commit();
    const rolledBack = await client.transaction();
    await rolledBack.execute({ sql: "INSERT INTO raw_values VALUES (?, ?, ?)", args: ["rolled-back", 1, new Uint8Array()] });
    await rolledBack.rollback();
    expect((await client.execute("SELECT id FROM raw_values ORDER BY id")).rows.map(row => row.id)).toEqual(["committed"]);
    const update = await client.execute({ sql: "UPDATE raw_values SET count = :count WHERE id=:id", args: { count: 9, id: "committed" } });
    expect(update.rowsAffected).toBe(1); expect(update.rows).toEqual([]);
    expect((await client.execute("SELECT count FROM raw_values WHERE id='committed'")).rows[0]?.count).toBe(9);
  });
  it("keeps a caught conflict recoverable and rolls back an entire failed batch", async () => {
    const tx = await client.transaction();
    await expect(tx.execute({ sql: "INSERT INTO raw_values VALUES (?, ?, ?)", args: ["committed", 2, new Uint8Array()] })).rejects.toMatchObject({ code: "23505" });
    await tx.execute("UPDATE raw_values SET count=10 WHERE id='committed'"); await tx.commit();
    await expect(client.batch([
      { sql: "INSERT INTO raw_values VALUES (?, ?, ?)", args: ["batch-first", 2, new Uint8Array()] },
      { sql: "INSERT INTO raw_values VALUES (?, ?, ?)", args: ["committed", 2, new Uint8Array()] },
    ])).rejects.toMatchObject({ code: "23505" });
    expect((await client.execute("SELECT id FROM raw_values WHERE id='batch-first'")).rows).toEqual([]);
  });
  it("enforces actual READ ONLY mode and admits following reads after a caught failure", async () => {
    const reader = await client.transaction("read");
    await expect(reader.execute("UPDATE raw_values SET count=100")).rejects.toMatchObject({ code: "25006" });
    expect((await reader.execute("SELECT count FROM raw_values WHERE id='committed'")).rows[0]?.count).toBe(10);
    await reader.commit();
    await expect(client.batch(["UPDATE raw_values SET count=100"], "read")).rejects.toMatchObject({ code: "25006" });
    expect((await client.execute("SELECT count FROM raw_values WHERE id='committed'")).rows[0]?.count).toBe(10);
  });
  it("ordinary startup rejects empty and unowned schemas without mutation", async () => {
    const schema = await freshSchema();
    const config = { connectionString: databaseUrl!, schema, instanceId: "owner" };
    await expect(createPostgresqlDatabase(config)).rejects.toThrow();
    expect((await admin.query("SELECT tablename FROM pg_tables WHERE schemaname=$1", [schema])).rows).toEqual([]);
    await admin.query(`CREATE TABLE ${quote(schema)}.unrelated(id bigint)`);
    await admin.query(`INSERT INTO ${quote(schema)}.unrelated VALUES (7)`);
    await expect(createPostgresqlDatabase({ ...config, initializeEmpty: true })).rejects.toThrow();
    expect((await admin.query(`SELECT id FROM ${quote(schema)}.unrelated`)).rows).toEqual([{ id: "7" }]);
    expect((await admin.query("SELECT tablename FROM pg_tables WHERE schemaname=$1", [schema])).rows).toEqual([{ tablename: "unrelated" }]);
  });
  it("explicit setup initializes canonical data, then normal reopen verifies ownership and drift", async () => {
    const schema = await freshSchema();
    const config = { connectionString: databaseUrl!, schema, instanceId: "owned-instance" };
    const opened = await createPostgresqlDatabase({ ...config, initializeEmpty: true }); owned.push(opened);
    expect(databaseStoragePolicyFor(opened.db)).toMatchObject({ locality: "verified-local", localOnlyAllowed: true });
    expect(databaseStoragePolicyFor(opened.client).localOnlyAllowed).toBe(true);
    const [plugin] = await opened.db.insert(plugins).values({ id: "native-plugin", publisher: "owner", version: "1", checksum: "sum" }).returning();
    expect(plugin?.lifecycleGeneration).toMatch(/^[a-f0-9]{32}$/);
    expect(plugin?.createdAt).toMatch(/^\d{4}-/);
    await opened.db.insert(sessions).values({ id: "typed-session", title: "原生主库", createdAt: "now", updatedAt: "now" });
    expect((await opened.db.select().from(sessions).where(eq(sessions.id, "typed-session")).get())?.title).toBe("原生主库");
    await opened.closeAsync();
    const reopened = await createPostgresqlDatabase(config); owned.push(reopened);
    expect((await reopened.client.execute("SELECT title FROM sessions WHERE id='typed-session'")).rows[0]?.title).toBe("原生主库");
    await reopened.closeAsync();
    await expect(createPostgresqlDatabase({ ...config, instanceId: "different-owner" })).rejects.toThrow("instance/version receipt differs");
    await admin.query(`ALTER TABLE ${quote(schema)}.sessions ALTER COLUMN title DROP NOT NULL`);
    await expect(createPostgresqlDatabase(config)).rejects.toThrow("sessions.title: column semantics differ");
    expect((await admin.query(`SELECT title FROM ${quote(schema)}.sessions`)).rows).toEqual([{ title: "原生主库" }]);
  }, 30_000);
  it("redacts driver failures before API or plugin diagnostics can serialize credentials", async () => {
    const schema = await freshSchema();
    let error: unknown;
    try { await createPostgresqlDatabase({ connectionString: "postgresql://test:PRIVATE_PASSWORD_SECRET@127.0.0.1:1/not_a_database", schema, instanceId: "owner" }); }
    catch (failure) { error = failure; }
    expect(error).toMatchObject({ code: "POSTGRESQL_DATABASE_OPEN_FAILED", reasonCode: "ECONNREFUSED" });
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain("PRIVATE_PASSWORD_SECRET");
    expect(String(error)).not.toContain("not_a_database");
  });
  it("preserves session read and write receipts across creation, concurrent reuse, rename and reopen", async () => {
    const schema = await freshSchema();
    const config = { connectionString: databaseUrl!, schema, instanceId: "session-owner" };
    const opened = await createPostgresqlDatabase({ ...config, initializeEmpty: true }); owned.push(opened);
    const repo = new SqliteConversationRepository(opened.db);
    const ctx = { workspaceId: "local", subjectUserId: "local" };
    const id = 'session-"🌙';
    const title = '原生会话 "quoted" \\ line\n🌙';
    const created = await repo.createSession(ctx, title, { id, executionPolicy: "bot-owner-v1" });
    expect(created).toMatchObject({ id, title, projectId: null, executionPolicy: "bot-owner-v1" });
    expect(created.createdAt).toMatch(/^\d{4}-/);
    expect(await repo.getSession(ctx, id)).toEqual(created);
    expect(await repo.listSessions(ctx)).toEqual([created]);
    expect(await repo.getOrCreateSession(ctx, id, "must not replace", null, "bot-owner-v1")).toEqual(created);
    await expect(repo.getOrCreateSession(ctx, id, title, null, "local-v1"))
      .rejects.toThrow("conversation_execution_policy_mismatch");
    const concurrent = await Promise.all([
      repo.getOrCreateSession(ctx, "shared-session", "first title"),
      repo.getOrCreateSession(ctx, "shared-session", "second title"),
    ]);
    expect(concurrent[1]).toEqual(concurrent[0]);
    expect(concurrent[0]).toMatchObject({ id: "shared-session", projectId: null, executionPolicy: "local-v1" });
    expect(await repo.listSessions(ctx)).toHaveLength(2);
    const renamedTitle = '重命名 "quoted" \\ line\n🌅';
    const renamed = await repo.renameSession(ctx, id, { title: renamedTitle, projectId: null });
    expect(renamed).toMatchObject({ id, title: renamedTitle, projectId: null, executionPolicy: "bot-owner-v1", createdAt: created.createdAt });
    expect(await repo.renameSession(ctx, "missing-session", "missing")).toBeNull();
    expect(await repo.getSession(ctx, id)).toEqual(renamed);
    expect((await repo.listSessions(ctx)).find(session => session.id === id)).toEqual(renamed);
    await opened.closeAsync();
    const reopened = await createPostgresqlDatabase(config); owned.push(reopened);
    const reread = new SqliteConversationRepository(reopened.db);
    expect(await reread.getSession(ctx, id)).toEqual(renamed);
    expect(await reread.getSession(ctx, "missing-session")).toBeNull();
    expect(await reread.deleteSession(ctx, id)).toBe(true);
    expect(await reread.getSession(ctx, id)).toBeNull();
    expect((await reread.listSessions(ctx)).map(session => session.id)).toEqual(["shared-session"]);
  }, 30_000);
  it("recovers fenced attempts and escaped identities with durable terminal receipts", async () => {
    const schema = await freshSchema();
    const opened = await createPostgresqlDatabase({ connectionString: databaseUrl!, schema, instanceId: "recovery-owner", initializeEmpty: true }); owned.push(opened);
    const repo = new SqliteConversationRepository(opened.db);
    const ctx = { workspaceId: "local", subjectUserId: "local" };
    const userContent = String.raw`Escaped user message: \"🌙`;
    const accept = async (id: string, policy: "local-v1" | "bot-owner-v1" = "local-v1") => {
      await repo.createSession(ctx, id, { id, executionPolicy: policy });
      await repo.acceptTurn(ctx, { turnId: `turn-${id}`, sessionId: id, idempotencyKey: id, attemptId: `attempt-${id}`, message: { id: `message-${id}`, content: userContent } });
    };
    const fenced = 'fenced-"🌙'; await accept(fenced);
    await repo.claimTurnAttempt(ctx, { turnId: `turn-${fenced}`, attemptId: `attempt-${fenced}`, expectedFencingToken: 0, leaseId: "expired", ttlMs: -1 });
    expect(await repo.recoverExpiredAttempts(opened.client)).toBe(1);
    expect((await repo.getTurn(ctx, `turn-${fenced}`))?.status).toBe("Interrupted");
    expect((await repo.getStreamEvents(ctx, `turn-${fenced}`)).map(event => event.eventType)).toEqual(["done"]);
    expect(await repo.recoverExpiredAttempts(opened.client)).toBe(0);
    const api = 'api-"🌙'; await accept(api, "bot-owner-v1");
    const claim = await repo.claimTurnAttempt(ctx, { turnId: `turn-${api}`, attemptId: `attempt-${api}`, expectedFencingToken: 0, leaseId: "api-expired", ttlMs: -1 });
    expect(await repo.retireExpiredApiOwnedAttempt(`turn-${api}`, `attempt-${api}`, claim.fencingToken)).toBe(true);
    expect(await repo.retireExpiredApiOwnedAttempt(`turn-${api}`, `attempt-${api}`, claim.fencingToken)).toBe(false);
    const sync = 'sync-"🌙'; await accept(sync, "bot-owner-v1");
    await repo.finalizeTurnAttempt(ctx, { turnId: `turn-${sync}`, attemptId: `attempt-${sync}`, status: "Interrupted" });
    expect(await repo.synchronizeTurnWithLatestAttempt(`turn-${sync}`)).toMatchObject({ status: "Interrupted" });
    await opened.db.insert(turns).values({ id: 'orphan-"🌙', sessionId: sync, idempotencyKey: "orphan", status: "Created", createdAt: "2000-01-01T00:00:00.000Z", updatedAt: "2000-01-01T00:00:00.000Z", dispatchTarget: "api", executionPolicy: "bot-owner-v1" });
    expect(await repo.recoverOrphanTurns({ dispatchTarget: "api", orphanTimeoutMs: 1 })).toBe(1);
    expect((await repo.getStreamEvents(ctx, 'orphan-"🌙')).map(event => event.eventType)).toEqual(["done"]);
    await accept("completed-material");
    await repo.updateTurnStatus(ctx, "turn-completed-material", "Completed");
    const material = await collectDiaryMaterial(opened.db, ctx, { startIso: "2000-01-01T00:00:00.000Z", endIso: "2999-01-01T00:00:00.000Z" });
    expect(material.messages.map(message => message.content)).toContain(userContent);
    await opened.db.insert(modelRuns).values([
      { id: "step-one", attemptId: `attempt-${sync}`, purpose: "test", provider: "test", modelId: "test", stepId: 1 },
      { id: "step-null", attemptId: `attempt-${sync}`, purpose: "test", provider: "test", modelId: "test", stepId: null },
    ]);
    const diagnostics = await repo.getTurnDiagnostics(ctx, `turn-${sync}`);
    expect(diagnostics?.modelRuns.map(run => run.id)).toEqual(["step-null", "step-one"]);
  }, 30_000);
  it("rolls back accepted writes on connection close before releasing its pool", async () => {
    const tx = await client.transaction();
    await tx.execute("UPDATE raw_values SET count=42 WHERE id='committed'");
    await client.close();
    expect(tx.closed).toBe(true);
    expect((await admin.query(`SELECT count FROM ${quote(rawSchema)}.raw_values WHERE id='committed'`)).rows).toEqual([{ count: "10" }]);
  });
});
