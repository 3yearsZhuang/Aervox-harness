import { describe, expect, it } from "vitest";
import {
  HostToolRuntime,
  HostToolValidationError,
  InMemoryToolRegistry,
  executeTurn,
  defaultContextBuilder,
  InMemoryExecutionStore,
  type HostToolHandler,
} from "../src/index.js";

const localCtx = {
  workspaceId: "ws_default",
  subjectUserId: "user_owner",
};

describe("Tool Contract & Schema Validation (HostToolRuntime)", () => {
  it("参数符合 Schema 时正常执行 Handler 并返回输出", async () => {
    const registry = new InMemoryToolRegistry();
    const runtime = new HostToolRuntime({ registry });

    await registry.registerTool({
      id: "note_writer",
      name: "aervox_save_note",
      description: "保存笔记",
      category: "productivity",
      safetyLevel: "read_only",
      enabled: 1,
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          content: { type: "string" },
        },
        required: ["title", "content"],
      },
    });

    let handlerCalled = false;
    const handler: HostToolHandler = {
      call: async (_ctx, args) => {
        handlerCalled = true;
        const { title, content } = args as { title: string; content: string };
        return { saved: true, title, length: content.length };
      },
    };
    runtime.registerHandler("note_writer", handler);

    const result = await runtime.callTool(localCtx, "note_writer", {
      title: "白盒架构",
      content: "契约驱动与统一诊断",
    });

    expect(handlerCalled).toBe(true);
    expect(result).toEqual({ saved: true, title: "白盒架构", length: 9 });
  });

  it("参数缺失必填字段时，抛出 HostToolValidationError 且 Handler 绝不被调用", async () => {
    const registry = new InMemoryToolRegistry();
    const runtime = new HostToolRuntime({ registry });

    await registry.registerTool({
      id: "note_writer",
      name: "aervox_save_note",
      description: "保存笔记",
      category: "productivity",
      safetyLevel: "read_only",
      enabled: 1,
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          content: { type: "string" },
        },
        required: ["title", "content"],
      },
    });

    let handlerCalled = false;
    const handler: HostToolHandler = {
      call: async () => {
        handlerCalled = true;
        return { saved: true };
      },
    };
    runtime.registerHandler("note_writer", handler);

    await expect(
      runtime.callTool(localCtx, "note_writer", { title: "Only Title" }),
    ).rejects.toThrow(HostToolValidationError);

    expect(handlerCalled).toBe(false);

    try {
      await runtime.callTool(localCtx, "note_writer", { title: "Only Title" });
    } catch (err) {
      expect(err).toBeInstanceOf(HostToolValidationError);
      const validationErr = err as HostToolValidationError;
      expect(validationErr.statusCode).toBe(400);
      expect(validationErr.code).toBe("SCHEMA_VALIDATION_FAILED");
      expect(validationErr.errors?.[0]).toMatchObject({
        path: "content",
        keyword: "required",
      });
    }
  });

  it("参数类型不匹配时抛出 HostToolValidationError", async () => {
    const registry = new InMemoryToolRegistry();
    const runtime = new HostToolRuntime({ registry });

    await registry.registerTool({
      id: "counter",
      name: "set_counter",
      description: "计数器",
      category: "utility",
      safetyLevel: "read_only",
      enabled: 1,
      inputSchema: {
        type: "object",
        properties: {
          count: { type: "integer" },
        },
        required: ["count"],
      },
    });

    const handler: HostToolHandler = {
      call: async () => ({ ok: true }),
    };
    runtime.registerHandler("counter", handler);

    await expect(
      runtime.callTool(localCtx, "counter", { count: "three" }),
    ).rejects.toThrow(HostToolValidationError);
  });
});

describe("Tool Budget Timeout (tool-pipeline & ToolSpec.budget)", () => {
  it.each(["static", "dynamic"] as const)("%s 工具清单使用声明预算而非较短的全局超时", async source => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "att_budget_spec", turnId: "turn_budget_spec" });

    const provider = {
      id: "fake",
      capabilities: { toolCalls: true, reasoning: false },
      async *stream(req: { step: number }) {
        if (req.step === 1) {
          yield {
            text: "",
            isFinal: true,
            toolCalls: [{ id: "call_slow_budget", name: "custom_slow_tool", arguments: {} }],
          };
        } else {
          yield { text: "工具完成", isFinal: true };
        }
      },
    };

    let executed = false;
    const specs = [
        {
          name: "custom_slow_tool",
          description: "声明了预算超时的工具",
          readOnly: true,
          budget: { timeoutMs: 300 },
        },
    ];
    const tools = {
      tools: source === "dynamic" ? [] : specs,
      listTools: source === "dynamic" ? async () => specs : undefined,
      async execute() {
        // 等待 150ms，超过全局 options.toolTimeoutMs 80ms，但在 300ms budget 内
        await new Promise((r) => setTimeout(r, 150));
        executed = true;
        return { ok: true, output: "slow success" };
      },
    };

    const result = await executeTurn(
      {
        execution: store,
        provider,
        contextBuilder: defaultContextBuilder,
        tools,
        options: {
          toolTimeoutMs: 80, // 全局设为 80ms，但工具声明自身 budget 为 300ms
        },
      },
      {
        turnId: "turn_budget_spec",
        attemptId: "att_budget_spec",
        sessionId: "sess_budget",
        userMessage: "测试动态超时",
      },
    );

    expect(result.status).toBe("completed");
    expect(executed).toBe(true);
    expect((await store.listEvents("turn_budget_spec")).find(event=>event.eventType==="tool_result")?.data)
      .toMatchObject({ok:true,output:"slow success"});
  });
  it("审批策略收到当前动态清单的 privileged 等级", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({id:"attempt",turnId:"turn"});
    let observed: string | undefined;
    let called = false;
    const result = await executeTurn({execution:store,contextBuilder:defaultContextBuilder,
      provider:{id:"one",async *stream(){yield {text:"",isFinal:true,toolCalls:[{id:"call",name:"privileged_tool",arguments:{}}]};}},
      tools:{tools:[],async listTools(){return [{name:"privileged_tool",description:"privileged",readOnly:false,safetyLevel:"privileged"}];},
        async execute(){called=true;return {ok:true};}},
      approvalPolicy:{async evaluate(request){observed=request.safetyLevel;return {action:"ask_user",approvalId:"approval",argumentsHash:"hash"};}},
    },{turnId:"turn",attemptId:"attempt",sessionId:"session",userMessage:"test"});
    expect(observed).toBe("privileged");expect(called).toBe(false);
    expect(result).toMatchObject({status:"interrupted",reason:"pending_approval"});
  });

});
