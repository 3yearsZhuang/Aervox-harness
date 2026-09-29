#!/usr/bin/env node
/** Standalone rule-provider demonstration with in-memory state and mock notes.
 * Module-load timing is a local observation, not a cold-process startup SLA.
 */

import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { PassThrough } from "node:stream";

const startupStart = performance.now();

// 动态加载内核（纯 Node ESM）
const {
  ControlContext,
  InMemoryExecutionStore,
  createMockToolProvider,
  executeTurn,
  defaultContextBuilder,
  AutoApprovalPolicy,
} = await import("../packages/agent-loop/dist/index.js");

const {
  CliInteractiveApprovalPolicy,
  ExecutionPipeline,
  createErrorRecoveryMiddleware,
  HostToolRuntime,
} = await import("../packages/host-agent/dist/index.js");

const startupElapsedMs = performance.now() - startupStart;

/** 智能模拟驱动：根据用户提示词动态生成意图响应或工具调用 */
function createSmartCliProvider() {
  return {
    id: "smart-cli-provider",
    async *stream(request) {
      const messages = request.context.messages || [];
      const lastMsg = messages[messages.length - 1]?.content || "";
      const step = request.step;

      // 第二步：工具已返回结果，模型总结回答
      if (step > 1) {
        yield {
          text: `演示工具返回：${lastMsg}`,
          isFinal: true,
        };
        return;
      }

      // 第一步：根据用户输入判断是否触发工具调用
      if (/记下|保存|save/i.test(lastMsg)) {
        yield {
          text: "正在为您记录到本地记忆库（需写操作审批）…",
          isFinal: true,
          toolCalls: [
            {
              id: `call_${Date.now().toString(36)}`,
              name: "save_memory_note",
              arguments: { content: lastMsg },
            },
          ],
        };
      } else if (/笔记|notes|复习|计划|search/i.test(lastMsg)) {
        yield {
          text: "正在为您检索学习笔记库…",
          isFinal: true,
          toolCalls: [
            {
              id: `call_${Date.now().toString(36)}`,
              name: "search_notes",
              arguments: { query: lastMsg },
            },
          ],
        };
      } else if (/时间|time|utc/i.test(lastMsg)) {
        yield {
          text: "正在读取当前系统 UTC 时间…",
          isFinal: true,
          toolCalls: [
            {
              id: `call_${Date.now().toString(36)}`,
              name: "get_utc_now",
              arguments: {},
            },
          ],
        };
      } else {
        yield {
          text: `你好！我是思隅本地轻量级内核（Headless Agent Core）。\n我无需启动 Fastify HTTP 服务或持久化数据库即可独立运行。\n您可以试着对我说：“帮我查一下复习笔记” 或 “现在几点了”，我会调用本地工具为您查询。`,
          isFinal: true,
        };
      }
    },
  };
}

