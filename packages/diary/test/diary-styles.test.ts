/**
 * @aervox/diary — 日记提炼风格 SPI 单元测试 (CAP-008/017)
 */
import { describe, expect, it } from "vitest";
import {
  DiaryStyleRegistry,
  defaultDiaryStyleRegistry,
  renderTemplateDiary,
  type DiaryStyle,
} from "../src/index.js";
import type { DiaryMaterial } from "../src/material.js";

const sampleMaterial: DiaryMaterial = {
  messages: [
    { role: "user", content: "今天复习了快速排序", occurredAt: "2026-09-17T10:00:00.000Z" },
    { role: "assistant", content: "基准值选择会影响最坏复杂度", occurredAt: "2026-09-17T10:01:00.000Z" },
  ],
  memories: [
    {
      layer: "short_term",
      category: "learning_event",
      content: "掌握快排双指针分区算法",
      createdAt: "2026-09-17T10:02:00.000Z",
    },
  ],
  goals: [{ topic: "算法与数据结构", level: "intermediate", status: "active" }],
  attemptsToday: { total: 10, correct: 9 },
};

describe("DiaryStyle SPI (日记风格与复盘提炼扩展, CAP-008/017)", () => {
  it("默认注册表包含 companion、growth、concise 三种预置风格", () => {
    const list = defaultDiaryStyleRegistry.list();
    const ids = list.map((s) => s.id);
    expect(ids).toContain("companion");
    expect(ids).toContain("growth");
    expect(ids).toContain("concise");

    const def = defaultDiaryStyleRegistry.getDefault();
    expect(def.id).toBe("companion");
    expect(def.targetScene).toBe("companion");
  });

  it("growth 学习复盘风格生成目标与正答率模板", () => {
    const growth = defaultDiaryStyleRegistry.get("growth");
    expect(growth).toBeDefined();

    const rendered = growth!.renderTemplate(sampleMaterial, "2026-09-17");
    expect(rendered.title).toBe("2026-09-17 学习复盘");
    expect(rendered.content).toContain("完成练习 10 题，答对 9 题（准确率 90%）。");
    expect(rendered.content).toContain("算法与数据结构");
    expect(rendered.content).toContain("掌握快排双指针分区算法");

    const sysPrompt = growth!.buildSystemPrompt("思思");
    expect(sysPrompt).toContain("学习与认知复盘");
    expect(sysPrompt).toContain("【今日学情回顾】");
  });

  it("concise 极简量化风格生成无冗余数据要点", () => {
    const concise = defaultDiaryStyleRegistry.get("concise");
    expect(concise).toBeDefined();

    const rendered = concise!.renderTemplate(sampleMaterial, "2026-09-17");
    expect(rendered.title).toBe("2026-09-17 极简记录");
    expect(rendered.content).toContain("- 对话交互：2 条记录");
    expect(rendered.content).toContain("- 题目练习：9/10 达标");
    expect(rendered.content).toContain("- 目标领域：算法与数据结构");

    const sysPrompt = concise!.buildSystemPrompt("思思");
    expect(sysPrompt).toContain("极简记录模块");
    expect(sysPrompt).toContain("Markdown 无序列表");
  });

  it("renderTemplateDiary 支持通过 styleId 渲染对应风格", () => {
    const draftGrowth = renderTemplateDiary(sampleMaterial, "2026-09-17", "growth");
    expect(draftGrowth.title).toBe("2026-09-17 学习复盘");
    expect(draftGrowth.content).toContain("【今日学情回顾】");

    const draftConcise = renderTemplateDiary(sampleMaterial, "2026-09-17", "concise");
    expect(draftConcise.title).toBe("2026-09-17 极简记录");
    expect(draftConcise.content).toContain("- 对话交互：2 条记录");

    const draftDefault = renderTemplateDiary(sampleMaterial, "2026-09-17");
    expect(draftDefault.title).toBe("2026-09-17 的日记");
    expect(draftDefault.content).toContain("今天我们聊了 2 句话，我都记着呢。");
  });

  it("支持第三方自定义风格动态注册扩展", () => {
    const registry = new DiaryStyleRegistry();
    const customStyle: DiaryStyle = {
      id: "weekly-sprint",
      name: "每周冲刺总结",
      description: "敏捷迭代复盘",
      targetScene: "productivity",
      buildSystemPrompt: () => "Sprint review prompt",
      buildUserPrompt: () => "Sprint user prompt",
      renderTemplate: () => ({
        title: "Sprint Review",
        content: "Sprint completed items",
      }),
    };

    registry.register(customStyle);
    expect(registry.get("weekly-sprint")).toBe(customStyle);

    registry.setDefault("weekly-sprint");
    expect(registry.getDefault().id).toBe("weekly-sprint");
  });
});
