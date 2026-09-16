/**
 * CR-033 P5 主动回合人格同源测试。
 *
 * 覆盖：
 * - 有 turnContext 时系统人格 = 对话人格管线（personaRevisionId），SKILL.md 降为叠加层；
 * - personaOverlayEnabled=false 时 SKILL.md 仅作为场景提示，不覆盖人格；
 * - crisis 分类走固定安全响应（不调 LLM）；
 * - 无 turnContext 时保留 CR-032 基线行为（SKILL.md 作为人格主体）。
 */
import { describe, expect, it } from "vitest";
import type { ProactiveTurnContext } from "@aervox/contracts";
import {
  buildComposerSystemPrompt,
  buildComposerUserPrompt,
  composeProactiveMessage,
  renderTemplateMessage,
  type ProactiveComposeInput,
} from "../src/proactive/composer.js";

const baseInput: ProactiveComposeInput = {
  tenant: { workspaceId: "ws_p5", subjectUserId: "usr_p5" },
  pluginId: "health-guard",
  pluginName: "健康守护",
  ruleName: "久坐提醒",
  triggerType: "system_state",
  evidence: { summary: "已连续工作 55 分钟", facts: { continuousActiveMinutes: 55 } },
  skillContent: "你是健康守护，说话要像健身教练一样严格。",
  bubblePreset: "firm_nudge",
};

const turnContext: ProactiveTurnContext = {
  version: "proactive_turn_context_v1",
  personaRevisionId: "persona-rev-42",
  personaId: "persona-1",
  personaSystemPrompt: "你是思隅，保持温柔、克制并尊重用户边界。",
  allowedSkills: ["health-guard"],
  memoryReferences: [{ memoryId: "mem-1", scope: "context", policyVersion: "mem-v1" }],
  safety: { policyVersion: "safety-v1", classificationLevel: "normal" },
  untrustedPluginLayer: {
    pluginId: "health-guard",
    skillOverlayJson: "{}",
    personaOverlayEnabled: false,
  },
  localOnly: true,
};

describe("CR-033 P5 proactive persona unification", () => {
  it("有 turnContext 时系统人格以 personaRevisionId 为准，SKILL.md 不覆盖身份", () => {
    const prompt = buildComposerSystemPrompt({ ...baseInput, turnContext });
    expect(prompt).toContain("persona-rev-42");
    // 叠加未开启：SKILL.md 仅作为场景提示，不直接作为人格注入
    expect(prompt).toContain("保持温柔、克制");
    expect(prompt).not.toContain("健身教练");
  });

  it("personaOverlayEnabled=true 时 SKILL.md 作为场景叠加（仍标注不覆盖身份）", () => {
    const ctx = {
      ...turnContext,
      untrustedPluginLayer: {
        pluginId: "health-guard",
        skillOverlayJson: "{}",
        personaOverlayEnabled: true,
      },
    };
    const prompt = buildComposerSystemPrompt({ ...baseInput, turnContext: ctx });
    expect(prompt).not.toContain("健身教练");
    const userPrompt = buildComposerUserPrompt({ ...baseInput, turnContext: ctx });
    expect(userPrompt).toContain("不可信数据");
    expect(userPrompt).toContain("健身教练");
  });

  it("crisis 分类走固定安全响应，不调用 LLM（安全服务不可用即保守拒绝）", async () => {
    const ctx = {
      ...turnContext,
      safety: { policyVersion: "safety-v1", classificationLevel: "crisis" },
    };
    const result = await composeProactiveMessage({
      llmConfigRepo: { getConfig: async () => null } as never,
      input: { ...baseInput, turnContext: ctx },
    });
    expect(result.source).toBe("template");
    expect(result.message).toContain("危机");
  });

  it("无 turnContext 保留 CR-032 基线：SKILL.md 作为人格主体", () => {
    const prompt = buildComposerSystemPrompt(baseInput);
    expect(prompt).toContain("健身教练");
    expect(prompt).not.toContain("persona-rev-42");
  });

  it("crisis 安全响应固定文案不依赖插件提示词", () => {
    const ctx = {
      ...turnContext,
      safety: { policyVersion: "safety-v1", classificationLevel: "crisis" },
    };
    const prompt = buildComposerSystemPrompt({ ...baseInput, turnContext: ctx, skillContent: null });
    expect(prompt).toContain("persona-rev-42");
    expect(prompt).toContain("安全策略版本");
  });

  it("模板降级保留既有行为（renderTemplateMessage 不因 turnContext 改变）", () => {
    expect(renderTemplateMessage(baseInput)).toContain("先停一下手头的事");
    const withCtx = renderTemplateMessage({ ...baseInput, turnContext });
    expect(withCtx).toBe(renderTemplateMessage(baseInput));
  });
});
