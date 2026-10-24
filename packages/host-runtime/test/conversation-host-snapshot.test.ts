import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository } from "@aervox/repositories";
import { loadExecutionConfig } from "@aervox/config";
import { ControlContext, type SubagentPort } from "@aervox/core";
import type { resumeCommittedTurns } from "@aervox/host-agent";

const captured = vi.hoisted(() => ({ children: [] as SubagentPort[], resumes: [] as Parameters<typeof resumeCommittedTurns>[0][] }));
vi.mock("@aervox/host-agent", async importOriginal => {
  const actual = await importOriginal<typeof import("@aervox/host-agent")>();
  return { ...actual,
    createSqliteSubagentPort: (deps: Parameters<typeof actual.createSqliteSubagentPort>[0]) => {
      const child = actual.createSqliteSubagentPort(deps); captured.children.push(child); return child;
    },
    resumeCommittedTurns: (deps: Parameters<typeof actual.resumeCommittedTurns>[0]) => {
      captured.resumes.push(deps); return actual.resumeCommittedTurns(deps);
    },
  };
});
import { registerConversationModule } from "../src/modules/companion/conversation/index.js";
import { createConversationApplication } from "../src/modules/companion/conversation/application.js";

it("uses the composition snapshot for main, child and existing resume provider closures", async () => {
  const database = await createInMemoryDatabase(); const app = Fastify();
  const config = { ...loadExecutionConfig({ AERVOX_LOOP_PROVIDER: "replay" }), turnExecution: "inline" as const };
  const host = registerConversationModule({ app, db: database.db, client: database.client, executionConfig: config }, { startupRecovery: false });
  const local = { workspaceId: "local", subjectUserId: "local" };
  try {
    await app.ready();
    // All callbacks have been composed, but none has selected a provider yet.
    config.loopProvider = "llm";
    await host.commands.createTurn(local, { turnId: "parent", sessionId: "session", attemptId: "parent-attempt",
      idempotencyKey: "parent", message: { id: "message", content: "hello" } });
    expect((await host.queries.getTurn(local, "parent"))?.status).toBe("Completed");
    const result = await captured.children.at(-1)!.delegate({ parentTurnId: "parent", parentAttemptId: "parent-attempt",
      parentExecutionId: "parent-attempt:1:1", sessionId: "session", task: "child" });
    expect(result.status).toBe("Completed");
    expect(result.resultText).toBeTruthy();
    await host.resume();
    const control = new ControlContext({ localProcessingOnly: true });
    try {
      const provider = await captured.resumes.at(-1)!.createProvider({ turnId: "existing", sessionId: "session", attemptId: "existing-attempt", userMessage: "hello" }, control);
      expect(provider.id).toBe("replay");
    } finally { control.dispose(); }
  } finally { await app.close(); await database.cleanup(); captured.children.length = 0; captured.resumes.length = 0; }
});

it("owns one stale-execution recovery flight and waits for it during close", async () => {
  const database = await createInMemoryDatabase();
  const repo = new SqliteConversationRepository(database.db);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const order: string[] = [];
  const resume = vi.fn(async () => { order.push("resume"); entered(); await gate; });
  const expired = vi.spyOn(repo, "recoverExpiredAttempts").mockImplementation(async () => { order.push("expired"); return 1; });
  const unknown = vi.spyOn(repo, "markPendingOutcomeUnknown").mockImplementation(async () => { order.push("unknown"); return 2; });
  const orphans = vi.spyOn(repo, "recoverOrphanTurns").mockImplementation(async () => { order.push("orphans"); return 3; });
  const application = createConversationApplication(repo, { executionConfig: loadExecutionConfig() }, undefined, { client: database.client, resume });
  try {
    const first = application.commands.recoverStaleExecutions();
    expect(application.commands.recoverStaleExecutions()).toBe(first);
    await started;
    expect(expired).not.toHaveBeenCalled();
    let closed = false;
    const closing = application.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(() => application.commands.recoverStaleExecutions()).toThrow("conversation_host_closed");
    release();
    await expect(first).resolves.toEqual({ recoveredAttempts: 1, unknownOutcomes: 2, orphanTurns: 3, resumeFailed: false });
    await closing;
    expect(order).toEqual(["resume", "expired", "unknown", "orphans"]);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(expired).toHaveBeenCalledExactlyOnceWith(database.client, { dispatchTarget: "default" });
    expect(unknown).toHaveBeenCalledExactlyOnceWith(database.client, { dispatchTarget: "default" });
    expect(orphans).toHaveBeenCalledExactlyOnceWith({ dispatchTarget: "default" });
  } finally { release(); await application.close(); await database.cleanup(); }
});

it("keeps stale-execution recovery unavailable without its explicit storage composition", async () => {
  const database = await createInMemoryDatabase();
  const repo = new SqliteConversationRepository(database.db);
  const expired = vi.spyOn(repo, "recoverExpiredAttempts");
  const application = createConversationApplication(repo, { executionConfig: loadExecutionConfig() });
  try {
    expect(() => application.commands.recoverStaleExecutions()).toThrow("conversation_recovery_unavailable");
    expect(expired).not.toHaveBeenCalled();
  } finally { await application.close(); await database.cleanup(); }
});

