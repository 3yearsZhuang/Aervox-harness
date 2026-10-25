import { describe, expect, it, vi } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository, SqlitePlatformRepository, SqliteToolRegistryRepository } from "@aervox/repositories";
import { loadExecutionConfig } from "@aervox/config";
import type { ModelProviderPort, ModelRequest } from "@aervox/core";
import { ToolRuntime } from "../src/modules/ecosystem/tools/index.js";
import { ServerPluginRegistry } from "../src/modules/ecosystem/plugins/turn-plugins/registry.js";

const injected = vi.hoisted(() => ({ provider: undefined as ModelProviderPort | undefined }));
vi.mock("../src/modules/companion/conversation/llm-adapter.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/modules/companion/conversation/llm-adapter.js")>(),
  buildLoopProvider: async () => injected.provider!,
}));
import { executeConversationTurn } from "../src/modules/companion/conversation/execution.js";

describe("Conversation ContextManifest SQLite sink", () => {
  it.each(["none", "before_tools", "after_tools"] as const)("minimizes each actual request after %s failure", async failure => {
    const database = await createInMemoryDatabase();
    const repo = new SqliteConversationRepository(database.db);
    const toolRuntime = new ToolRuntime({ registry: new SqliteToolRegistryRepository(database.db) });
    const local = { workspaceId: "local", subjectUserId: "local" };
    const input = { turnId: "turn", sessionId: "session", attemptId: "attempt", userMessage: "PRIVATE user prompt" };
    const requests: ModelRequest[] = [];
    try {
      for (const id of ["lookup_one", "lookup_two"]) {
        await toolRuntime.registerTool({ id, name: id, description: `PRIVATE ${id} description`, category: "memory",
          safetyLevel: "read_only", requiredPermissions: [], inputSchema: {
            type: "object", description: "PRIVATE schema description", properties: {
              query: { type: "string", description: "PRIVATE nested description", default: "PRIVATE default" },
            },
          }, builtin: true, gatingConditions: [] });
        toolRuntime.registerHandler(id, { call: async () => ({ result: `PRIVATE ${id} output` }) });
      }
      injected.provider = { id: "manifest-probe", async *stream(request) {
        requests.push(structuredClone({ ...request, signal: undefined }));
        if (failure === "before_tools" && requests.length === 1) throw new Error("PRIVATE provider failure");
        if (request.step === 1) {
          yield { text: "PRIVATE assistant text", reasoning: "PRIVATE assistant reasoning", isFinal: true, stopReason: "tool_calls",
            toolCalls: ["lookup_one", "lookup_two"].map((name, index) => ({ id: `call_${index}`, name, arguments: { query: "PRIVATE arguments" } })) };
        } else {
          expect(JSON.stringify(request.context.messages)).toContain("PRIVATE lookup_one output");
          expect(JSON.stringify(request.context.messages)).toContain("PRIVATE lookup_two output");
          if (failure === "after_tools") throw new Error("PRIVATE provider failure");
          yield { text: "complete", isFinal: true, stopReason: "stop" };
        }
      } };
      await repo.getOrCreateSession(local, input.sessionId, "Manifest");
      await repo.acceptTurn(local, { ...input, idempotencyKey: "turn", execution: "worker",
        message: { id: "message", content: input.userMessage } });
      await executeConversationTurn(repo, local, input, {
        executionConfig: loadExecutionConfig({ AERVOX_LOOP_PROVIDER: "replay" }),
        platformRepo: new SqlitePlatformRepository(database.db), toolRuntime, pluginRegistry: new ServerPluginRegistry(),
        personaLoader: async () => ({ name: "test", prompt: "PRIVATE persona prompt" }),
      });
      expect(requests).toHaveLength(failure === "before_tools" ? 3 : 2);
      expect(requests.every(request => request.tools?.length === 2)).toBe(true);
      expect(JSON.stringify(requests[0])).toContain("PRIVATE nested description");
      const modelVisible = JSON.stringify(requests.at(-1)!.context.messages);
      expect(modelVisible).toContain("PRIVATE lookup_one output");
      expect(modelVisible).toContain("PRIVATE lookup_two output");
      expect(modelVisible).toContain("PRIVATE assistant reasoning");
      const recorded = await database.client.execute("SELECT mr.id, mr.status, mr.context_manifest_id, cm.id AS manifest_id, cm.snapshot_json FROM model_runs mr JOIN context_manifests cm ON cm.model_run_id=mr.id ORDER BY mr.created_at, mr.id");
      expect(recorded.rows).toHaveLength(requests.length);
      expect(recorded.rows.map(row => row.status)).toEqual(failure === "before_tools"
        ? ["failed", "completed", "completed"] : ["completed", failure === "after_tools" ? "failed" : "completed"]);
      expect(new Set(recorded.rows.map(row => row.id)).size).toBe(requests.length);
      for (const [index, row] of recorded.rows.entries()) {
        expect(row.context_manifest_id).toBe(row.manifest_id);
        const raw = String(row.snapshot_json);
        expect(raw).not.toContain("PRIVATE");
        const roles = { system: 0, user: 0, assistant: 0, tool: 0 };
        for (const message of requests[index]!.context.messages) roles[message.role] += 1;
        expect(JSON.parse(raw)).toEqual({ version: 2, kind: "request-metadata",
          messageCount: requests[index]!.context.messages.length, messageRoles: roles, toolCount: 2 });
      }
      expect((await repo.getTurn(local, input.turnId))?.status).toBe(failure === "after_tools" ? "Failed" : "Completed");
    } finally { injected.provider = undefined; await toolRuntime.dispose(); await database.cleanup(); }
  });
});
