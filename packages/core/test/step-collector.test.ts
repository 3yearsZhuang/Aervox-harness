/**
 * Aervox｜思隅 @aervox/core — Step 流式收集器测试（ITER-041 第四段）
 *
 * `StepCollector` 抽出前，`collectStep` 是一个 90 行闭包，5 个可变状态
 * （midStreamStop / reasoningBuffer / reasoningEmitted / charged / lastMidStreamCheck）
 * 跨 collectStep、retry 路径与 flushReasoning 三个闭包共享。状态跨闭包共享是这类代码
 * 最易出错的形态 —— 症状是「重试后 reasoning 重复落事件」或「预算已收敛却继续计费」，
 * 且都只能靠端到端用例偶然撞见。
 *
 * 本文件锁定：
 * - 计量口径（输入摊销 / 工具 schema 全量 / 输出保守计量 / usage 只增不减）；
 * - 预算守卫在输入超限与流中超限两处均收敛；
 * - 心跳丢失即中止（throwIfLost 抛LeaseLostError，不被吞掉）；
 * - 思考增量节流阈值（200 字符 / 400ms）与 force flush；
 * - 守卫命中时 stop 非空且分块已收集到该点。
 */
import { describe, expect, it } from "vitest";
import { StepCollector, createControlContext } from "../src/index.js";
import type { ModelChunk, ModelProviderPort, PromptContext } from "../src/index.js";

const ctxOf = (messages: PromptContext["messages"] = [{ role: "user", content: "hi" }]): PromptContext => ({
  turnId: "turn_1",
  sessionId: "sess_1",
  messages,
});

const providerOf = (chunks: ModelChunk[], onStream?: () => void): ModelProviderPort => ({
  id: "p",
  async *stream() {
    onStream?.();
    for (const chunk of chunks) yield chunk;
  },
});

const baseOpts = (over: Partial<ConstructorParameters<typeof StepCollector>[0]> = {}) => ({
  provider: providerOf([{ text: "你好", isFinal: true }]),
  context: ctxOf(),
  turnId: "turn_1",
  attemptId: "atp_1",
  step: 1,
  messageId: "msg_1",
  prematureTermination: async () => null,
  finalizeInterrupted: async (reason: string) => ({ status: "failed" as const, attemptId: "atp_1", reason }),
  appendReasoningDelta: async () => {},
  ...over,
});

