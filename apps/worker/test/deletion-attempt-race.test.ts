import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInMemoryDatabase, SqliteMemoryRepository, SqliteMemoryDeletionStore,
  SqlitePrivacyRepository, SqlitePlatformRepository,
} from "@aervox/repositories";
import { runDeletionCycle } from "../src/deletion-worker.js";

const local = { workspaceId: "local", subjectUserId: "local" };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("deletion_race_timeout")), 5000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

describe("deletion attempt completion races", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let privacy: SqlitePrivacyRepository;
  let platform: SqlitePlatformRepository;
  let memory: SqliteMemoryDeletionStore;
  beforeEach(async () => {
    database = await createInMemoryDatabase();
    privacy = new SqlitePrivacyRepository(database.db);
    platform = new SqlitePlatformRepository(database.db);
    memory = new SqliteMemoryDeletionStore(database.db);
    for (const id of ["target", "keep"]) {
      await new SqliteMemoryRepository(database.db, database.client).createRecord(local, {
        id, layer: "long_term", type: "user_fact", content: `private ${id}`,
      });
    }
    await privacy.createDeletionRequest(local, {
      id: "request", idempotencyKey: "request", scope: "memory", ownerModule: "memory",
      targets: [{ targetType: "memory", targetId: "target", ownerModule: "memory" }],
    });
  });
  afterEach(async () => { vi.restoreAllMocks(); await database.cleanup(); });
  const run = (workerId: string, privacyRepo = privacy, memoryDeletion: Pick<SqliteMemoryDeletionStore, "clean" | "verify"> = memory) =>
    runDeletionCycle({ workerId, privacyRepo, memoryDeletion });
  async function snapshot() {
    return {
      request: await privacy.getDeletionRequest(local, "request"),
      targets: await privacy.listDeletionTargets("request"),
      denied: await privacy.hasPendingDeletionRequest(local),
      audits: (await platform.listAuditRecords(local)).filter(audit => audit.action === "deletion.completed"),
    };
  }

  async function prepareVerifiedAttempt() {
    const claimed = await privacy.beginDeletionRequestAttempt("request");
    const key = { requestId: claimed!.id, requestAttemptCount: claimed!.attemptCount };
    const targetKey = { ...key, targetType: "memory", targetId: "target" };
    expect(await privacy.beginDeletionTargetAttempt(targetKey)).not.toBeNull();
    await memory.clean("target");
    expect(await privacy.updateDeletionTargetAttemptStatus(targetKey, { status: "completed", evidenceRef: await memory.verify("target") })).not.toBeNull();
    return key;
  }

  it("does not report completion after a newer cycle clears its proof", async () => {
    const privacyA = new SqlitePrivacyRepository(database.db);
    const proofWritten = deferred(), releaseA = deferred(), enteredB = deferred(), releaseB = deferred();
    const writeResult = privacyA.updateDeletionTargetAttemptStatus.bind(privacyA);
    vi.spyOn(privacyA, "updateDeletionTargetAttemptStatus").mockImplementationOnce(async (...args) => {
      const result = await writeResult(...args);
      proofWritten.resolve(); await releaseA.promise;
      return result;
    });
    const cycleA = run("a", privacyA);
    let cycleB: Promise<number> | undefined;
    try {
      await bounded(proofWritten.promise);
      cycleB = run("b", privacy, {
        clean: async id => { enteredB.resolve(); await releaseB.promise; await memory.clean(id); },
        verify: memory.verify.bind(memory),
      });
      await bounded(enteredB.promise);
      releaseA.resolve();
      expect(await bounded(cycleA)).toBe(0);
      const between = await snapshot();
      expect(between.request).toMatchObject({ status: "in_progress", attemptCount: 2 });
      expect(between.targets[0]).toMatchObject({ status: "in_progress", verifiedAt: null, evidenceRef: null });
      expect(between.denied).toBe(true); expect(between.audits).toHaveLength(0);
      releaseB.resolve();
      expect(await bounded(cycleB)).toBe(1);
      const after = await snapshot();
      expect(after.denied).toBe(false); expect(after.audits).toHaveLength(1);
    } finally {
      releaseA.resolve(); releaseB.resolve();
      await cycleA.catch(() => undefined); await cycleB?.catch(() => undefined);
    }
  });

  it.each([false, true])("preserves the newer completion after an old cleanup returns (failure=%s)", async fails => {
    const entered = deferred(), release = deferred();
    const cycleA = run("a", new SqlitePrivacyRepository(database.db), {
      clean: async id => {
        entered.resolve(); await release.promise;
        if (fails) throw new Error("stale_cleanup_failed");
        await memory.clean(id);
      },
      verify: memory.verify.bind(memory),
    });
    try {
      await bounded(entered.promise);
      expect(await bounded(run("b"))).toBe(1);
      const afterB = await snapshot();
      expect(afterB.denied).toBe(false); expect(afterB.audits).toHaveLength(1);
      release.resolve();
      expect(await bounded(cycleA)).toBe(0);
      expect(await snapshot()).toEqual(afterB);
      await expect(memory.verify("target")).resolves.toContain("memory-local-v3");
    } finally { release.resolve(); await cycleA.catch(() => undefined); }
  });

  it("does not clean when an old target begin is superseded", async () => {
    const privacyA = new SqlitePrivacyRepository(database.db);
    const entered = deferred(), release = deferred();
    const list = privacyA.listDeletionTargets.bind(privacyA);
    vi.spyOn(privacyA, "listDeletionTargets").mockImplementationOnce(async id => {
      const targets = await list(id); entered.resolve(); await release.promise;
      return targets;
    });
    const clean = vi.fn(memory.clean.bind(memory)), verify = vi.fn(memory.verify.bind(memory));
    const cycleA = run("a", privacyA, { clean, verify });
    try {
      await bounded(entered.promise);
      expect(await bounded(run("b"))).toBe(1);
      const afterB = await snapshot();
      release.resolve();
      expect(await bounded(cycleA)).toBe(0);
      expect(clean).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(afterB);
    } finally { release.resolve(); await cycleA.catch(() => undefined); }
  });

  it("does not persist request completion when its audit insert fails, and retries", async () => {
    await database.client.execute("CREATE TRIGGER reject_completion_audit BEFORE INSERT ON audit_records WHEN NEW.action = 'deletion.completed' BEGIN SELECT RAISE(ABORT, 'audit insert failed'); END");
    expect(await run("a")).toBe(0);
    const failed = await snapshot();
    expect(failed.request?.status).not.toBe("completed");
    expect(failed.denied).toBe(true); expect(failed.audits).toHaveLength(0);
    await database.client.execute("DROP TRIGGER reject_completion_audit");
    expect(await run("b")).toBe(1);
    const after = await snapshot();
    expect(after.denied).toBe(false); expect(after.audits).toHaveLength(1);
    expect((await new SqliteMemoryRepository(database.db, database.client).getRecord(local, "keep"))?.content).toBe("private keep");
  });

  it("rolls the ready request transition back in the same writer as a failed audit", async () => {
    const key = await prepareVerifiedAttempt();
    const before = await snapshot();
    await database.client.execute("CREATE TRIGGER reject_completion_audit BEFORE INSERT ON audit_records WHEN NEW.action = 'deletion.completed' BEGIN SELECT RAISE(ABORT, 'audit insert failed'); END");
    await expect(privacy.finalizeDeletionRequestAttempt(key, "a")).rejects.toThrow("Database query failed");
    expect(await snapshot()).toEqual(before);
    await database.client.execute("DROP TRIGGER reject_completion_audit");
    expect(await privacy.finalizeDeletionRequestAttempt(key, "a")).toMatchObject({ status: "completed", attemptCount: key.requestAttemptCount });
    expect((await snapshot()).audits).toHaveLength(1);
  });

  it("commits exactly one completion and audit when the same attempt finalizes twice", async () => {
    const key = await prepareVerifiedAttempt();
    expect(await privacy.finalizeDeletionRequestAttempt(key, "a")).not.toBeNull();
    const completed = await snapshot();
    expect(await privacy.finalizeDeletionRequestAttempt(key, "a")).toBeNull();
    expect(await snapshot()).toEqual(completed);
    expect(completed.denied).toBe(false); expect(completed.audits).toHaveLength(1);
    expect(completed.audits[0]?.metadata).toMatchObject({ scope: "memory", verifier: "memory-local-v3", targetCount: 1 });
  });

  it("preserves exact NUL request and target identities through fenced completion", async () => {
    const requestId = "request\0tail", targetId = "target\0tail";
    await new SqliteMemoryRepository(database.db, database.client).createRecord(local, {
      id: targetId, layer: "long_term", type: "user_fact", content: "private NUL identity",
    });
    await privacy.createDeletionRequest(local, {
      id: requestId, idempotencyKey: requestId, scope: "memory", ownerModule: "memory",
      targets: [{ targetType: "memory", targetId, ownerModule: "memory" }],
    });
    expect(await run("a")).toBe(2);
    expect(await privacy.getDeletionRequest(local, "request")).toMatchObject({ id: "request", status: "completed", attemptCount: 1 });
    expect(await privacy.getDeletionRequest(local, requestId)).toMatchObject({ id: requestId, status: "completed", attemptCount: 1 });
    expect((await privacy.listDeletionTargets(requestId))[0]).toMatchObject({ requestId, targetId, status: "completed" });
    expect(await privacy.hasPendingDeletionRequest(local)).toBe(false);
    const audits = await database.client.execute({ sql: "SELECT count(*) AS count FROM audit_records WHERE action = 'deletion.completed' AND subject_id = ?", args: [requestId] });
    expect(audits.rows[0]?.count).toBe(1);
    await expect(memory.verify(targetId)).resolves.toContain("memory-local-v3");
    expect((await new SqliteMemoryRepository(database.db, database.client).getRecord(local, "keep"))?.content).toBe("private keep");
  });
});
