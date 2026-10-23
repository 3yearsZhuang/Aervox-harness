import { describe, expect, it } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository, SqliteLearningRepository, SqliteExtensionRepository } from "../src/index.js";
const ctx = { workspaceId: "local", subjectUserId: "local" };
const answer = { idempotencyKey: "invocation", turnId: "turn", prompt: "2+2", userAnswer: "3", correctAnswer: "4", judgement: "incorrect" as const };

describe("atomic application commands", () => {
  it("records a judged answer against the actual session and atomically emits once on retries", async () => {
    const database = await createInMemoryDatabase();
    try {
      const conversation = new SqliteConversationRepository(database.db), learning = new SqliteLearningRepository(database.db);
      await conversation.createSession(ctx, "parent", { id: "session" });
      await conversation.createTurnWithAttempt(ctx, { turnId: "turn", sessionId: "session", idempotencyKey: "turn", message: { id: "m", content: "question" }, attemptId: "at" });
      const result = await learning.recordJudgedAnswer(ctx, answer);
      expect(await learning.recordJudgedAnswer(ctx, answer)).toEqual(result);
      expect((await learning.listAttemptsBySession(ctx, "session"))).toHaveLength(1);
      expect((await learning.listAttemptsBySession(ctx, "turn"))).toHaveLength(0);
      expect((await database.client.execute("SELECT * FROM outbox_events WHERE event_type='learning.answer.recorded'")).rows).toHaveLength(1);
      await expect(learning.recordJudgedAnswer(ctx, { ...answer, userAnswer: "changed" })).rejects.toThrow("idempotency_conflict");
      await database.client.execute("CREATE TRIGGER fail_answer BEFORE INSERT ON question_attempts BEGIN SELECT RAISE(ABORT, 'injected'); END");
      await expect(learning.recordJudgedAnswer(ctx, { ...answer, idempotencyKey: "new" })).rejects.toThrow();
      expect((await database.client.execute("SELECT * FROM questions")).rows).toHaveLength(1);
    } finally { await database.cleanup(); }
  });
  it("creates the child and branch with parent policy, retries once and rolls back failures", async () => {
    const database = await createInMemoryDatabase();
    try {
      const repository = new SqliteConversationRepository(database.db);
      await repository.createSession(ctx, "parent", { id: "parent", executionPolicy: "bot-group-member-v1" });
      const input = { id: "branch", parentSessionId: "parent", childSessionId: "child", title: "explore" };
      const result = await repository.createExplorationBranch(ctx, input);
      expect(await repository.createExplorationBranch(ctx, input)).toEqual(result);
      expect((await repository.getSession(ctx, "child"))?.executionPolicy).toBe("bot-group-member-v1");
      await database.client.execute("CREATE TRIGGER fail_branch BEFORE INSERT ON conversation_branches BEGIN SELECT RAISE(ABORT, 'injected'); END");
      await expect(repository.createExplorationBranch(ctx, { ...input, id: "new", childSessionId: "orphan" })).rejects.toThrow();
      expect(await repository.getSession(ctx, "orphan")).toBeNull();
      expect(await repository.createExplorationBranch(ctx, { ...input, id: "missing", parentSessionId: "missing", childSessionId: "never" })).toBeNull();
    } finally { await database.cleanup(); }
  });
  it("revokes every plugin-owned durable command after disable/re-enable, while the new generation can write", async () => {
    const database = await createInMemoryDatabase();
    try {
      const conversation = new SqliteConversationRepository(database.db), learning = new SqliteLearningRepository(database.db);
      const extensions = new SqliteExtensionRepository(database.db);
      const plugin = await extensions.createPlugin({ id: "probe", publisher: "test", version: "1", checksum: "test" });
      await conversation.createSession(ctx, "parent", { id: "session" });
      await conversation.createTurnWithAttempt(ctx, { turnId: "turn", sessionId: "session", idempotencyKey: "turn", message: { id: "m", content: "question" }, attemptId: "at" });
      const stale = { pluginId: plugin.id, generation: plugin.lifecycleGeneration };
      const initialOutbox = (await database.client.execute("SELECT * FROM outbox_events")).rows;
      await extensions.setPluginEnabled(plugin.id, false);
      const active = await extensions.setPluginEnabled(plugin.id, true);
      const current = { pluginId: plugin.id, generation: active!.lifecycleGeneration };
      const report = { id: "report", sessionId: "session", totalQuestions: 1, correctCount: 0, incorrectCount: 1 };
      const branch = { id: "branch", parentSessionId: "session", childSessionId: "child" };
      const commands = [
        () => learning.recordJudgedAnswer(ctx, { ...answer, pluginGeneration: stale }),
        () => conversation.createExplorationBranch(ctx, { ...branch, pluginGeneration: stale }),
        () => learning.createPracticeReport(ctx, { ...report, pluginGeneration: stale }),
        () => learning.resetMasteryInference(ctx, "session", stale),
        () => conversation.createSession(ctx, "old", { id: "old-session", pluginGeneration: stale }),
        () => conversation.appendStreamEvent(ctx, { id: "old-event", turnId: "turn", sequence: 1, eventType: "plugin.probe", data: {}, pluginGeneration: stale }),
      ];
      for (const command of commands) await expect(command()).rejects.toThrow("plugin_generation_changed");
      for (const table of ["questions", "question_attempts", "conversation_branches", "practice_reports", "turn_stream_events"]) {
        expect((await database.client.execute(`SELECT * FROM ${table}`)).rows).toEqual([]);
      }
      expect((await database.client.execute("SELECT * FROM outbox_events")).rows).toEqual(initialOutbox);
      expect(await conversation.getSession(ctx, "old-session")).toBeNull();
      await learning.recordJudgedAnswer(ctx, { ...answer, pluginGeneration: current });
      await conversation.createExplorationBranch(ctx, { ...branch, pluginGeneration: current });
      await learning.createPracticeReport(ctx, { ...report, pluginGeneration: current });
      await learning.resetMasteryInference(ctx, "session", current);
      expect((await learning.listPracticeReports(ctx, "session"))).toHaveLength(2);
    } finally { await database.cleanup(); }
  });
});