describe("Step 流式收集器（StepCollector）", () => {
  it("正常路径：收集全部分块且无终止", async () => {
    const collector = new StepCollector(baseOpts());
    const result = await collector.collect();
    expect(result.chunks).toHaveLength(1);
    expect(result.stop).toBeNull();
    expect(result.reasoningEmitted).toBe(false);
  });

  it("Step 守卫命中 → stop 非空且不发起模型调用", async () => {
    let called = false;
    const collector = new StepCollector(
      baseOpts({
        provider: providerOf([{ text: "x", isFinal: true }], () => {
          called = true;
        }),
        prematureTermination: async () => ({ status: "cancelled" as const, attemptId: "atp_1", lastSequence: 1, stepsTaken: 0 }),
      }),
    );
    const result = await collector.collect();
    expect(result.stop?.status).toBe("cancelled");
    expect(called).toBe(false);
  });

  it("输入计量超预算 → budget_exhausted 且不调用模型", async () => {
    let called = false;
    const control = createControlContext({ tokenBudget: { maxTokens: 1, usedTokens: 0 } });
    const collector = new StepCollector(
      baseOpts({
        control,
        provider: providerOf([{ text: "x", isFinal: true }], () => {
          called = true;
        }),
      }),
    );
    const result = await collector.collect();
    expect(result.stop?.reason).toBe("budget_exhausted");
    expect(called).toBe(false);
  });

  it("输出计量超预算 → token_budget_exceeded（流中收敛）", async () => {
    const control = createControlContext({ tokenBudget: { maxTokens: 200, usedTokens: 0 } });
    const collector = new StepCollector(
      baseOpts({
        control,
        provider: providerOf([
          { text: "a".repeat(150), isFinal: false },
          { text: "b".repeat(150), isFinal: false },
          { text: "c".repeat(150), isFinal: true },
        ]),
      }),
    );
    const result = await collector.collect();
    expect(result.stop?.reason).toBe("token_budget_exceeded");
  });

  it("provider 累计 usage 只向上补计，不因较小后续报数退款", async () => {
    const control = createControlContext({ tokenBudget: { maxTokens: 100_000, usedTokens: 0 } });
    const collector = new StepCollector(
      baseOpts({
        control,
        provider: providerOf([
          { text: "", isFinal: false, usage: { totalTokens: 500 } },
          { text: "", isFinal: true, usage: { totalTokens: 300 } },
        ]),
      }),
    );
    await collector.collect();
    // 500 已达峰，后续报 300 不得退款
    expect(control.tokenBudget?.usedTokens).toBe(500);
  });

  it("思考增量达阈值即落 reasoning_delta 进度事件", async () => {
    const deltas: string[] = [];
    const collector = new StepCollector(
      baseOpts({
        appendReasoningDelta: async (text: string) => {
          deltas.push(text);
        },
        provider: providerOf([
          { text: "", isFinal: false, reasoning: "思".repeat(250) },
          { text: "done", isFinal: true },
        ]),
      }),
    );
    const result = await collector.collect();
    expect(deltas.length).toBeGreaterThan(0);
    expect(result.reasoningEmitted).toBe(true);
  });

  it("思考增量节流：force 前先 flush 一次（初值 0 使首次即落），force 后落剩余", async () => {
    const deltas: string[] = [];
    const collector = new StepCollector(
      baseOpts({
        appendReasoningDelta: async (text: string) => {
          deltas.push(text);
        },
        provider: providerOf([{ text: "done", isFinal: true, reasoning: "短" }]),
      }),
    );
    await collector.collect();
    //节流判据为「字符数 < 200 且距上次 flush < 400ms 则跳过」；
    // 上次 flush 时间戳初值 0，故首次总是落事件 —— 这是既有行为，锁定之。
    expect(deltas).toHaveLength(1);
    // 此时缓冲已清空，force flush 无内容可落（幂等，不产生空事件）
    await collector.flushPendingReasoning();
    expect(deltas).toHaveLength(1);
  });

  it("思考增量不足阈值且时间戳已推进 → 节流跳过（不落事件）", async () => {
    const deltas: string[] = [];
    const collector = new StepCollector(
      baseOpts({
        appendReasoningDelta: async (text: string) => {
          deltas.push(text);
        },
        provider: providerOf([
          { text: "", isFinal: false, reasoning: "甲".repeat(250) },
          { text: "done", isFinal: true, reasoning: "乙" },
        ]),
      }),
    );
    await collector.collect();
    // 第二块仅 1 字符：距上次 flush 不足 400ms → 被节流跳过
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toBe("甲".repeat(250));
  });

  it("租约丢失 → heartbeat.throwIfLost 的错误向上抛出（不被吞）", async () => {
    const heartbeat = {
      lost: false,
      throwIfLost: () => {
        throw new Error("lease lost during model stream");
      },
      onLost: () => () => {},
      stop: () => {},
      start: () => {},
    } as never;
    const collector = new StepCollector(
      baseOpts({
        heartbeat,
        provider: providerOf([{ text: "x", isFinal: true }]),
      }),
    );
    await expect(collector.collect()).rejects.toThrow(/lease lost/i);
  });

  it("循环引用工具参数 → 不抛异常（计量降级，缺陷 D-CIRC）", async () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const collector = new StepCollector(
      baseOpts({
        provider: providerOf([{ text: "", isFinal: true, toolCalls: [{ id: "c1", name: "t", arguments: circular }] }]),
      }),
    );
    const result = await collector.collect();
    expect(result.stop).toBeNull();
    expect(result.chunks).toHaveLength(1);
  });

  it("工具 schema 每步全量计入输入计量（体积小但计费）", async () => {
    const control = createControlContext({ tokenBudget: { maxTokens: 100_000, usedTokens: 0 } });
    const collector = new StepCollector(
      baseOpts({
        control,
        tools: [{ name: "t", description: "x".repeat(500), readOnly: true }],
        provider: providerOf([{ text: "ok", isFinal: true }]),
      }),
    );
    await collector.collect();
    // 500 字符描述的 schema 必然产生可观计费（> 500 字节）
    expect(control.tokenBudget?.usedTokens).toBeGreaterThan(500);
  });
});