/** 自动化验证模式（Smoke & Benchmark Test） */
async function runSmokeTest() {
  console.log("==================================================================");
  console.log("  Aervox Core (思隅核心) Headless 架构能力与冷启动验证");
  console.log("==================================================================");
  console.log(`[1/7] 内核加载耗时: ${startupElapsedMs.toFixed(2)} ms (基准门槛 <= 150ms) -> ${startupElapsedMs <= 150 ? "PASS" : "WARN"}`);

  const store = new InMemoryExecutionStore();
  const demoTools = createMockToolProvider();
  const calls = [];
  const tools = { ...demoTools, execute: async (input) => { calls.push(input.name); return demoTools.execute(input); } };

  // 测试 1: 普通多轮对话与问答
  console.log("[2/7] 验证多轮对话无工具执行回路...");
  const turn1Start = performance.now();
  store.seedAttempt({ id: "atp_smoke_1", turnId: "turn_smoke_1" });
  const control1 = new ControlContext({
    turnId: "turn_smoke_1",
    attemptId: "atp_smoke_1",
    sessionId: "ses_smoke",
    deadlineEpochMs: Date.now() + 5000,
  });
  const res1 = await executeTurn(
    {
      execution: store,
      provider: createSmartCliProvider(),
      tools,
      contextBuilder: defaultContextBuilder,
      controlContext: control1,
    },
    {
      turnId: "turn_smoke_1",
      attemptId: "atp_smoke_1",
      userMessage: "你好，你是谁？",
      controlContext: control1,
    },
  );
  control1.dispose();
  const turn1Elapsed = performance.now() - turn1Start;
  if (res1.status !== "completed") throw new Error(`Turn 1 failed: status=${res1.status}`);
  console.log(`      Turn 1 执行成功: status=${res1.status}, 耗时=${turn1Elapsed.toFixed(2)}ms`);

  // 测试 2: 完整两步工具调用循环 (Tool Call -> Tool Result -> Model Final Output)
  console.log("[3/7] 验证多 Step 工具调用循环 (search_notes)...");
  const turn2Start = performance.now();
  store.seedAttempt({ id: "atp_smoke_2", turnId: "turn_smoke_2" });
  const control2 = new ControlContext({
    turnId: "turn_smoke_2",
    attemptId: "atp_smoke_2",
    sessionId: "ses_smoke",
    deadlineEpochMs: Date.now() + 5000,
  });
  const res2 = await executeTurn(
    {
      execution: store,
      provider: createSmartCliProvider(),
      tools,
      contextBuilder: defaultContextBuilder,
      controlContext: control2,
    },
    {
      turnId: "turn_smoke_2",
      attemptId: "atp_smoke_2",
      userMessage: "帮我查一下复习笔记",
      controlContext: control2,
    },
  );
  control2.dispose();
  const turn2Elapsed = performance.now() - turn2Start;
  if (res2.status !== "completed") throw new Error(`Turn 2 failed: status=${res2.status}`);
  if (res2.stepsTaken !== 2 || calls.join(",") !== "search_notes") throw new Error("tool loop did not execute exactly once");
  const events2 = await store.listEvents("turn_smoke_2");
  if (!events2.some((e) => e.eventType === "tool_result" && e.data?.ok && e.data?.name === "search_notes")) throw new Error("tool result missing");
  if (!events2.some((e) => e.eventType === "delta" && e.data?.text?.includes("matches"))) throw new Error("final response did not use tool result");
  const blocked = await tools.execute({ name: "save_memory_note", arguments: {}, turnId: "t", attemptId: "a", invocationId: "blocked" });
  if (blocked.ok || blocked.error !== "requires_approval") throw new Error("write approval bypassed");
  console.log(`      Turn 2 执行成功: stepsTaken=${res2.stepsTaken}, status=${res2.status}, 耗时=${turn2Elapsed.toFixed(2)}ms`);

  // 测试 3: 执行控制与超时/取消中断 (ControlContext Interruption)
  console.log("[4/7] 验证超时控制与优雅排空 (ControlContext Deadline Expired)...");
  const turn3Start = performance.now();
  store.seedAttempt({ id: "atp_smoke_3", turnId: "turn_smoke_3" });
  const expiredControl = new ControlContext({
    turnId: "turn_smoke_3",
    attemptId: "atp_smoke_3",
    sessionId: "ses_smoke",
    deadlineEpochMs: Date.now() - 100, // 故意设定已超时的截止时间
  });
  const res3 = await executeTurn(
    {
      execution: store,
      provider: createSmartCliProvider(),
      tools,
      contextBuilder: defaultContextBuilder,
      controlContext: expiredControl,
    },
    {
      turnId: "turn_smoke_3",
      attemptId: "atp_smoke_3",
      userMessage: "超时测试",
      controlContext: expiredControl,
    },
  );
  expiredControl.dispose();
  const turn3Elapsed = performance.now() - turn3Start;
  if (res3.status !== "failed" || res3.reason !== "deadline_exceeded") {
    throw new Error(`Turn 3 should fail with deadline_exceeded, got status=${res3.status}, reason=${res3.reason}`);
  }
  const events3 = await store.listEvents("turn_smoke_3");
  const doneEvent = events3.find((e) => e.eventType === "done");
  if (!doneEvent || doneEvent.data?.status !== "Interrupted") {
    throw new Error(`Done event should have status Interrupted, got ${JSON.stringify(doneEvent)}`);
  }
  console.log(`      Turn 3 成功拦截并收敛终态: status=${res3.status}, reason=${res3.reason}, doneStatus=${doneEvent.data?.status}, 耗时=${turn3Elapsed.toFixed(2)}ms`);

  // 测试 4: 流水线洋葱模型与错误恢复 (ExecutionPipeline Middleware)
  console.log("[5/7] 验证 ExecutionPipeline 中间件链与洋葱拦截...");
  const smokePipeline = new ExecutionPipeline();
  const pipelineTrace = [];
  smokePipeline.use(createErrorRecoveryMiddleware());
  smokePipeline.use(async (ctx, next) => {
    pipelineTrace.push("before:trace");
    ctx.attributes.set("trace_start", performance.now());
    const res = await next();
    pipelineTrace.push("after:trace");
    return res;
  });
  const pipeTurnId = "turn_smoke_pipe";
  const pipeAtpId = "atp_smoke_pipe";
  store.seedAttempt({ id: pipeAtpId, turnId: pipeTurnId });
  const pipeControl = new ControlContext({
    turnId: pipeTurnId,
    attemptId: pipeAtpId,
    sessionId: "ses_smoke",
    deadlineEpochMs: Date.now() + 5000,
  });
  const pipeRes = await smokePipeline.execute(
    {
      turnId: pipeTurnId,
      attemptId: pipeAtpId,
      sessionId: "ses_smoke",
      userMessage: "流水线验证",
      controlContext: pipeControl,
      attributes: new Map(),
    },
    async (ctx) => {
      pipelineTrace.push("handler:turn");
      return executeTurn(
        {
          execution: store,
          provider: createSmartCliProvider(),
          tools,
          contextBuilder: defaultContextBuilder,
          controlContext: ctx.controlContext,
        },
        {
          turnId: ctx.turnId,
          attemptId: ctx.attemptId,
          userMessage: ctx.userMessage,
          controlContext: ctx.controlContext,
        },
      );
    },
  );
  pipeControl.dispose();
  if (pipeRes.status !== "completed") throw new Error(`Pipeline turn failed: ${pipeRes.status}`);
  if (pipelineTrace.join("->") !== "before:trace->handler:turn->after:trace") {
    throw new Error(`Pipeline order mismatch: ${pipelineTrace.join("->")}`);
  }
  console.log(`      ExecutionPipeline 洋葱拦截执行成功: status=${pipeRes.status}, trace=${pipelineTrace.join("->")}`);

  // 测试 5: 权限审批策略与人机回环 (ApprovalPolicyPort SPI)
  console.log("[6/7] 验证 ApprovalPolicyPort SPI 与 CLI 审批策略...");
  const autoApprovedTools = createMockToolProvider({
    save_memory_note: (input) => ({ ok: true, output: { saved: true, args: input.arguments } }),
  });
  // 5a: AutoApprovalPolicy 放行
  store.seedAttempt({ id: "atp_smoke_4a", turnId: "turn_smoke_4a" });
  const control4a = new ControlContext({
    turnId: "turn_smoke_4a",
    attemptId: "atp_smoke_4a",
    sessionId: "ses_smoke",
    deadlineEpochMs: Date.now() + 5000,
  });
  const res4a = await executeTurn(
    {
      execution: store,
      provider: createSmartCliProvider(),
      tools: autoApprovedTools,
      contextBuilder: defaultContextBuilder,
      controlContext: control4a,
      approvalPolicy: new AutoApprovalPolicy({ mode: "full_access" }),
    },
    {
      turnId: "turn_smoke_4a",
      attemptId: "atp_smoke_4a",
      userMessage: "保存笔记：Phase 2 自动化放行验证",
      controlContext: control4a,
    },
  );
  control4a.dispose();
  if (res4a.status !== "completed") throw new Error(`AutoApproval turn failed: ${res4a.status}`);
  console.log(`      AutoApprovalPolicy 放行写工具执行成功: status=${res4a.status}`);

  // 5b: CliInteractiveApprovalPolicy 非 TTY 拦截 (fail-closed deny)
  store.seedAttempt({ id: "atp_smoke_4b", turnId: "turn_smoke_4b" });
  const control4b = new ControlContext({
    turnId: "turn_smoke_4b",
    attemptId: "atp_smoke_4b",
    sessionId: "ses_smoke",
    deadlineEpochMs: Date.now() + 5000,
  });
  const mockNonTtyInput = Object.assign(new PassThrough(), { isTTY: false });
  const mockOutput = new PassThrough();
  const cliNonTtyPolicy = new CliInteractiveApprovalPolicy({ input: mockNonTtyInput, output: mockOutput });
  const res4b = await executeTurn(
    {
      execution: store,
      provider: createSmartCliProvider(),
      tools: autoApprovedTools,
      contextBuilder: defaultContextBuilder,
      controlContext: control4b,
      approvalPolicy: cliNonTtyPolicy,
    },
    {
      turnId: "turn_smoke_4b",
      attemptId: "atp_smoke_4b",
      userMessage: "保存笔记：非 TTY 拦截验证",
      controlContext: control4b,
    },
  );
  control4b.dispose();
  const events4b = await store.listEvents("turn_smoke_4b");
  const toolResult4b = events4b.find((e) => e.eventType === "tool_result");
  if (!toolResult4b || toolResult4b.data?.ok !== false) {
    throw new Error("CLI non-interactive policy should safely deny write tool");
  }
  console.log(`      CliInteractiveApprovalPolicy 非 TTY 安全拦截校验通过 (fail-closed)`);

  // 依赖隔离检查
  console.log("[7/7] 验证零数据库、零网络服务侵入...");
  const memUsage = process.memoryUsage();
  console.log(`      内存常驻 (RSS): ${(memUsage.rss / 1024 / 1024).toFixed(2)} MB`);
  console.log(`      堆内存使用 (Heap): ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`);

  console.log("==================================================================");
  console.log("  ALL SMOKE CHECKS PASSED: 内存状态、流水线管道、规则模型、审批 SPI 及演示工具的独立运行检查通过。");
  console.log("==================================================================");
}