it("continues real stale and orphan convergence after optional local-result resume fails", async () => {
  const database = await createInMemoryDatabase();
  const repo = new SqliteConversationRepository(database.db);
  const local = { workspaceId: "local", subjectUserId: "local" };
  const resume = vi.fn(async () => { throw new Error("sensitive_provider_error"); });
  const application = createConversationApplication(repo, { executionConfig: loadExecutionConfig() }, undefined, { client: database.client, resume });
  try {
    await repo.createSession(local, "session", { id: "session" });
    await repo.acceptTurn(local, { turnId: "stale", sessionId: "session", idempotencyKey: "stale", execution: "worker",
      attemptId: "attempt", message: { id: "message", content: "hello" }, consumeInbox: false });
    await repo.reserveToolExecution(local, { turnId: "stale", attemptId: "attempt", invocationId: "unknown", name: "notes_search", arguments: {} });
    await repo.createTurnWithOutbox(local, { id: "orphan", sessionId: "session", idempotencyKey: "orphan" }, { id: "orphan-input", content: "hello" });
    await database.client.execute("UPDATE turn_attempts SET lease_expires_at = '2000-01-01T00:00:00.000Z'");
    await database.client.execute("UPDATE turns SET created_at = '2000-01-01T00:00:00.000Z'");
    await expect(application.commands.recoverStaleExecutions()).resolves.toEqual({
      recoveredAttempts: 1, unknownOutcomes: 0, orphanTurns: 1, resumeFailed: true,
    });
    expect((await repo.getTurn(local, "stale"))?.status).toBe("Interrupted");
    expect((await repo.getTurn(local, "orphan"))?.status).toBe("Interrupted");
    expect((await repo.listToolExecutionsByTurn(local, "stale"))[0].status).toBe("outcome_unknown");
    const done = await repo.getStreamEvents(local, "stale");
    expect(done.filter(event => event.eventType === "done")).toHaveLength(1);
    await expect(application.commands.recoverStaleExecutions()).resolves.toEqual({
      recoveredAttempts: 0, unknownOutcomes: 0, orphanTurns: 0, resumeFailed: true,
    });
    expect(await repo.getStreamEvents(local, "stale")).toEqual(done);
  } finally { await application.close(); await database.cleanup(); }
});

it("releases failed recovery ownership without running subsequent phases or poisoning the next call", async () => {
  const database = await createInMemoryDatabase();
  const repo = new SqliteConversationRepository(database.db);
  const failure = new Error("recovery_storage_failure");
  const expired = vi.spyOn(repo, "recoverExpiredAttempts").mockRejectedValueOnce(failure).mockResolvedValue(0);
  const unknown = vi.spyOn(repo, "markPendingOutcomeUnknown");
  const orphans = vi.spyOn(repo, "recoverOrphanTurns").mockResolvedValue(0);
  const application = createConversationApplication(repo, { executionConfig: loadExecutionConfig() }, undefined, { client: database.client });
  try {
    await expect(application.commands.recoverStaleExecutions()).rejects.toBe(failure);
    expect(unknown).not.toHaveBeenCalled();
    expect(orphans).not.toHaveBeenCalled();
    await expect(application.commands.recoverStaleExecutions()).resolves.toEqual({
      recoveredAttempts: 0, unknownOutcomes: 0, orphanTurns: 0, resumeFailed: false,
    });
    expect(expired).toHaveBeenCalledTimes(2);
    expect(unknown).not.toHaveBeenCalled();
    expect(orphans).toHaveBeenCalledTimes(1);
  } finally { await application.close(); await database.cleanup(); }
});

it.each(["off", "local-results"] as const)("captures %s local-result resume configuration for recovery commands", async loopResume => {
  const database = await createInMemoryDatabase(); const app = Fastify();
  const config = { ...loadExecutionConfig({ AERVOX_LOOP_PROVIDER: "replay" }), loopResume };
  const host = registerConversationModule({ app, db: database.db, client: database.client, executionConfig: config }, { startupRecovery: false });
  const before = captured.resumes.length;
  try {
    await app.ready();
    config.loopResume = loopResume === "off" ? "local-results" : "off";
    await expect(host.commands.recoverStaleExecutions()).resolves.toEqual({
      recoveredAttempts: 0, unknownOutcomes: 0, orphanTurns: 0, resumeFailed: false,
    });
    expect(captured.resumes.length - before).toBe(loopResume === "off" ? 0 : 1);
  } finally { await app.close(); await database.cleanup(); captured.resumes.length = 0; }
});

it.each([false, true])("captures recovery composition before its owner mutates storage or resume opt-in (%s)", async enabled => {
  const database = await createInMemoryDatabase(); const replacement = await createInMemoryDatabase();
  const repo = new SqliteConversationRepository(database.db);
  const originalResume = vi.fn(async () => undefined);
  const replacementResume = vi.fn(async () => undefined);
  const recovery = { client: database.client, resume: enabled ? originalResume : undefined };
  const application = createConversationApplication(repo, { executionConfig: loadExecutionConfig() }, undefined, recovery);
  const expired = vi.spyOn(repo, "recoverExpiredAttempts");
  try {
    recovery.client = replacement.client;
    recovery.resume = replacementResume;
    await application.commands.recoverStaleExecutions();
    expect(expired).toHaveBeenCalledExactlyOnceWith(database.client, { dispatchTarget: "default" });
    expect(originalResume).toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect(replacementResume).not.toHaveBeenCalled();
  } finally { await application.close(); await database.cleanup(); await replacement.cleanup(); }
});
