/**
 * Aervox｜思隅 @aervox/core — 上下文投影、保真事实清单与真实摘要压缩测试（ITER-032）
 *
 * 验收目标：
 * 1. 伴学保真事实清单：学习目标、未解决错因、用户偏好、承诺及来源在任何裁剪下均保真；
 * 2. 上下文投影（PI-01 context_edit）：原历史完整保留，模型可见视图支持按 ID/谓词隐藏；
 * 3. 工具组配对防腐：隐藏 assistant 级联隐藏下游 tool；不完整/孤立 tool 调用被剔除，严禁模型 400；
 * 4. 超大工具输出有界截断：超出阈值的工具结果保留首尾与显式标记，不爆上下文窗口；
 * 5. 真实摘要压缩与失败可见：支持异步真实摘要器，支持 throw（阻塞失败可见）与 fallback_notice。
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildGroundingFactsPrompt,
  CompactionError,
  createComposedContextBuilder,
  createGroundingFactsContextBuilder,
  createSummaryCompaction,
  defaultContextBuilder,
  groupMessagesByToolBoundary,
  projectContextToModelVisible,
  truncateToolMessage,
  type GroundingFacts,
  type PromptMessage,
  type SummaryGenerator,
} from "../src/index.js";

describe("伴学保真事实清单 (Grounding Facts - ITER-032)", () => {
  it("buildGroundingFactsPrompt：空事实返回空串", () => {
    expect(buildGroundingFactsPrompt()).toBe("");
    expect(buildGroundingFactsPrompt({})).toBe("");
    expect(buildGroundingFactsPrompt({ learningGoals: [] })).toBe("");
  });

  it("buildGroundingFactsPrompt：正确格式化各分类事实及来源引用", () => {
    const facts: GroundingFacts = {
      learningGoals: [
        "掌握二叉树层序遍历",
        { text: "理解动态规划无后效性", source: "错题本 #12" },
      ],
      unresolvedMistakes: [
        { text: "边界条件经常遗漏 root === null", source: "LeetCode 102" },
      ],
      userPreferences: [
        "更倾向于先给代码框架而非直接给完整题解",
      ],
      commitments: [
        { text: "下一次对话时优先检查 DP 状态转移方程写出情况", source: "Turn #4" },
      ],
      customSections: [
        {
          title: "复习优先级",
          items: ["高频考察题型：二叉树、贪心"],
        },
      ],
    };

    const prompt = buildGroundingFactsPrompt(facts);
    expect(prompt).toContain("## 伴学保真事实清单");
    expect(prompt).toContain("掌握二叉树层序遍历");
    expect(prompt).toContain("理解动态规划无后效性 (来源: 错题本 #12)");
    expect(prompt).toContain("边界条件经常遗漏 root === null (来源: LeetCode 102)");
    expect(prompt).toContain("更倾向于先给代码框架而非直接给完整题解");
    expect(prompt).toContain("下一次对话时优先检查 DP 状态转移方程写出情况 (来源: Turn #4)");
    expect(prompt).toContain("### 复习优先级");
    expect(prompt).toContain("高频考察题型：二叉树、贪心");
  });

  it("createGroundingFactsContextBuilder：作为独立 builder 注入 system", async () => {
    const facts: GroundingFacts = {
      learningGoals: ["学习 Rust 所有权与生命周期"],
    };
    const builder = createGroundingFactsContextBuilder(facts);
    const ctx = await builder.build({
      turnId: "t1",
      sessionId: "s1",
      messages: [{ role: "user", content: "我们开始吧" }],
    });

    expect(ctx.messages[0]!.role).toBe("system");
    expect(ctx.messages[0]!.content).toContain("学习 Rust 所有权与生命周期");
    expect(ctx.messages[1]!.content).toBe("我们开始吧");
  });
});

describe("模型可见上下文投影 (Context Projection - PI-01 context_edit)", () => {
  const sampleMessages: PromptMessage[] = [
    { id: "m1", role: "system", content: "System Base" },
    { id: "m2", role: "user", content: "请查找文件" },
    {
      id: "m3",
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "find_file", arguments: { path: "a.ts" } }],
    },
    { id: "m4", role: "tool", toolCallId: "call_1", content: "file content: a.ts" },
    { id: "m5", role: "assistant", content: "找到了 a.ts" },
  ];

  it("groupMessagesByToolBoundary：将包含 toolCalls 的 assistant 与后续 tools 作为一个原子组", () => {
    const groups = groupMessagesByToolBoundary(sampleMessages);
    expect(groups).toHaveLength(4);
    expect(groups[0]).toEqual([sampleMessages[0]]);
    expect(groups[1]).toEqual([sampleMessages[1]]);
    // 第 3 组应包含 assistant (m3) 与 tool (m4)
    expect(groups[2]).toEqual([sampleMessages[2], sampleMessages[3]]);
    expect(groups[3]).toEqual([sampleMessages[4]]);
  });

  it("projectContextToModelVisible：不修改原始输入，未配置选项时保持完整", () => {
    const projected = projectContextToModelVisible(sampleMessages);
    expect(projected).toHaveLength(5);
    expect(projected).not.toBe(sampleMessages);
  });

  it("projectContextToModelVisible：支持按 ID 隐藏消息（PI-01 context_edit）", () => {
    const projected = projectContextToModelVisible(sampleMessages, {
      hiddenMessageIds: new Set(["m5"]),
    });
    expect(projected.some((m) => m.id === "m5")).toBe(false);
    expect(projected).toHaveLength(4);
  });

  it("级联隐藏：隐藏 assistant 时自动隐藏其对应的 tool 结果", () => {
    const projected = projectContextToModelVisible(sampleMessages, {
      hiddenMessageIds: new Set(["m3"]), // 隐藏 assistant
    });
    // m3 与 m4 均不应出现在投影中
    expect(projected.some((m) => m.id === "m3")).toBe(false);
    expect(projected.some((m) => m.id === "m4")).toBe(false);
    expect(projected).toHaveLength(3); // system, user, assistant(m5)
  });

  it("严格工具配对：缺少 tool 响应的 assistant 组被剔除，防止 LLM 400 报错", () => {
    const brokenMessages: PromptMessage[] = [
      { id: "m1", role: "user", content: "run tool" },
      {
        id: "m2",
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_1", name: "tool1", arguments: {} },
          { id: "call_2", name: "tool2", arguments: {} },
        ],
      },
      // 只有 call_1 的结果，缺少 call_2
      { id: "m3", role: "tool", toolCallId: "call_1", content: "ok" },
      { id: "m4", role: "assistant", content: "done" },
    ];

    const projected = projectContextToModelVisible(brokenMessages, {
      enforceStrictToolPairing: true,
    });
    // 不完整的 m2 + m3 被剔除，保留合法的 m1 和 m4
    expect(projected).toHaveLength(2);
    expect(projected[0]!.id).toBe("m1");
    expect(projected[1]!.id).toBe("m4");
  });

  it("严格工具配对：孤立的 tool 消息被剔除", () => {
    const orphanMessages: PromptMessage[] = [
      { id: "m1", role: "user", content: "hello" },
      { id: "m2", role: "tool", toolCallId: "phantom_call", content: "orphan output" },
      { id: "m3", role: "assistant", content: "world" },
    ];

    const projected = projectContextToModelVisible(orphanMessages, {
      enforceStrictToolPairing: true,
    });
    expect(projected.some((m) => m.id === "m2")).toBe(false);
    expect(projected).toHaveLength(2);
  });

  it("超大工具结果截断：超出 maxToolResultChars 时截断并保留前后结构与审计通知", () => {
    const massiveContent = "START_" + "x".repeat(30000) + "_END";
    const toolMsg: PromptMessage = {
      role: "tool",
      toolCallId: "call_big",
      content: massiveContent,
    };

    const truncated = truncateToolMessage(toolMsg, {
      maxToolResultChars: 1000,
      toolResultHeadChars: 50,
      toolResultTailChars: 50,
    });

    expect(truncated.content.length).toBeLessThan(massiveContent.length);
    expect(truncated.content.startsWith("START_")).toBe(true);
    expect(truncated.content.endsWith("_END")).toBe(true);
    expect(truncated.content).toContain("Tool result truncated");
    expect(truncated.content).toContain("30010 total characters");
  });
});

describe("真实摘要压缩与失败可见性 (Compaction & Summarization - ITER-032)", () => {
  const makeHistory = (count: number): PromptMessage[] =>
    Array.from({ length: count }, (_, i) => ({
      id: `msg_${i + 1}`,
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `对话内容 ${i + 1}`,
    }));

  it("未配置 summarizer 时降级为规则式明确省略说明", async () => {
    const messages = makeHistory(10);
    const compaction = createSummaryCompaction({ maxMessages: 4 });
    const result = await compaction.compact({
      turnId: "t1",
      sessionId: "s1",
      messages,
    });

    expect(result.messages.length).toBeLessThanOrEqual(4);
    expect(result.messages[0]!.role).toBe("system");
    expect(result.messages[0]!.content).toContain("No summary was generated; do not infer missing facts");
    expect(result.summary).toBeUndefined();
  });

  it("配置 summarizer 时调用真实摘要器，并生成保真上下文摘要", async () => {
    const messages = makeHistory(10);
    const summarizer: SummaryGenerator = vi.fn(async (omitted) => {
      return `用户回顾了前 ${omitted.length} 条消息的知识点。`;
    });

    const compaction = createSummaryCompaction({
      maxMessages: 4,
      summarizer,
    });

    const result = await compaction.compact({
      turnId: "t1",
      sessionId: "s1",
      messages,
    });

    expect(summarizer).toHaveBeenCalledOnce();
    expect(result.summary).toBe("用户回顾了前 7 条消息的知识点。");
    expect(result.messages[0]!.role).toBe("system");
    expect(result.messages[0]!.content).toContain("## 会话历史摘要");
    expect(result.messages[0]!.content).toContain("用户回顾了前 7 条消息的知识点。");
    // 保留最后 2 条消息
    expect(result.messages[result.messages.length - 1]).toEqual(messages[messages.length - 1]);
  });

  it("阻塞失败可见（PI-01）：onFailure='throw' 时摘要失败直接抛出 CompactionError", async () => {
    const messages = makeHistory(10);
    const summarizer: SummaryGenerator = vi.fn(async () => {
      throw new Error("Provider rate limit reached (429)");
    });

    const compaction = createSummaryCompaction({
      maxMessages: 4,
      summarizer,
      onFailure: "throw",
    });

    await expect(
      compaction.compact({ turnId: "t1", sessionId: "s1", messages }),
    ).rejects.toThrowError(CompactionError);
  });

  it("降级通知：onFailure='fallback_notice' 时摘要失败在上下文注入失败原因，不中断", async () => {
    const messages = makeHistory(10);
    const summarizer: SummaryGenerator = vi.fn(async () => {
      throw new Error("Network timeout after 15s");
    });

    const compaction = createSummaryCompaction({
      maxMessages: 4,
      summarizer,
      onFailure: "fallback_notice",
    });

    const result = await compaction.compact({ turnId: "t1", sessionId: "s1", messages });
    expect(result.messages[0]!.role).toBe("system");
    expect(result.messages[0]!.content).toContain("Summary generation failed (Network timeout after 15s)");
    expect(result.messages[0]!.content).toContain("do not infer missing facts");
  });

  it("工具调用与工具结果成组保全：压缩裁剪绝不在 assistant 和 tool 之间切断", async () => {
    const messages: PromptMessage[] = [
      { id: "m1", role: "user", content: "前置问题" },
      { id: "m2", role: "assistant", content: "前置回答" },
      { id: "m3", role: "user", content: "需要调用工具" },
      {
        id: "m4",
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "tool_a", arguments: {} },
          { id: "c2", name: "tool_b", arguments: {} },
        ],
      },
      { id: "m5", role: "tool", toolCallId: "c1", content: "res1" },
      { id: "m6", role: "tool", toolCallId: "c2", content: "res2" },
      { id: "m7", role: "assistant", content: "工具调用完毕" },
    ];

    // 设置 maxMessages = 5（包含 1 条 notice + 1 个原子组[m4, m5, m6] + 1 条 m7，总计 5 条）
    const compaction = createSummaryCompaction({ maxMessages: 5 });
    const result = await compaction.compact({ turnId: "t1", sessionId: "s1", messages });

    const roles = result.messages.map((m) => m.role);
    // 验证 m4, m5, m6 保持在一起，未被拆散
    expect(result.messages.some((m) => m.id === "m4")).toBe(true);
    expect(result.messages.some((m) => m.id === "m5")).toBe(true);
    expect(result.messages.some((m) => m.id === "m6")).toBe(true);
    expect(roles).toEqual(["system", "assistant", "tool", "tool", "assistant"]);
  });
});

describe("统合 ContextBuilder 组合器 (Composer with GroundingFacts & Projection - ITER-032)", () => {
  it("统一 composer：同时生效 baseSystemPrompt, groundingFacts, skills, inbox, projection 与 compaction", async () => {
    const groundingFacts: GroundingFacts = {
      learningGoals: ["期末高数冲刺"],
      commitments: ["每天两道微积分题目"],
    };

    const summarizer: SummaryGenerator = vi.fn(async () => "历史练习进度总结");

    const builder = createComposedContextBuilder({
      base: defaultContextBuilder,
      baseSystemPrompt: { assistantName: "思隅学伴" },
      groundingFacts,
      skills: [{ name: "math-calc", description: "复杂微积分计算器" }],
      inbox: true,
      projection: { maxToolResultChars: 100 },
      compaction: createSummaryCompaction({ maxMessages: 6, summarizer }),
    });

    const rawMessages: PromptMessage[] = [
      { role: "user", content: "第一题求导" },
      { role: "assistant", content: "这是第一题步骤" },
      { role: "user", content: "第二题积分" },
      { role: "assistant", content: "这是第二题步骤" },
      { role: "user", content: "第三题极限" },
      { role: "assistant", content: "这是第三题步骤" },
    ];

    const ctx = await builder.build({
      turnId: "t_comp",
      sessionId: "s_comp",
      messages: rawMessages,
    });

    const systemContents = ctx.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");

    // 1. 基础提示词包含助手名
    expect(systemContents).toContain("思隅学伴");
    // 2. 保真事实清单存在且包含目标与承诺
    expect(systemContents).toContain("期末高数冲刺");
    expect(systemContents).toContain("每天两道微积分题目");
    // 3. 渐进式 Skill 注入
    expect(systemContents).toContain("math-calc");
    // 4. 压缩后的历史摘要存在
    expect(systemContents).toContain("历史练习进度总结");
  });
});
