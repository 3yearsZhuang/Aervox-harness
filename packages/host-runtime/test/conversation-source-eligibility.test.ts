import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository, SqliteToolRegistryRepository } from "@aervox/repositories";
import { loadExecutionConfig } from "@aervox/config";
import type { ModelProviderPort } from "@aervox/core";
import { ToolRuntime } from "../src/modules/ecosystem/tools/index.js";
import { ServerPluginRegistry } from "../src/modules/ecosystem/plugins/turn-plugins/registry.js";

const injected = vi.hoisted(() => ({ provider: undefined as ModelProviderPort | undefined }));
vi.mock("../src/modules/companion/conversation/llm-adapter.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/modules/companion/conversation/llm-adapter.js")>(),
  buildLoopProvider: async () => injected.provider!,
}));
import { executeConversationTurn } from "../src/modules/companion/conversation/execution.js";

afterEach(() => { injected.provider = undefined; });
const local = { workspaceId: "local", subjectUserId: "local" };
const input = { turnId: "turn", sessionId: "session", attemptId: "attempt", userMessage: "accepted source" };

describe("accepted input eligibility across execution checkpoints", () => {
  it.each([
    ["soft-deleted", "preparation"], ["missing", "preparation"],
    ["soft-deleted", "before-tools"], ["missing", "before-tools"],
    ["soft-deleted", "next-step"], ["missing", "next-step"],
  ] as const)("interrupts after input is %s during %s", async (failure, phase) => {
    const database = await createInMemoryDatabase();
    const repo = new SqliteConversationRepository(database.db);
    const toolRuntime = new ToolRuntime({ registry: new SqliteToolRegistryRepository(database.db) });
    let providerCalls = 0;
    let toolCalls = 0;
    const revokeInput = async () => {
      if (failure === "soft-deleted") await repo.softDeleteMessage(local, "message");
      else await repo.deleteMessage(local, "message");
    };
    try {
      await repo.getOrCreateSession(local, input.sessionId);
      await repo.acceptTurn(local, { ...input, idempotencyKey: "turn", execution: "api", message: { id: "message", content: input.userMessage } });
      await repo.createMessage(local, { id: "message", sessionId: input.sessionId, role: "user" });
      await toolRuntime.registerTool({ id: "source_probe", name: "source_probe", description: "Read a fixture value", category: "memory",
        safetyLevel: "read_only", requiredPermissions: [], inputSchema: { type: "object", properties: {} }, builtin: true, gatingConditions: [] });
      toolRuntime.registerHandler("source_probe", { call: async () => {
        toolCalls++;
        if (phase === "next-step") await revokeInput();
        return { result: "fixture value" };
      } });
      injected.provider = { id: "source-eligibility-probe", async *stream(request) {
        providerCalls++;
        if (request.step === 1) {
          if (phase === "before-tools") await revokeInput();
          yield { text: "", isFinal: true, stopReason: "tool_calls", toolCalls: [{ id: "probe_call", name: "source_probe", arguments: {} }] };
        } else yield { text: "completed", isFinal: true, stopReason: "stop" };
      } };
      await executeConversationTurn(repo, local, input, {
        executionConfig: loadExecutionConfig({ AERVOX_LOOP_PROVIDER: "replay" }), toolRuntime,
        pluginRegistry: new ServerPluginRegistry(),
        prepareExecution: phase === "preparation" ? revokeInput : undefined,
      });
      expect(providerCalls).toBe(phase === "preparation" ? 0 : 1);
      expect(toolCalls).toBe(phase === "next-step" ? 1 : 0);
      expect((await repo.listTurnAttempts(local, input.turnId))[0]?.status).toBe("Interrupted");
      const events = await repo.getStreamEvents(local, input.turnId);
      expect(events.filter(event => ["done", "error"].includes(event.eventType))).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ eventType: "done", data: { status: "Interrupted", isComplete: false, reason: "deletion_blocked" } });
    } finally { await toolRuntime.dispose(); await database.cleanup(); }
  });
});
