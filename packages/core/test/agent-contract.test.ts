import { describe, expect, it, vi } from "vitest";
import {
  runAgentTurn,
  type AgentDefinition,
  InMemoryExecutionStore,
} from "../src/index.js";

describe("Lightweight Agent Definition & Result Interface (runAgentTurn)", () => {
  it("声明式 Agent 完成多步执行并产出高层结构化结果", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "att_agent_1", turnId: "turn_agent_1" });

    const agent: AgentDefinition = {
      id: "agent_study_companion",
      name: "学伴思隅",
      persona: {
        name: "思隅",
        systemPrompt: "你是一个耐心的伴学助手。",
      },
      skills: [{ name: "math_review", description: "数学复习指导" }],
      tools: [
        {
          name: "calculate",
          description: "计算公式",
          readOnly: true,
        },
      ],
      options: {
        maxSteps: 4,
      },
    };

    const provider = {
      id: "mock_llm",
      capabilities: { toolCalls: true, reasoning: false },
      async *stream(req: { step: number }) {
        if (req.step === 1) {
          yield {
            text: "我来为你计算：",
            isFinal: true,
            toolCalls: [{ id: "call_calc_1", name: "calculate", arguments: { expr: "2 + 3" } }],
          };
        } else {
          yield {
            text: "结果是 5。",
            isFinal: true,
          };
        }
      },
    };

    const tools = {
      tools: agent.tools!,
      async execute() {
        return { ok: true, output: 5 };
      },
    };

    const result = await runAgentTurn(
      agent,
      {
        execution: store,
        provider,
        tools,
      },
      {
        turnId: "turn_agent_1",
        sessionId: "sess_agent_1",
        attemptId: "att_agent_1",
        userMessage: "帮我算一下 2 + 3",
      },
    );

    expect(result.status).toBe("completed");
    expect(result.output.text).toBe("我来为你计算：结果是 5。");
    expect(result.toolsExecuted).toHaveLength(1);
    expect(result.toolsExecuted[0]).toMatchObject({
      name: "calculate",
      ok: true,
      output: 5,
    });
    expect(result.diagnostics.stepsTaken).toBe(2);
    expect(result.interruption).toBeUndefined();
    expect(result.diagnostics.manifest?.modelSteps).toHaveLength(2);
    expect(result.diagnostics.manifest?.toolExecutions).toMatchObject([{ toolName: "calculate", status: "executed" }]);
  });

  it("当需要写审批时，返回结构化 interruption 详细信息", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "att_agent_2", turnId: "turn_agent_2" });

    const agent: AgentDefinition = {
      id: "agent_writer",
      name: "记录员",
      persona: {
        name: "思隅",
        systemPrompt: "日记记录员",
      },
      tools: [
        {
          name: "write_db",
          description: "写入数据库",
          readOnly: false,
        },
      ],
    };

    const provider = {
      id: "mock_llm",
      capabilities: { toolCalls: true, reasoning: false },
      async *stream() {
        yield {
          text: "",
          isFinal: true,
          toolCalls: [{ id: "call_write_1", name: "write_db", arguments: { data: "test" } }],
        };
      },
    };

    const tools = {
      tools: agent.tools!,
      async execute() {
        return {
          ok: false,
          needsApproval: {
            approvalId: "appr_123",
            toolName: "write_db",
            argumentsHash: "hash_xyz",
          },
        };
      },
    };

    const result = await runAgentTurn(
      agent,
      {
        execution: store,
        provider,
        tools,
      },
      {
        turnId: "turn_agent_2",
        sessionId: "sess_agent_2",
        attemptId: "att_agent_2",
        userMessage: "写入数据",
      },
    );

    expect(result.status).toBe("interrupted");
    expect(result.interruption).toBeDefined();
    expect(result.interruption).toMatchObject({
      type: "approval_required",
      approvalId: "appr_123",
      toolName: "write_db",
      argumentsHash: "hash_xyz",
    });
  });
  it("an empty Agent allowlist blocks extra tools exposed by its provider", async () => {
    const execution = new InMemoryExecutionStore();
    execution.seedAttempt({ id: "a", turnId: "t" });
    const execute = vi.fn(async () => ({ ok: true }));
    const result = await runAgentTurn({ id: "agent", name: "agent", persona: { name: "agent", systemPrompt: "help" }, tools: [] }, {
      execution,
      provider: { id: "test", async *stream(request) {
        expect(request.tools ?? []).toEqual([]);
        yield { text: "", isFinal: true, toolCalls: [{ id: "call", name: "extra", arguments: {} }] };
      } },
      tools: { tools: [{ name: "extra", description: "extra", readOnly: true }], execute },
    }, { turnId: "t", sessionId: "s", attemptId: "a", userMessage: "help" });
    expect(execute).not.toHaveBeenCalled();
    expect(result.diagnostics.manifest?.configuration.tools?.active).toEqual([]);
  });

});
