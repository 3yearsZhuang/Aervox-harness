import { describe, expect, it } from "vitest";
import { createComposedContextBuilder, createSummaryCompaction, type PromptMessage } from "../src/index.js";

describe("Context Explainability & Pruning Report (ContextCompaction)", () => {
  it("未超过阈值时不发生裁剪，报告记录 trigger: 'none'", async () => {
    const compactor = createSummaryCompaction(10);
    const messages: PromptMessage[] = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];

    const result = await compactor.compact({
      turnId: "t1",
      sessionId: "s1",
      messages,
    });

    expect(result.messages).toHaveLength(3);
    expect(result.pruningReport).toBeDefined();
    expect(result.pruningReport).toMatchObject({
      initialMessageCount: 3,
      finalMessageCount: 3,
      omittedMessageCount: 0,
      omittedGroupsCount: 0,
      pruningTrigger: "none",
      summaryStatus: "skipped",
    });
  });

  it("超出阈值裁剪时，报告准确记录省略组数、消息数、归因字符与规则通知状态", async () => {
    // 限制最大保留 4 条消息（含系统提示词与通知消息）
    const compactor = createSummaryCompaction(4);
    const messages: PromptMessage[] = [
      { role: "system", content: "You are Aervox." },
      { role: "user", content: "Msg 1" },
      { role: "assistant", content: "Resp 1" },
      { role: "user", content: "Msg 2" },
      { role: "assistant", content: "Resp 2" },
      { role: "user", content: "Msg 3" },
      { role: "assistant", content: "Resp 3" },
    ];

    const result = await compactor.compact({
      turnId: "t2",
      sessionId: "s2",
      messages,
    });

    expect(result.pruningReport).toBeDefined();
    const report = result.pruningReport!;
    expect(report.initialMessageCount).toBe(7);
    expect(report.omittedMessageCount).toBeGreaterThan(0);
    expect(report.omittedGroupsCount).toBeGreaterThan(0);
    expect(report.pruningTrigger).toBe("message_count_limit");
    expect(report.summaryStatus).toBe("rule_notice");
    expect(report.attribution?.systemPromptChars).toBe("You are Aervox.".length);
    expect(report.attribution?.omittedChars).toBeGreaterThan(0);
    expect(report.attribution?.keptChars).toBeGreaterThan(0);
  });

  it("配置真实 summarizer 时，报告记录 summaryStatus: 'generated' 且输出摘要", async () => {
    const compactor = createSummaryCompaction({
      maxMessages: 4,
      summarizer: async (omitted) => `省略了 ${omitted.length} 条对话。`,
    });

    const messages: PromptMessage[] = [
      { role: "system", content: "System" },
      { role: "user", content: "U1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "U2" },
      { role: "assistant", content: "A2" },
    ];

    const result = await compactor.compact({
      turnId: "t3",
      sessionId: "s3",
      messages,
    });

    expect(result.summary).toContain("省略了");
    expect(result.pruningReport?.summaryStatus).toBe("generated");
  });
  it("composed builder preserves the compaction report for callers", async () => {
    const builder = createComposedContextBuilder({ compaction: createSummaryCompaction(2) });
    const context = await builder.build({ turnId: "t", sessionId: "s", messages: [
      { role: "user", content: "old" }, { role: "assistant", content: "old reply" },
      { role: "user", content: "new" },
    ] });
    expect(context.pruningReport).toMatchObject({ omittedMessageCount: 2, pruningTrigger: "message_count_limit" });
  });

  it("reports summarizer failure without losing the fallback or cancellation semantics", async () => {
    const compactor = createSummaryCompaction({ maxMessages: 2, summarizer: async () => { throw new Error("unavailable"); } });
    const messages: PromptMessage[] = [{ role: "user", content: "old" }, { role: "assistant", content: "old reply" }, { role: "user", content: "new" }];
    const result = await compactor.compact({ turnId: "t", sessionId: "s", messages });
    expect(result.pruningReport).toMatchObject({ summaryStatus: "failed", summaryError: "unavailable", omittedMessageCount: 2 });
    expect(result.messages[0]?.content).toContain("Summary generation failed");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(compactor.compact({ turnId: "t", sessionId: "s", messages, signal: controller.signal })).rejects.toThrow("cancelled");
  });

});
