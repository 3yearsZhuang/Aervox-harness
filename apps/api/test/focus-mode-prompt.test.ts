/**
 * Aervox｜思隅 @aervox/api — 专注模式提示词资产测试（ADR-021 内核提纯修订）
 *
 * 用例自 packages/core（原 agent-loop context-builder.test.ts 内嵌段）随构件
 * 迁回插件宿主：buildFocusModePrompt / QUIZ_MODE_SYSTEM_PROMPT / study-mode 别名。
 */
import { describe, expect, it } from "vitest";
import {
  buildFocusModePrompt,
  buildStudyModePrompt,
  QUIZ_MODE_SYSTEM_PROMPT,
  STUDY_MODE_SYSTEM_PROMPT,
} from "../src/modules/ecosystem/plugins/turn-plugins/focus-mode-prompt.js";

describe("专注模式提示词资产（Focus Mode Prompt Assets）", () => {
  it("buildFocusModePrompt：构建苏格拉底启发式教学与防剧透规则", () => {
    const prompt = buildFocusModePrompt();

    expect(prompt).toContain("专注模式核心教学原则");
    expect(prompt).toContain("苏格拉底式启发引导");
    expect(prompt).toContain("循序渐进与分步拆解");
  });

  it("buildFocusModePrompt：支持自定义脚手架步数与严格防剧透", () => {
    const prompt = buildFocusModePrompt({
      scaffoldingSteps: 4,
      strictAntiSpoiler: true,
    });

    expect(prompt).toContain("拆解为 4 个连贯的小步骤");
    expect(prompt).toContain("【严格防剧透模式开启】");
  });

  it("QUIZ_MODE_SYSTEM_PROMPT：定义刷题出题与判定闭环规范并包含工具指引要求", () => {
    expect(QUIZ_MODE_SYSTEM_PROMPT).toContain("专注模式·刷题核心规范");
    expect(QUIZ_MODE_SYSTEM_PROMPT).toContain("record_practice_attempt");
    expect(QUIZ_MODE_SYSTEM_PROMPT).toContain("ask_user_question");
  });

  it("study-mode-prompt：向后兼容别名可从 focus-mode-prompt 引入并构建不同配置的提示词", () => {
    expect(STUDY_MODE_SYSTEM_PROMPT).toContain("专注模式核心教学原则");
    const relaxed = buildStudyModePrompt({ strictAntiSpoiler: false, scaffoldingSteps: 2 });
    expect(relaxed).toContain("拆解为 2 个连贯的小步骤");
    expect(relaxed).not.toContain("【严格防剧透模式开启】");
    expect(relaxed).toContain("优先识别用户的卡点");
  });
});
