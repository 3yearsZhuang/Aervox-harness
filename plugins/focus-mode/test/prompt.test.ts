/**
 * Aervox｜思隅 plugins/focus-mode — 教学提示词单元测试（CAP-002 / CAP-016）
 *
 * CR-060：自 `packages/core/test/context-builder.test.ts` 关于专注模式提示词的用例迁入。
 * 产品域提示词归插件所有，故其断言也随实现落在插件包内；内核侧只保留「基础提示词
 * 不含插件领域内容」的负向断言。
 */
import { describe, expect, it } from "vitest";
import {
  buildFocusModePrompt,
  FOCUS_MODE_SYSTEM_PROMPT,
  QUIZ_SESSION_PROMPT,
} from "../src/server/prompt.js";

describe("专注模式教学提示词", () => {
  it("buildFocusModePrompt：构建启发式教学与分步拆解规则", () => {
    const prompt = buildFocusModePrompt();

    expect(prompt).toContain("专注模式核心教学原则");
    expect(prompt).toContain("苏格拉底式启发引导");
    expect(prompt).toContain("循序渐进与分步拆解");
  });

  it("buildFocusModePrompt：支持自定义脚手架步数与严格防剧透", () => {
    const strict = buildFocusModePrompt({ scaffoldingSteps: 4, strictAntiSpoiler: true });
    expect(strict).toContain("拆解为 4 个连贯的小步骤");
    expect(strict).toContain("【严格防剧透模式开启】");

    const relaxed = buildFocusModePrompt({ strictAntiSpoiler: false, scaffoldingSteps: 2 });
    expect(relaxed).toContain("拆解为 2 个连贯的小步骤");
    expect(relaxed).not.toContain("【严格防剧透模式开启】");
    expect(relaxed).toContain("优先识别用户的卡点");
  });

  it("默认导出常量与显式调用一致（唯一 id 语义，无历史别名）", () => {
    expect(FOCUS_MODE_SYSTEM_PROMPT).toBe(buildFocusModePrompt());
    expect(FOCUS_MODE_SYSTEM_PROMPT).toContain("专注模式核心教学原则");
  });

  it("QUIZ_SESSION_PROMPT：定义出题、判定与变式巩固闭环", () => {
    expect(QUIZ_SESSION_PROMPT).toContain("出题与即时判定模式");
    expect(QUIZ_SESSION_PROMPT).toContain("1~3 道具有代表性的题目");
    expect(QUIZ_SESSION_PROMPT).toContain("严禁在出题阶段剧透答案");
  });

  it("工具使用指南归插件工具贡献（不写进教学提示词）", () => {
    // CR-060：模型侧工具指南经 PluginToolContribution.guidance 注入内核 customGuidance，
    // 教学提示词只描述教学法，不复述工具名与参数约束（避免两处漂移）。
    expect(QUIZ_SESSION_PROMPT).not.toContain("record_practice_attempt");
    expect(FOCUS_MODE_SYSTEM_PROMPT).not.toContain("record_practice_attempt");
  });
});
