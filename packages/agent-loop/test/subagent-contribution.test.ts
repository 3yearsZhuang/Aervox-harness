/**
 * Aervox｜思隅 @aervox/agent-loop — 阶段 5c Subagent/Workflow Contribution 契约测试
 *
 * 覆盖 AVX-HAR-001 §13 阶段 5c + ADR-017「独立 Tool/Provider Contribution、不改核心」：
 * - composeToolProviders：多 provider 并集合并；重名组装期报错；execute 按名路由；未命中 fail-closed；
 * - createSubagentToolProvider：缺省无工具（退化安全）；暴露 `subagent.delegate`（写类）并委托 SubagentPort；
 *   执行失败/输入非法以既有 tool_result 失败语义返回；
 * - createWorkflowToolProvider：TS 步骤定义顺序执行、输出传递；步骤失败定位收敛；未注册 workflow fail-closed。
 */
import { describe, expect, it } from "vitest";
import {
  composeToolProviders,
  createSubagentToolProvider,
  createWorkflowToolProvider,
  SUBAGENT_DELEGATE_TOOL,
  WORKFLOW_RUN_TOOL,
} from "../src/index.js";
import type { SubagentPort, ToolExecutionInput, ToolProviderPort } from "../src/index.js";
import type { WorkflowDefinition } from "../src/types.js";

const simpleProvider = (name: string, ok = true): ToolProviderPort => ({
  tools: [{ name, description: `${name} tool`, readOnly: true }],
  async execute(input) {
    return { ok, output: `executed:${name}:${JSON.stringify(input.arguments)}` };
  },
});

const call = (name: string, args: unknown, extra?: Partial<ToolExecutionInput>): ToolExecutionInput => ({
  turnId: "turn_1",
  attemptId: "attempt_1",
  invocationId: "attempt_1:1:1",
  name,
  arguments: args,
  sessionId: "session_1",
  ...extra,
});

describe("5c composeToolProviders", () => {
  it("合并多 provider 工具清单并集，execute 按名路由到声明方", async () => {
    const a = simpleProvider("notes_search");
    const b = simpleProvider("review_plan");
    const composed = composeToolProviders([a, b]);

    expect(composed.tools.map((t) => t.name)).toEqual(["notes_search", "review_plan"]);
    await expect(composed.execute(call("notes_search", { q: "x" }))).resolves.toEqual({
      ok: true,
      output: 'executed:notes_search:{"q":"x"}',
    });
    await expect(composed.execute(call("review_plan", {}))).resolves.toEqual({
      ok: true,
      output: "executed:review_plan:{}",
    });
  });

  it("重名工具跨 provider 冲突在组装期抛错（杜绝执行期歧义路由）", () => {
    expect(() => composeToolProviders([simpleProvider("dup"), simpleProvider("dup")])).toThrow(/duplicate tool name "dup"/);
  });

  it("未注册工具 fail-closed（unregistered_tool）", async () => {
    const composed = composeToolProviders([simpleProvider("known")]);
    await expect(composed.execute(call("ghost", {}))).resolves.toEqual({ ok: false, error: "unregistered_tool: ghost" });
  });

  it("fallback 兜底：静态清单未命中时委托 fallback（支持动态注册表 provider）", async () => {
    // 模拟 apps/api createRuntimeToolProvider：tools 为空（动态注册表），execute 实时校验并自判
    const dynamicProvider: ToolProviderPort = {
      tools: [],
      async execute(input) {
        if (input.name === "dynamic_tool") return { ok: true, output: "dynamic:ok" };
        return { ok: false, error: `unregistered_tool: ${input.name}` };
      },
    };
    const composed = composeToolProviders([simpleProvider("static_tool")], { fallback: dynamicProvider });
    // 静态命中走声明方；动态名走 fallback；两者皆未命中 → fallback 自判 fail-closed
    await expect(composed.execute(call("static_tool", {}))).resolves.toEqual({
      ok: true,
      output: "executed:static_tool:{}",
    });
    await expect(composed.execute(call("dynamic_tool", {}))).resolves.toEqual({ ok: true, output: "dynamic:ok" });
    await expect(composed.execute(call("ghost", {}))).resolves.toEqual({ ok: false, error: "unregistered_tool: ghost" });
  });
});

