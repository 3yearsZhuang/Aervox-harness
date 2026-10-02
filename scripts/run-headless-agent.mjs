#!/usr/bin/env node
/**
 * Aervox Core headless 冒烟脚本（ADR-021 / ITER-035 验收证据）
 *
 * 在无 Fastify / 无 SQLite / 无 apps/api 的进程内验证 @aervox/core 独立性：
 * - 完整多 Step 工具回路（模型 → tool_call → tool_result → 最终输出）；
 * - ControlContext 预算与截止时间收敛（budget_exhausted / deadline_exceeded）；
 * - 审批路径（AutoApprovalPolicy 分级放行 + CliInteractiveApprovalPolicy 非 TTY fail-closed）；
 * - HostToolRuntime 内存版（注册 / 调用 / 代际指纹防护）。
 *
 * 用法：先构建 core（mise exec -- pnpm -F @aervox/core build），然后
 *   mise exec -- node scripts/run-headless-agent.mjs --smoke
 */

import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";

const startupStart = performance.now();

// 全部能力仅来自 @aervox/dist —— 不 import apps/api、@libsql/client、drizzle 等任何持久层
const {
  ControlContext,
  InMemoryExecutionStore,
  createMockToolProvider,
  executeTurn,
  defaultContextBuilder,
  AutoApprovalPolicy,
  withApprovalPolicy,
  CliInteractiveApprovalPolicy,
  HostToolRuntime,
} = await import("../packages/core/dist/index.js");

const startupElapsedMs = performance.now() - startupStart;

let failures = 0;
function check(label, condition, detail = "") {
  const mark = condition ? "PASS" : "FAIL";
  if (!condition) failures += 1;
  console.log(`      ${mark}${detail ? ` — ${detail}` : ""}`);
  if (!condition) console.error(`      ^^ ${label}`);
}

/** 智能模拟 Provider：第一步按意图发起工具调用，第二步总结工具结果 */
function createSmartProvider() {
  return {
    id: "headless-smoke-provider",
    async *stream(request) {
      const messages = request.context.messages || [];
      const last = messages[messages.length - 1]?.content || "";
      if (request.step > 1) {
        yield { text: `工具结果已注入：${last}`, isFinal: true };
        return;
      }
      if (/笔记|notes|复习/i.test(last)) {
        yield {
          text: "正在检索学习笔记…",
          isFinal: true,
          toolCalls: [{ id: `call_${Date.now().toString(36)}`, name: "search_notes", arguments: { query: last } }],
        };
      } else {
        yield { text: "你好，我是思隅独立内核（headless），无需任何服务与数据库即可运行。", isFinal: true };
      }
    },
  };
}

