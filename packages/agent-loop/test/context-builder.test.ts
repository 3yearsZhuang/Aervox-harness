/**
 * Aervox｜思隅 @aervox/agent-loop — 阶段 5b Context 组装测试
 *
 * 覆盖 §7.1 Context 组装 + §13 阶段 5 首条目：
 * - Skill 渐进披露：buildSkillsPrompt 只注入名称+描述；skillSystem 前置注入
 *  （已有首条 system 时不翻倍，插在首条 system 之后）；
 * - Context 压缩 seam：默认透传；规则式摘要超阈值截断、未超阈值原样、summary 返回；
 * - 统一 composer：inbox+skills+compaction 组合顺序与异步 build 兼容。
 */
import { describe, expect, it } from "vitest";
import {
  buildSkillsPrompt,
  createComposedContextBuilder,
  createInboxAwareContextBuilder,
  createSkillAwareContextBuilder,
  createSummaryCompaction,
  defaultCompactionPort,
  defaultContextBuilder,
  type ContextBuilderPort,
} from "../src/index.js";
import type { SkillDescriptor } from "../src/types.js";

const skills: SkillDescriptor[] = [
  { name: "notes-search", description: "搜索学习笔记" },
  { name: "review-plan", description: "生成复习计划" },
];

const baseMessages = () => [
  { role: "user" as const, content: "你好" },
  { role: "assistant" as const, content: "你好！" },
];

describe("阶段 5b Skill 渐进披露", () => {
  it("buildSkillsPrompt：空清单返回空串；清单生成名称+描述", () => {
    expect(buildSkillsPrompt([])).toBe("");
    const prompt = buildSkillsPrompt(skills);
    expect(prompt).toContain("**notes-search**");
    expect(prompt).toContain("搜索学习笔记");
    expect(prompt).toContain("**review-plan**");
    // 渐进披露规则：引导按需读取全文而非全文注入
    expect(prompt).toContain("`SKILL.md` via `GET /v1/skills/:name/content`");
  });

  it("createSkillAwareContextBuilder：system 段前置，历史透传", () => {
    const builder = createSkillAwareContextBuilder(skills);
    const ctx = builder.build({
      turnId: "t1",
      sessionId: "s1",
      messages: baseMessages(),
    });
    expect(ctx.messages[0]!.role).toBe("system");
    expect(ctx.messages[0]!.content).toContain("## Skills");
    expect(ctx.messages[1]).toEqual(baseMessages()[0]);
  });
});

describe("阶段 5b Context 压缩 seam", () => {
  it("defaultCompactionPort：透传不截断", async () => {
    const messages = baseMessages();
    const res = await defaultCompactionPort.compact({
      turnId: "t1",
      sessionId: "s1",
      messages,
    });
    expect(res.messages).toBe(messages);
    expect(res.summary).toBeUndefined();
  });

  it("createSummaryCompaction：未超阈值原样返回", async () => {
    const messages = [...baseMessages(), { role: "user" as const, content: "再聊" }];
    const res = await createSummaryCompaction(50).compact({
      turnId: "t1",
      sessionId: "s1",
      messages,
    });
    expect(res.messages).toEqual(messages);
  });

  it("createSummaryCompaction：超阈值保留首尾 + 摘要占位", async () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      content: `消息 ${i + 1}`,
    }));
    const res = await createSummaryCompaction(10).compact({
      turnId: "t1",
      sessionId: "s1",
      messages,
    });
    expect(res.messages).toHaveLength(5); // 首2 + 摘要 + 尾2
    expect(res.messages[0]).toEqual(messages[0]);
    expect(res.messages[1]).toEqual(messages[1]);
    expect(res.messages[2]!.role).toBe("system");
    expect(res.messages[2]!.content).toContain("Context compaction");
    expect(res.messages[res.messages.length - 2]).toEqual(messages[messages.length - 2]);
    expect(res.messages[res.messages.length - 1]).toEqual(messages[messages.length - 1]);
  });
});