describe("5c createSubagentToolProvider", () => {
  it("未注入 SubagentPort 时不贡献工具（行为与既有一致）", () => {
    expect(createSubagentToolProvider().tools).toEqual([]);
  });

  it("注入后暴露 subagent.delegate（写类 readOnly=false），委托成功透传子任务结果", async () => {
    const calls: Array<{ task: string; executionId: string }> = [];
    const subagent: SubagentPort = {
      async delegate(input) {
        calls.push({ task: input.task, executionId: input.parentExecutionId });
        return { subTurnId: "turn_sub", subAttemptId: "attempt_sub", status: "Completed", resultText: "子任务已完成" };
      },
    };
    const provider = createSubagentToolProvider({ subagent });

    expect(provider.tools).toEqual([
      expect.objectContaining({ name: SUBAGENT_DELEGATE_TOOL, readOnly: false }),
    ]);
    await expect(provider.execute(call(SUBAGENT_DELEGATE_TOOL, { task: "帮我写摘要" }, { invocationId: "attempt_1:2:3" }))).resolves.toEqual({
      ok: true,
      output: { subTurnId: "turn_sub", subAttemptId: "attempt_sub", status: "Completed", resultText: "子任务已完成" },
    });
    expect(calls).toEqual([{ task: "帮我写摘要", executionId: "attempt_1:2:3" }]);
  });

  it("子任务非完成态 → ok:false 并携带 error（父级按既有工具失败语义收敛/重试）", async () => {
    const subagent: SubagentPort = {
      async delegate() {
        return { subTurnId: "t", subAttemptId: "a", status: "Interrupted", error: "subagent_max_steps" };
      },
    };
    await expect(createSubagentToolProvider({ subagent }).execute(call(SUBAGENT_DELEGATE_TOOL, { task: "x" }))).resolves.toEqual({
      ok: false,
      output: { subTurnId: "t", subAttemptId: "a", status: "Interrupted", error: "subagent_max_steps" },
      error: "subagent_max_steps",
    });
  });

  it("委托抛错收敛为工具失败；task 缺失拒绝", async () => {
    const subagent: SubagentPort = {
      async delegate() {
        throw new Error("subagent_broken");
      },
    };
    await expect(createSubagentToolProvider({ subagent }).execute(call(SUBAGENT_DELEGATE_TOOL, { task: "x" }))).resolves.toEqual({
      ok: false,
      error: "subagent_broken",
    });
    await expect(
      createSubagentToolProvider({ subagent }).execute(call(SUBAGENT_DELEGATE_TOOL, {})),
    ).resolves.toEqual({ ok: false, error: `${SUBAGENT_DELEGATE_TOOL} requires string field \`task\`` });
  });
});

describe("5c createWorkflowToolProvider", () => {
  const defs: WorkflowDefinition[] = [
    {
      name: "chain",
      description: "两步串联（上一步输出为下一步输入）",
      steps: [
        { description: "翻倍", execute: async (_ctx, input) => ({ ok: true, output: (input as number) * 2 }) },
        { description: "加一", execute: async (_ctx, input) => ({ ok: true, output: (input as number) + 1 }) },
      ],
    },
    {
      name: "flaky",
      description: "第二步必定失败",
      steps: [
        { description: "稳的一步", execute: async () => ({ ok: true, output: "ok" }) },
        { description: "炸的一步", execute: async () => ({ ok: false, error: "step_boom" }) },
      ],
    },
  ];

  it("无定义时不贡献工具（退化安全）", () => {
    expect(createWorkflowToolProvider([]).tools).toEqual([]);
  });

  it("贡献 workflow.run（写类）并顺序执行、步骤输出传递", async () => {
    const provider = createWorkflowToolProvider(defs);
    expect(provider.tools).toEqual([expect.objectContaining({ name: WORKFLOW_RUN_TOOL, readOnly: false })]);
    await expect(provider.execute(call(WORKFLOW_RUN_TOOL, { name: "chain", input: 3 }))).resolves.toEqual({
      ok: true,
      output: { steps: [6, 7] },
    });
  });

  it("步骤失败收敛：携带步骤定位与部分产物（父级可重试）", async () => {
    const provider = createWorkflowToolProvider(defs);
    await expect(provider.execute(call(WORKFLOW_RUN_TOOL, { name: "flaky", input: null }))).resolves.toEqual({
      ok: false,
      error: expect.stringContaining('workflow "flaky" step 2 (炸的一步) failed: step_boom'),
      output: { failedStep: 2, partial: ["ok"] },
    });
  });

  it("未注册 workflow fail-closed（unregistered_workflow）", async () => {
    const provider = createWorkflowToolProvider(defs);
    await expect(provider.execute(call(WORKFLOW_RUN_TOOL, { name: "ghost", input: null }))).resolves.toEqual({
      ok: false,
      error: "unregistered_workflow: ghost",
    });
  });

  it("步骤抛错收敛为工具失败", async () => {
    const throwing: WorkflowDefinition = {
      name: "thrower",
      description: "抛错",
      steps: [{ description: "抛", execute: async () => Promise.reject(new Error("boom")) }],
    };
    await expect(createWorkflowToolProvider([throwing]).execute(call(WORKFLOW_RUN_TOOL, { name: "thrower", input: null }))).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining('workflow "thrower" step 1 (抛) threw: boom'),
      }),
    );
  });
});