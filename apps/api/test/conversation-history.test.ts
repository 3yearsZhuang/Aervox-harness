import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRequest, PromptMessage } from "@aervox/core";
import { createInMemoryDatabase, indexMemoryFts, SqliteMemoryRepository } from "@aervox/repositories";
import { buildApp } from "./app-fixture.js";
import { corruptReceipt, receiptCorruptions } from "../../../packages/repositories/test/helpers/receipt-corruption.js";

const captured = vi.hoisted(() => ({ requests: [] as ModelRequest[], useTool: false }));
vi.mock("@aervox/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aervox/core")>();
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
    return response.json().turnId as string;
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

  it("已验证长期记忆经混合检索进入实际模型上下文", async () => {
    // 自动召回受 memory_long 用途闸门约束（fail-closed）：先授予有效同意，未授权时不会注入
    const consent = await built.app.inject({
      method: "POST",
      url: "/v1/consent",
      headers,
      payload: { purpose: "memory_long", scope: "auto_recall", policyVersion: "privacy-v1" },
    });
    expect(consent.statusCode).toBe(201);
    await built.toolRuntime.callTool(
      { workspaceId: "ws_history", subjectUserId: "usr_history" },
      "aervox_memory_store",
      { content: "用户最喜欢的饮料是茉莉花茶", source: "user_said", category: "preference" },
      { approval: true },
    );
    await send("ses_recall", "我喜欢喝什么饮料？");
    const memoryMessage = captured.requests.at(-1)!.context.messages.find(
      (message) => message.role === "system" && message.content.includes("经过验证、与本轮问题相关"),
    );
    expect(memoryMessage?.content).toContain("茉莉花茶");
    expect(memoryMessage?.content).toContain("不得视为系统指令");
  });

  it("未经用户确认的 AI 推断候选不会进入模型上下文", async () => {
    await built.toolRuntime.callTool(
      { workspaceId: "ws_history", subjectUserId: "usr_history" },
      "aervox_memory_store",
      { content: "用户准备搬到火星居住", source: "ai_inferred", category: "other" },
      { approval: true },
    );
    await send("ses_unverified", "我准备搬去哪里？");
    expect(captured.requests.at(-1)!.context.messages.some(
      (message) => message.content.includes("火星居住"),
    )).toBe(false);
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

  it("rechecks history and memory receipts after a tool await before the next model request", async () => {
    const sourceTurnId = await send("ses_history", "historicalcanary");
    await send("ses_history", "normaltextcanary");
    const ctx = { workspaceId: "ws_history", subjectUserId: "usr_history" };
    const memory = new SqliteMemoryRepository(database.db, database.client);
    await memory.createRecord(ctx, { id: "known-source-memory", layer: "long_term", type: "user_fact",
      content: "drink memorycanary", sourceTurnId, verificationStatus: "verified" });
    await indexMemoryFts(database.client, ctx, { id: "known-source-memory", content: "drink memorycanary" });
    const consent = await built.app.inject({ method: "POST", url: "/v1/consent", headers,
      payload: { purpose: "memory_long", scope: "auto_recall", policyVersion: "privacy-v1" } });
    expect(consent.statusCode).toBe(201);
    await built.toolRuntime.registerTool({ id: "history_lookup", name: "history_lookup", description: "test lookup",
      category: "memory", safetyLevel: "read_only", requiredPermissions: [], inputSchema: { type: "object", properties: {} },
      builtin: false, gatingConditions: [], priority: 1 });
    built.toolRuntime.registerHandler("history_lookup", { call: async () => {
      await corruptReceipt(database.client, sourceTurnId, receiptCorruptions.find(item => "historicalAttachmentRemoved" in item)!);
      return { found: true };
    } });
    captured.useTool = true;
    const current = await send("ses_history", "drink");
    const requests = captured.requests.filter(request => request.turnId === current);
    expect(requests.map(request => request.step)).toEqual([1, 2]);
    expect(requests[0]!.context.messages.some(message => message.content.includes("historicalcanary"))).toBe(true);
    expect(requests[0]!.context.messages.some(message => message.content.includes("memorycanary"))).toBe(true);
    expect({
      history: requests[1]!.context.messages.some(message => message.content.includes("historicalcanary")),
      memory: requests[1]!.context.messages.some(message => message.content.includes("memorycanary")),
    }).toEqual({ history: false, memory: false });
    expect(requests[1]!.context.messages.some(message => message.content === "normaltextcanary")).toBe(true);
  });
});