async function main() {
  console.log("==================================================================");
  console.log("  Aervox Core (@aervox/core) Headless 独立性冒烟验证");
  console.log("==================================================================");

  console.log(`[1/5] 内核模块加载（零运行时依赖）: ${startupElapsedMs.toFixed(2)} ms`);
  check("内核可加载", startupElapsedMs > 0);

  const store = new InMemoryExecutionStore();
  const calls = [];
  const baseTools = createMockToolProvider();
  const tools = {
    ...baseTools,
    execute: async (input) => {
      calls.push(input.name);
      return baseTools.execute(input);
    },
  };

  console.log("[2/5] 完整多 Step 工具回路（无 Fastify / 无 SQLite / 无 apps/api）...");
  store.seedAttempt({ id: "atp_smoke_tool", turnId: "turn_smoke_tool" });
  const controlTool = new ControlContext({
    turnId: "turn_smoke_tool",
    attemptId: "atp_smoke_tool",
    sessionId: "ses_smoke",
    deadlineEpochMs: Date.now() + 10_000,
    tokenBudget: { maxTokens: 100_000, usedTokens: 0 },
  });
  const resTool = await executeTurn(
    {
      execution: store,
      provider: createSmartProvider(),
      tools,
      contextBuilder: defaultContextBuilder,
      controlContext: controlTool,
    },
    {
      turnId: "turn_smoke_tool",
      attemptId: "atp_smoke_tool",
      userMessage: "帮我查一下复习笔记",
      controlContext: controlTool,
    },
  );
  controlTool.dispose();
  const events = await store.listEvents("turn_smoke_tool");
  check("Turn 完成", resTool.status === "completed", `status=${resTool.status}`);
  check("恰好两步（工具请求 + 最终输出）", resTool.stepsTaken === 2, `stepsTaken=${resTool.stepsTaken}`);
  check("工具执行一次", calls.join(",") === "search_notes", calls.join(","));
  check(
    "tool_result 事件落账",
    events.some((e) => e.eventType === "tool_result" && e.data?.ok && e.data?.name === "search_notes"),
  );
  check(
    "最终输出引用工具结果",
    events.some((e) => e.eventType === "delta" && typeof e.data?.text === "string" && e.data.text.includes("matches")),
  );

  console.log("[3/5] ControlContext 预算与截止时间收敛...");
  store.seedAttempt({ id: "atp_smoke_deadline", turnId: "turn_smoke_deadline" });
  const expiredControl = new ControlContext({
    turnId: "turn_smoke_deadline",
    attemptId: "atp_smoke_deadline",
    sessionId: "ses_smoke",
    deadlineEpochMs: Date.now() - 100,
  });
  const resDeadline = await executeTurn(
    {
      execution: store,
      provider: createSmartProvider(),
      tools,
      contextBuilder: defaultContextBuilder,
      controlContext: expiredControl,
    },
    {
      turnId: "turn_smoke_deadline",
      attemptId: "atp_smoke_deadline",
      userMessage: "超时测试",
      controlContext: expiredControl,
    },
  );
  expiredControl.dispose();
  check(
    "deadline 超时收敛 Interrupted",
    resDeadline.status === "failed" && resDeadline.reason === "deadline_exceeded",
    `status=${resDeadline.status}, reason=${resDeadline.reason}`,
  );

  store.seedAttempt({ id: "atp_smoke_budget", turnId: "turn_smoke_budget" });
  const starvedControl = new ControlContext({
    turnId: "turn_smoke_budget",
    attemptId: "atp_smoke_budget",
    sessionId: "ses_smoke",
    deadlineEpochMs: Date.now() + 10_000,
    tokenBudget: { maxTokens: 8, usedTokens: 0 },
  });
  const resBudget = await executeTurn(
    {
      execution: store,
      provider: createSmartProvider(),
      tools,
      contextBuilder: defaultContextBuilder,
      controlContext: starvedControl,
    },
    {
      turnId: "turn_smoke_budget",
      attemptId: "atp_smoke_budget",
      userMessage: "预算耗尽测试",
      controlContext: starvedControl,
    },
  );
  starvedControl.dispose();
  check(
    "token 预算耗尽收敛 budget_exhausted",
    resBudget.status === "failed" && resBudget.reason === "budget_exhausted",
    `status=${resBudget.status}, reason=${resBudget.reason}`,
  );

  console.log("[4/5] 审批路径（Approval SPI）...");
  const readOnlyPolicy = new AutoApprovalPolicy({ mode: "read_only" });
  const guarded = withApprovalPolicy(createMockToolProvider(), readOnlyPolicy);
  const allowed = await guarded.execute({
    name: "search_notes",
    arguments: { query: "x" },
    turnId: "t",
    attemptId: "a",
    invocationId: "inv_ok",
  });
  check("read_only 策略放行只读工具", allowed.ok === true);
  const denied = await guarded.execute({
    name: "save_memory_note",
    arguments: { content: "x" },
    turnId: "t",
    attemptId: "a",
    invocationId: "inv_deny",
  });
  check(
    "read_only 策略拦截写工具",
    denied.ok === false && denied.error?.includes("read_only"),
    denied.error ?? "",
  );

  const nonTty = new CliInteractiveApprovalPolicy({
    input: new PassThrough(),
    output: new PassThrough(),
  });
  const cliDecision = await nonTty.evaluate({
    turnId: "t",
    attemptId: "a",
    invocationId: "inv_cli",
    toolName: "save_memory_note",
    arguments: { content: "x" },
    safetyLevel: "write_with_approval",
  });
  check(
    "CLI 审批在非 TTY 环境 fail-closed",
    cliDecision.action === "deny",
    `action=${cliDecision.action}`,
  );

  console.log("[5/5] HostToolRuntime 内存版（注册 / 调用 / 代际防护）...");
  const runtime = new HostToolRuntime();
  const release = await runtime.registerContribution(
    { id: "echo", name: "echo", category: "system", description: "echo back", safetyLevel: "read_only" },
    { call: async (_ctx, args) => ({ echo: args }) },
  );
  const localCtx = { workspaceId: "local", subjectUserId: "local" };
  const echoed = await runtime.callTool(localCtx, "echo", { x: 42 });
  check("内存注册表工具调用", JSON.stringify(echoed) === JSON.stringify({ echo: { x: 42 } }), JSON.stringify(echoed));
  release();
  let expired = false;
  try {
    await runtime.callTool(localCtx, "echo", {});
  } catch {
    expired = true;
  }
  check("释放后代际防护拦截", expired);
  runtime.dispose();

  console.log("==================================================================");
  if (failures > 0) {
    console.error(`结果：${failures} 项失败 —— headless 冒烟未通过`);
    process.exit(1);
  }
  console.log("结果：全部通过 —— @aervox/core 独立内核冒烟验证 PASS");
}

main().catch((error) => {
  console.error("headless 冒烟异常退出：", error);
  process.exit(1);
});
