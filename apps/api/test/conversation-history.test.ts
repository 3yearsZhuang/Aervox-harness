import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRequest, PromptMessage } from "@aervox/agent-loop";
import { createInMemoryDatabase } from "@aervox/database";
import { buildApp } from "../src/app.js";

const captured = vi.hoisted(() => ({ requests: [] as ModelRequest[], useTool: false }));
vi.mock("@aervox/agent-loop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aervox/agent-loop")>();
  return {
    ...actual,
    createReplayProvider: () => ({
      id: "history-test",
      async *stream(request: ModelRequest) {
        captured.requests.push(structuredClone(request));
        if (captured.useTool && request.step === 1) {
          yield {
            text: "让我查一下。",
            isFinal: true,
            toolCalls: [{ id: "history_call", name: "history_lookup", arguments: {} }],
          };
          return;
        }
        yield { text: "好的，小庄。", isFinal: true };
      },
    }),
  };
});

const headers = { "x-workspace-id": "ws_history", "x-user-id": "usr_history" };

describe("跨 Turn 会话历史进入模型请求", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let built: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    vi.stubEnv("AERVOX_LOOP_PROVIDER", "replay");
    vi.stubEnv("AERVOX_TURN_EXECUTION", "inline");
    captured.requests.length = 0;
    captured.useTool = false;
    database = await createInMemoryDatabase();
    built = await buildApp({ db: database.db, client: database.client });
    await built.app.ready();
  });

  afterEach(async () => {
    await built.app.close();
    await database.cleanup();
    vi.unstubAllEnvs();
  });

  async function send(sessionId: string, content: string) {
    const response = await built.app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/turns`,
      headers,
      payload: { message: { content, contentType: "text" }, clientVersion: "history-test", references: [] },
    });
    expect(response.statusCode).toBe(201);
  }

  function dialogue(): PromptMessage[] {
    return captured.requests.at(-1)!.context.messages.filter((message) => message.role !== "system");
  }

  it("第二轮收到第一轮用户与助手正文，当前输入只出现一次", async () => {
    await send("ses_history", "我叫小庄");
    await send("ses_history", "我叫什么？");
    expect(dialogue()).toEqual([
      { role: "user", content: "我叫小庄" },
      { role: "assistant", content: "好的，小庄。" },
      { role: "user", content: "我叫什么？" },
    ]);
  });

  it("新会话不会携带其他会话历史", async () => {
    await send("ses_history", "我叫小庄");
    await send("ses_other", "你好");
    expect(dialogue()).toEqual([{ role: "user", content: "你好" }]);
  });

  it("多 Step 每次只注入一份历史，同时保留本轮工具结果", async () => {
    await send("ses_history", "我叫小庄");
    await built.toolRuntime.registerTool({
      id: "history_lookup", name: "history_lookup", description: "test lookup",
      category: "memory", safetyLevel: "read_only", requiredPermissions: [],
      inputSchema: { type: "object", properties: {} },
      builtin: false, gatingConditions: [], priority: 1,
    });
    built.toolRuntime.registerHandler("history_lookup", { call: async () => ({ found: true }) });
    captured.useTool = true;
    await send("ses_history", "查一下");
    expect(captured.requests.at(-1)!.step).toBe(2);
    expect(dialogue().filter((message) => message.content === "我叫小庄")).toHaveLength(1);
    expect(dialogue().filter((message) => message.content === "查一下")).toHaveLength(1);
    expect(dialogue().some((message) => message.role === "tool" && message.content.includes('"found":true'))).toBe(true);
  });
});
