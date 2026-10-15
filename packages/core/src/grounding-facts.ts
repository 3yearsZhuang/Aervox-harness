/**
 * Aervox｜思隅 @aervox/core — 伴学保真事实清单（ITER-032）
 *
 * 伴学模型可见上下文从权威历史重建，首要保障关键伴学事实清单保真：
 * 包含当前学习目标、未解决错因、用户偏好与对用户的承诺及来源。
 * 在上下文压缩或滑动窗口裁剪发生时，事实清单绝对保真，不受消息省略影响。
 */
import type { ContextBuilderPort } from "./ports.js";
import type { GroundingFactItem, GroundingFacts, PromptContext, PromptMessage } from "./types.js";
import { defaultContextBuilder } from "./context-builder.js";

function formatFactItem(item: string | GroundingFactItem): string {
  if (typeof item === "string") {
    return `- ${item.trim()}`;
  }
  const text = item.text.trim();
  if (item.source && item.source.trim()) {
    return `- ${text} (来源: ${item.source.trim()})`;
  }
  return `- ${text}`;
}

function formatSection(title: string, items?: (string | GroundingFactItem)[]): string[] {
  if (!items || items.length === 0) return [];
  const lines = items.map(formatFactItem).filter(Boolean);
  if (lines.length === 0) return [];
  return [`### ${title}`, ...lines, ""];
}

/**
 * 格式化伴学保真事实清单提示词。
 * 若无有效事实项，返回空字符串。
 */
export function buildGroundingFactsPrompt(facts?: GroundingFacts): string {
  if (!facts) return "";

  const sections: string[] = [];

  const goals = formatSection("当前学习目标 (Learning Goals)", facts.learningGoals);
  if (goals.length > 0) sections.push(...goals);

  const mistakes = formatSection("未解决错因与误区 (Unresolved Mistakes)", facts.unresolvedMistakes);
  if (mistakes.length > 0) sections.push(...mistakes);

  const prefs = formatSection("用户持久偏好 (User Preferences)", facts.userPreferences);
  if (prefs.length > 0) sections.push(...prefs);

  const commitments = formatSection("承诺与待办 (Commitments)", facts.commitments);
  if (commitments.length > 0) sections.push(...commitments);

  if (facts.customSections) {
    for (const custom of facts.customSections) {
      const customLines = formatSection(custom.title, custom.items);
      if (customLines.length > 0) sections.push(...customLines);
    }
  }

  if (sections.length === 0) return "";

  return [
    "## 伴学保真事实清单 (Authoritative Grounding Facts)",
    "以下为当前会话已确认的权威事实。无论历史消息如何裁剪或压缩，均必须作为已知事实严格遵循：",
    "",
    ...sections,
  ].join("\n").trim();
}

/**
 * 创建保真事实清单 ContextBuilder。
 * 将保真事实清单作为 system 消息前置注入。
 */
export function createGroundingFactsContextBuilder(
  facts: GroundingFacts,
  base: ContextBuilderPort = defaultContextBuilder,
): ContextBuilderPort {
  const promptText = buildGroundingFactsPrompt(facts);
  if (!promptText) return base;

  return {
    build(input: Parameters<ContextBuilderPort["build"]>[0]): PromptContext | Promise<PromptContext> {
      const messages: PromptMessage[] = [
        { role: "system" as const, content: promptText },
        ...input.messages,
      ];
      return base.build({ ...input, messages });
    },
  };
}
