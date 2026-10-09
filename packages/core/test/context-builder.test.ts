/**
 * Aervox｜思隅 @aervox/core — 阶段 5b Context 组装测试
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

  it("createSummaryCompaction：超阈值保留近期完整消息并明确省略", async () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      content: `消息 ${i + 1}`,
    }));
    const res = await createSummaryCompaction(10).compact({
      turnId: "t1",
      sessionId: "s1",
      messages,
    });
    expect(res.messages.length).toBeLessThanOrEqual(10);
    expect(res.messages[0]!.role).toBe("system");
    expect(res.messages[0]!.content).toContain("No summary was generated");
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

  it("buildBaseSystemPrompt：注入人格时声明人格设定优先于默认身份与风格", async () => {
    const { buildBaseSystemPrompt } = await import("../src/base-prompt.js");
    const withPersona = buildBaseSystemPrompt({
      assistantName: "流萤",
      personaPrompt: "你是流萤，星穹列车的乘员",
    });
    expect(withPersona).toContain("以人格设定为准");
    expect(withPersona).toContain("最高优先级");

    const withoutPersona = buildBaseSystemPrompt({ assistantName: "思隅" });
    expect(withoutPersona).not.toContain("以人格设定为准");
  });

  it("buildBaseSystemPrompt：始终注入输出格式规则（禁 emoji 与禁 Markdown）", async () => {
    const { buildBaseSystemPrompt } = await import("../src/base-prompt.js");
    const withPersona = buildBaseSystemPrompt({ assistantName: "思隅", personaPrompt: "活泼" });
    const withoutPersona = buildBaseSystemPrompt({ assistantName: "思隅" });
    for (const prompt of [withPersona, withoutPersona]) {
      expect(prompt).toContain("输出格式 (Output Style)");
      expect(prompt).toContain("禁止使用任何 emoji");
      expect(prompt).toContain("不使用 Markdown 语法");
      // 输出格式规则位于人格设定之后（末尾最强约束）
      if (prompt.includes("人格设定")) {
        expect(prompt.indexOf("输出格式 (Output Style)")).toBeGreaterThan(
          prompt.indexOf("人格设定"),
        );
      }
    }
  });

  it("buildBaseSystemPrompt：作为纯净底座，默认不含任何插件领域内容", async () => {
    const { buildBaseSystemPrompt } = await import("../src/base-prompt.js");
    const prompt = buildBaseSystemPrompt({ assistantName: "思隅" });

    // CR-060：产品域提示词与插件工具指南一律不落在内核基础提示词内，
    // 由插件经 extraSections 与 customGuidance 通用注入位提供。
    expect(prompt).not.toContain("专注模式核心教学原则");
    expect(prompt).not.toContain("刷题核心规范");
    expect(prompt).not.toContain("record_practice_attempt");
    expect(prompt).not.toContain("苏格拉底");
  });

  it("buildBaseSystemPrompt：支持 extraSections 注入扩展规则段并保持相对顺序", async () => {
    const { buildBaseSystemPrompt } = await import("../src/base-prompt.js");
    const customSection = "### 自定义扩展规则\n遵循某种特殊业务规则。";
    const focusSection = "### 专注模式扩展段\n专注模式核心教学原则示例。";
    const prompt = buildBaseSystemPrompt({
      assistantName: "思隅",
      extraSections: [focusSection, customSection],
      personaPrompt: "专业严谨",
    });

    expect(prompt).toContain("专注模式核心教学原则");
    expect(prompt).toContain("自定义扩展规则");
    // 验证相对顺序：extraSections -> personaPrompt -> outputStyle
    expect(prompt.indexOf("专注模式核心教学原则")).toBeLessThan(
      prompt.indexOf("自定义扩展规则"),
    );
    expect(prompt.indexOf("自定义扩展规则")).toBeLessThan(
      prompt.indexOf("# 人格设定"),
    );
    expect(prompt.indexOf("# 人格设定")).toBeLessThan(
      prompt.indexOf("输出格式"),
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
    // 保留系统约束、真实省略提示与最近完整消息。
    expect(ctx.messages).toHaveLength(3);
    expect(ctx.messages[0]!.content).toContain("## Skills");
    expect(ctx.messages[1]!.content).toContain("Context compaction");
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
