import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { createInMemoryDatabase } from "@aervox/repositories";
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
