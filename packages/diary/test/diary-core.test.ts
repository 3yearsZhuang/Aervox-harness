/**
 * @aervox/diary — Prompt 与模板渲染单元测试
 */
import { describe, expect, it } from "vitest";
import { buildDiarySystemPrompt, buildDiaryUserPrompt } from "../src/prompts.js";
import { renderTemplateDiary } from "../src/template.js";
import type { DiaryMaterial } from "../src/material.js";

const emptyMaterial: DiaryMaterial = {
  messages: [],
  memories: [],
  goals: [],
  attemptsToday: { total: 0, correct: 0 },
};

const richMaterial: DiaryMaterial = {
  messages: [
    { role: "user", content: "今天一定要把二叉树啃下来", occurredAt: "2026-08-29T09:00:00.000Z" },
    { role: "assistant", content: "好，我们从递归开始讲", occurredAt: "2026-08-29T09:01:00.000Z" },
  ],
  memories: [
    {
      layer: "short_term",
      category: "learning_event",
      content: "用户正在复习树的前序遍历",
      createdAt: "2026-08-29T09:02:00.000Z",
    },
  ],
  goals: [{ topic: "数据结构", level: "beginner", status: "active" }],
  attemptsToday: { total: 3, correct: 2 },
};

describe("buildDiarySystemPrompt", () => {
  it("包含第一人称与人类随笔风格约束，保留反虚构红线", () => {
    const prompt = buildDiarySystemPrompt("思思");
    expect(prompt).toContain("思思");
    expect(prompt).toContain("只能引用素材中真实发生的内容");
    expect(prompt).toContain("像真正的伙伴在睡前随手记下今天");
    expect(prompt).toContain("2-5 段");
  });
});

describe("buildDiaryUserPrompt", () => {
  it("素材 JSON 含当日记忆段", () => {
    const prompt = buildDiaryUserPrompt(richMaterial, "2026-08-29");
    expect(prompt).toContain("今日记忆");
    expect(prompt).toContain("用户正在复习树的前序遍历");
    expect(prompt).toContain("2026-08-29");
  });
});

describe("renderTemplateDiary", () => {
  it("无素材时输出简短诚实日记", () => {
    const draft = renderTemplateDiary(emptyMaterial, "2026-08-29");
    expect(draft.generatedBy).toBe("template");
    expect(draft.materialCount).toBe(0);
    expect(draft.content).toContain("今天我们还没怎么说话");
  });

  it("计入当日记忆素材", () => {
    const draft = renderTemplateDiary(richMaterial, "2026-08-29");
    expect(draft.materialCount).toBe(5); // 2 消息 + 1 记忆 + 1 目标 + 练习（total>0 计 1）
    expect(draft.content).toContain("今天我还悄悄记下了 1 件与你有关的事");
    expect(draft.content).toContain("练习了 3 道题");
  });
});