import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createClient } from "@libsql/client";
import { createDatabase, initDatabaseSchema, migrateDatabaseViaStaging, inspectSchemaParity, SqliteConversationRepository, searchMessagesFts } from "../src/index.js";

async function temporary() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-schema-staging-"));
  return { directory, sourcePath: path.join(directory, "source.db"), stagingPath: path.join(directory, "staging.db"), rollbackPath: path.join(directory, "rollback.db"), backupDirectory: path.join(directory, "backup") };
}
describe("explicit staging replacement", () => {
  it("rebuilds message search from eligible history without reviving partial or deleted-input answers", async () => {
    const fixture = await temporary();
    const ctx = { workspaceId: "local", subjectUserId: "local" };
    try {
      const source = await createDatabase({ url: `file:${fixture.sourcePath}` });
      await initDatabaseSchema(source.client);
      const repo = new SqliteConversationRepository(source.db);
      await repo.getOrCreateSession(ctx, "session");
      for (const kind of ["valid", "partial", "deleted"] as const) {
        await repo.acceptTurn(ctx, { turnId: kind, sessionId: "session", idempotencyKey: kind, attemptId: kind,
          message: { id: `user-${kind}`, content: `question ${kind}` }, consumeInbox: false });
        const id = `assistant-${kind}`, content = `${kind}canary`;
        await repo.appendStreamEvent(ctx, { id: `message-${kind}`, turnId: kind, attemptId: kind, expectedFencingToken: 0, sequence: 1,
          eventType: "message", data: { role: "assistant", messageId: id }, safetyDecision: "approved" });
        await repo.recordSafeSegmentAtomically(ctx, { turnId: kind, attemptId: kind, expectedFencingToken: 0, sequence: 2,
          text: content, eventData: { messageId: id, text: content }, safetyDecision: "approved" });
        const status = kind === "partial" ? "Interrupted" : "Completed";
        await repo.finalizeAttemptWithEventAtomically(ctx, { turnId: kind, attemptId: kind, expectedFencingToken: 0, sequence: 3,
          status, eventType: "done", eventData: { status }, safetyDecision: "approved" });
        if (kind === "deleted") await repo.deleteMessage(ctx, `user-${kind}`);
      }
      await source.client.execute("PRAGMA wal_checkpoint(TRUNCATE)"); source.client.close();
      await migrateDatabaseViaStaging({ ...fixture, quiesce: async () => ({ release: async () => {} }) });
      const restored = await createDatabase({ url: `file:${fixture.sourcePath}` });
      try {
        expect((await restored.client.execute("SELECT id FROM messages_fts ORDER BY id")).rows.map(row => row.id)).toEqual(["assistant-valid", "user-valid"]);
        expect(await searchMessagesFts(restored.client, ctx, "validcanary")).toMatchObject([{ id: "assistant-valid" }]);
        expect(await searchMessagesFts(restored.client, ctx, "partialcanary")).toEqual([]);
        expect(await searchMessagesFts(restored.client, ctx, "deletedcanary")).toEqual([]);
        await new SqliteConversationRepository(restored.db).softDeleteMessage(ctx, "user-valid");
        expect(await searchMessagesFts(restored.client, ctx, "validcanary")).toEqual([]);
      } finally { restored.client.close(); }
    } finally { await fs.rm(fixture.directory, { recursive: true, force: true }); }
  });
  it("blocks dirty NULL identities with a row list, keeps original bytes and verified rollback evidence", async () => {
    const fixture = await temporary(), release = vi.fn(async () => {});
    try {
      const source = createClient({ url: `file:${fixture.sourcePath}` });
      await source.execute("CREATE TABLE learning_goals(id TEXT PRIMARY KEY, topic TEXT)");
      await source.execute("INSERT INTO learning_goals VALUES(NULL,'keep this row')"); source.close();
      const before = await fs.readFile(fixture.sourcePath);
      await expect(migrateDatabaseViaStaging({ ...fixture, quiesce: async () => ({ release }) })).rejects.toThrow("learning_goals[0].id: NULL or missing primary key");
      expect(await fs.readFile(fixture.sourcePath)).toEqual(before);
      expect(await fs.readFile(path.join(fixture.backupDirectory, "source.db"))).toEqual(before);
      await expect(fs.stat(fixture.rollbackPath)).rejects.toMatchObject({code:"ENOENT"});
      expect(release).toHaveBeenCalledOnce();
    } finally { await fs.rm(fixture.directory, {recursive:true,force:true}); }
  });
  it("rebuilds the selected logical snapshot, validates, swaps once and retains original inode bytes", async () => {
    const fixture = await temporary(), release = vi.fn(async () => {});
    try {
      const source = await createDatabase({ url: `file:${fixture.sourcePath}` });
      await initDatabaseSchema(source.client);
      await source.client.execute("INSERT INTO sessions(id,title,created_at,updated_at) VALUES('s','preserved','t','t')");
      await source.client.execute("PRAGMA wal_checkpoint(TRUNCATE)"); source.client.close();
      const before = await fs.readFile(fixture.sourcePath);
      const result = await migrateDatabaseViaStaging({ ...fixture, quiesce: async () => ({ release }) });
      expect(result.copiedRowsByTable.sessions).toBe(1);
      expect(await fs.readFile(fixture.rollbackPath)).toEqual(before);
      const restored = await createDatabase({ url: `file:${fixture.sourcePath}` });
      try {
        expect((await restored.client.execute("SELECT title FROM sessions")).rows[0]?.title).toBe("preserved");
        expect(await inspectSchemaParity(restored.client, "main")).toEqual([]);
      } finally { restored.client.close(); }
      const sourceBytes = await fs.readFile(fixture.sourcePath);
      await expect(migrateDatabaseViaStaging({ ...fixture, quiesce: async () => ({ release }) })).rejects.toThrow("already exists");
      expect(await fs.readFile(fixture.sourcePath)).toEqual(sourceBytes);
      expect(release).toHaveBeenCalledOnce();
    } finally { await fs.rm(fixture.directory, {recursive:true,force:true}); }
  });
  it("fails closed when stop-write/quiescence cannot be established", async () => {
    const fixture = await temporary();
    try {
      await fs.writeFile(fixture.sourcePath,"source unchanged");
      await expect(migrateDatabaseViaStaging({ ...fixture, quiesce: async () => { throw new Error("writer busy"); } })).rejects.toThrow("writer busy");
      expect(await fs.readFile(fixture.sourcePath,"utf8")).toBe("source unchanged");
      await expect(fs.stat(fixture.backupDirectory)).rejects.toMatchObject({code:"ENOENT"});
    } finally { await fs.rm(fixture.directory,{recursive:true,force:true}); }
  });
  it("does not open or replace a source that still has uncheckpointed writes", async () => {
    const fixture = await temporary(), release = vi.fn(async () => {});
    try {
      await fs.writeFile(fixture.sourcePath, "source bytes");
      await fs.writeFile(`${fixture.sourcePath}-wal`, "uncheckpointed bytes");
      await expect(migrateDatabaseViaStaging({ ...fixture, quiesce: async () => ({ release }) })).rejects.toThrow("uncheckpointed -wal");
      expect(await fs.readFile(fixture.sourcePath, "utf8")).toBe("source bytes");
      expect(await fs.readFile(`${fixture.sourcePath}-wal`, "utf8")).toBe("uncheckpointed bytes");
      await expect(fs.stat(fixture.backupDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      expect(release).toHaveBeenCalledOnce();
    } finally { await fs.rm(fixture.directory, { recursive: true, force: true }); }
  });
  it("never overwrites an existing rollback package", async () => {
    const fixture = await temporary(), quiesce = vi.fn();
    try {
      await fs.writeFile(fixture.sourcePath, "source bytes");
      await fs.writeFile(fixture.rollbackPath, "previous recovery bytes");
      await expect(migrateDatabaseViaStaging({ ...fixture, quiesce })).rejects.toThrow("migration output already exists");
      expect(await fs.readFile(fixture.sourcePath, "utf8")).toBe("source bytes");
      expect(await fs.readFile(fixture.rollbackPath, "utf8")).toBe("previous recovery bytes");
      expect(quiesce).not.toHaveBeenCalled();
    } finally { await fs.rm(fixture.directory, { recursive: true, force: true }); }
  });
  it("never reuses a backup directory or overwrites a prior backup manifest", async () => {
    const fixture = await temporary(), quiesce = vi.fn();
    try {
      await fs.writeFile(fixture.sourcePath, "source bytes");
      await fs.mkdir(fixture.backupDirectory);
      const manifestPath = path.join(fixture.backupDirectory, "manifest.json");
      await fs.writeFile(manifestPath, "previous recovery manifest");
      await expect(migrateDatabaseViaStaging({ ...fixture, quiesce })).rejects.toThrow("migration output already exists");
      expect(await fs.readFile(manifestPath, "utf8")).toBe("previous recovery manifest");
      expect(await fs.readFile(fixture.sourcePath, "utf8")).toBe("source bytes");
      await expect(fs.stat(path.join(fixture.backupDirectory, "source.db"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(quiesce).not.toHaveBeenCalled();
    } finally { await fs.rm(fixture.directory, { recursive: true, force: true }); }
  });
  it.each(["staging", "rollback", "inspection"].flatMap(owner => ["", "-wal", "-shm", "-journal"].map(suffix => [owner, suffix])))("preserves occupied %s output%s without opening SQLite", async (owner, suffix) => {
    const fixture = await temporary(), quiesce = vi.fn();
    try {
      await fs.writeFile(fixture.sourcePath, "source bytes");
      const databasePath = owner === "staging" ? fixture.stagingPath : owner === "rollback" ? fixture.rollbackPath : `${fixture.stagingPath}.source-inspection`;
      const occupiedPath = `${databasePath}${suffix}`;
      await fs.writeFile(occupiedPath, "previous failure evidence");
      await expect(migrateDatabaseViaStaging({ ...fixture, quiesce })).rejects.toThrow("migration output already exists");
      expect(await fs.readFile(occupiedPath, "utf8")).toBe("previous failure evidence");
      expect(await fs.readFile(fixture.sourcePath, "utf8")).toBe("source bytes");
      await expect(fs.stat(fixture.backupDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      expect(quiesce).not.toHaveBeenCalled();
    } finally { await fs.rm(fixture.directory, { recursive: true, force: true }); }
  });
  it("blocks unknown virtual data instead of silently omitting it during logical export", async () => {
    const fixture = await temporary();
    try {
      const source = createClient({ url: `file:${fixture.sourcePath}` });
      await source.execute("CREATE VIRTUAL TABLE external_notes USING fts5(content)");
      await source.execute("INSERT INTO external_notes(content) VALUES('primary external data')");
      source.close();
      const before = await fs.readFile(fixture.sourcePath);
      await expect(migrateDatabaseViaStaging({ ...fixture, quiesce: async () => ({ release: async () => {} }) })).rejects.toThrow("external_notes: undeclared table");
      expect(await fs.readFile(fixture.sourcePath)).toEqual(before);
      await expect(fs.stat(fixture.rollbackPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await fs.rm(fixture.directory, { recursive: true, force: true }); }
  });
});