describe("基础系统提示词与工具指引 (Base System Prompt & Tool Guidance)", () => {
  it("buildBaseSystemPrompt：生成助手身份与内置工具使用规则约束", async () => {
    const { buildBaseSystemPrompt } = await import("../src/base-prompt.js");
    const prompt = buildBaseSystemPrompt({
      assistantName: "测试思隅",
      personaPrompt: "保持温柔与耐心",
    });

    expect(prompt).toContain("测试思隅");
    expect(prompt).toContain("工具使用规范与约束");
    expect(prompt).toContain("ask_user_question");
    expect(prompt).toContain("subagent_delegate");
    expect(prompt).toContain("workflow_run");
    expect(prompt).toContain("保持温柔与耐心");
    expect(prompt).not.toContain("专注模式核心教学原则");
  });

  it("buildBaseSystemPrompt：开启 studyMode 时注入苏格拉底启发式教学与防剧透规则", async () => {
    const { buildBaseSystemPrompt } = await import("../src/base-prompt.js");
    const prompt = buildBaseSystemPrompt({
      assistantName: "导师思隅",
      studyMode: true,
      personaPrompt: "活泼幽默",
    });

    expect(prompt).toContain("专注模式核心教学原则");
    expect(prompt).toContain("苏格拉底式启发引导");
    expect(prompt).toContain("循序渐进与分步拆解");
    expect(prompt).toContain("活泼幽默");
  });

  it("buildBaseSystemPrompt：默认不注入刷题模式规范", async () => {
    const { buildBaseSystemPrompt } = await import("../src/base-prompt.js");
    const prompt = buildBaseSystemPrompt({ assistantName: "思隅" });

    expect(prompt).not.toContain("刷题模式核心规范");
  });

  it("buildBaseSystemPrompt：开启 quizMode 时注入刷题闭环规范并登记工具指引", async () => {
    const { buildBaseSystemPrompt } = await import("../src/base-prompt.js");
    const prompt = buildBaseSystemPrompt({
      assistantName: "考官思隅",
      studyMode: true,
      quizMode: true,
    });

    expect(prompt).toContain("刷题模式核心规范");
    expect(prompt).toContain("record_practice_attempt");
    expect(prompt).toContain("ask_user_question");
    // 刷题段置后于专注模式段（覆盖「不直接给答案」规则）
    expect(prompt.indexOf("专注模式核心教学原则")).toBeLessThan(
      prompt.indexOf("刷题模式核心规范"),
    );
  });

  it("createComposedContextBuilder：baseSystemPrompt 置于最前并支持与 skills 组合", async () => {
    const builder = createComposedContextBuilder({
      base: defaultContextBuilder,
      baseSystemPrompt: {
        assistantName: "思隅",
      },
      skills,
    });

    const ctx = await builder.build({
      turnId: "t1",
      sessionId: "s1",
      messages: baseMessages(),
    });

    // 顺序：system(Base Prompt) -> system(Skills) -> user -> assistant
    expect(ctx.messages[0]!.role).toBe("system");
    expect(ctx.messages[0]!.content).toContain("工具使用规范与约束");
    expect(ctx.messages[1]!.role).toBe("system");
    expect(ctx.messages[1]!.content).toContain("## Skills");
    expect(ctx.messages[2]).toEqual(baseMessages()[0]);
  });
});

describe("阶段 5b 统一组合 composer", () => {
  it("全缺省：与 defaultContextBuilder 一致（零行为倒退）", async () => {
    const builder = createComposedContextBuilder();
    const ctx = await builder.build({
      turnId: "t1",
      sessionId: "s1",
      messages: baseMessages(),
    });
    expect(ctx.messages).toEqual(baseMessages());
  });

  it("skills + inbox 组合：system 段前置，inbox 项前置为追加 user", async () => {
    const builder = createComposedContextBuilder({
      base: defaultContextBuilder,
      inbox: true,
      skills,
    });
    const ctx = await builder.build({
      turnId: "t1",
      sessionId: "s1",
      messages: baseMessages(),
      inboxItems: [
        {
          id: "ibx_1",
          idempotencyKey: "k",
          sessionId: "s1",
          type: "steer",
          orderingSeq: 0,
          sourceActor: "user",
          payload: { text: "换个方向" },
          status: "pending",
          consumeBoundary: "next-step",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    // 顺序：system(skills) → inbox(user) → 原始历史
    expect(ctx.messages[0]!.role).toBe("system");
    expect(ctx.messages[0]!.content).toContain("## Skills");
    expect(ctx.messages[1]!.role).toBe("user");
    expect(ctx.messages[1]!.content).toContain("[inbox:steer@user]");
    expect(ctx.messages[2]).toEqual(baseMessages()[0]);
  });

  it("compaction 启用：压缩作用在组装后消息上（结果可 await）", async () => {
    const builder = createComposedContextBuilder({
      base: defaultContextBuilder,
      skills,
      compaction: createSummaryCompaction(3),
    });
    const many = Array.from({ length: 8 }, (_, i) => ({
      role: "user" as const,
      content: `消息 ${i + 1}`,
    }));
    const ctx = await builder.build({ turnId: "t1", sessionId: "s1", messages: many });
    // skills system 前置 + 原 8 条被压缩：head=[skillSystem, m1]、summary、tail=[m7, m8] → 5 条
    expect(ctx.messages).toHaveLength(5);
    expect(ctx.messages[0]!.content).toContain("## Skills");
    expect(ctx.messages[1]).toEqual(many[0]);
    expect(ctx.messages[2]!.content).toContain("Context compaction");
    expect(ctx.messages[ctx.messages.length - 1]).toEqual(many[many.length - 1]);
  });

  it("createInboxAwareContextBuilder 异步兼容：可作为 composer 内层嵌套", async () => {
    const inner: ContextBuilderPort = createInboxAwareContextBuilder(defaultContextBuilder);
    const builder = createComposedContextBuilder({ base: inner, skills });
    const ctx = await builder.build({
      turnId: "t1",
      sessionId: "s1",
      messages: baseMessages(),
      inboxItems: [
        {
          id: "ibx_2",
          idempotencyKey: "k2",
          sessionId: "s1",
          type: "inject",
          orderingSeq: 0,
          sourceActor: "plugin",
          payload: { text: "补充" },
          status: "pending",
          consumeBoundary: "next-step",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    // base 为 inbox wrapper：嵌套顺序为 [inbox, skill system, 历史]——两者皆注入即可
    const contents = ctx.messages.map((m) => m.content);
    expect(contents.some((c) => c.includes("## Skills"))).toBe(true);
    expect(contents.some((c) => c.includes("[inbox:inject@plugin]"))).toBe(true);
    expect(ctx.messages).toHaveLength(4);
  });
});