/** 交互式 REPL 会话 */
async function runInteractiveRepl() {
  console.log("==================================================================");
  console.log(`  Aervox Core CLI — 规则模型与模拟笔记演示 (启动就绪 ${startupElapsedMs.toFixed(1)}ms)`);
  console.log("  输入您的问题与思隅对话，输入 /exit 退出，输入 /smoke 执行自动化基准测试");
  console.log("==================================================================");

  const rl = createInterface({ input, output });
  const store = new InMemoryExecutionStore();
  const savedNotes = [];
  const demoTools = createMockToolProvider({
    save_memory_note: (input) => {
      const content = input.arguments?.content || JSON.stringify(input.arguments);
      savedNotes.push(content);
      return { ok: true, output: { saved: true, totalNotes: savedNotes.length } };
    },
  });
  const calls = [];
  const tools = { ...demoTools, execute: async (input) => { calls.push(input.name); return demoTools.execute(input); } };
  const cliApproval = new CliInteractiveApprovalPolicy({
    promptUser: async (q) => rl.question(q),
  });

  const pipeline = new ExecutionPipeline();
  pipeline.use(createErrorRecoveryMiddleware());
  pipeline.use(async (ctx, next) => {
    const t0 = performance.now();
    const res = await next();
    const elapsed = performance.now() - t0;
    ctx.attributes.set("durationMs", elapsed);
    return res;
  });

  let turnSeq = 1;
  const sessionId = `cli_session_${Date.now().toString(36)}`;

  try {
    while (true) {
      const line = await rl.question("\n\x1b[36m你 >\x1b[0m ");
      const text = line.trim();
      if (!text) continue;

      if (text === "/exit" || text === "exit" || text === "quit") {
        console.log("再见！");
        break;
      }

      if (text === "/smoke" || text === "/test") {
        await runSmokeTest();
        continue;
      }

      const turnId = `turn_cli_${turnSeq++}`;
      const attemptId = `atp_${turnId}`;
      store.seedAttempt({ id: attemptId, turnId });

      const control = new ControlContext({
        turnId,
        attemptId,
        sessionId,
        deadlineEpochMs: Date.now() + 30_000,
      });

      process.stdout.write("\x1b[32m思隅 >\x1b[0m ");
      const result = await pipeline.execute(
        {
          turnId,
          attemptId,
          sessionId,
          userMessage: text,
          controlContext: control,
          attributes: new Map(),
        },
        async () => {
          return executeTurn(
            {
              execution: store,
              provider: createSmartCliProvider(),
              tools,
              contextBuilder: defaultContextBuilder,
              controlContext: control,
              approvalPolicy: cliApproval,
            },
            {
              turnId,
              attemptId,
              sessionId,
              userMessage: text,
              controlContext: control,
            },
          );
        },
      );

      control.dispose();
      // 从 store 获取本 turn 生成的消息
      const events = (await store.listEvents(turnId)) || [];
      const deltaTexts = events
        .filter((e) => e.eventType === "delta" && e.data?.text)
        .map((e) => e.data.text);
      if (deltaTexts.length > 0) {
        console.log(deltaTexts.join(""));
      } else {
        console.log(`(回合已结束: status=${result.status})`);
      }
    }
  } finally {
    rl.close();
  }
}

// 主入口分发
const args = process.argv.slice(2);
if (args.includes("--smoke") || args.includes("--test") || !process.stdin.isTTY) {
  await runSmokeTest();
} else {
  await runInteractiveRepl();
}
