/**
 * Aervox｜思隅 @aervox/api — Skill 渐进式披露提示词构建（CAP-020）
 *
 * 规则依据：reference/AstrBot astrbot/core/skills/skill_manager.py build_skills_prompt。
 * 原则：系统提示词仅注入技能「名称 + 描述」，模型决定使用某技能时再按需读取
 * SKILL.md 全文（渐进式披露，省上下文 token）。
 */
import type { SkillRegistrationModel } from "@aervox/database";

export interface SkillPromptEntry {
  name: string;
  description: string;
}

/**
 * 由注册表条目构建技能清单提示词段。
 * 读取方式按 Aervox 运行时形态：GET /v1/skills/:name/content 返回 SKILL.md 全文。
 */
export function buildSkillsPrompt(skills: SkillPromptEntry[]): string {
  if (skills.length === 0) return "";

  const lines = skills.map(
    (skill) =>
      `- **${skill.name}**: ${skill.description || "Read SKILL.md for details."}`,
  );

  return [
    "## Skills",
    "",
    "You have specialized skills — reusable instruction bundles stored in `SKILL.md`",
    "files. Each skill has a **name** and a **description** that tells you what it",
    "does and when to use it.",
    "",
    "### Available skills",
    "",
    ...lines,
    "",
    "### Skill rules",
    "",
    "1. **Discovery** — The list above is the complete skill inventory for this",
    "   session. Full instructions live in the referenced `SKILL.md` file.",
    "2. **When to trigger** — Use a skill if the user names it explicitly, or if the",
    "   task clearly matches the skill's description. Never silently skip a matching",
    "   skill — either use it or briefly explain why you chose not to.",
    "3. **Mandatory grounding** — Before executing any skill you MUST first fetch its",
    "   `SKILL.md` via `GET /v1/skills/:name/content`. Never rely on memory or",
    "   assumptions about a skill's content.",
    "4. **Progressive disclosure** — Load only what is directly referenced from",
    "   `SKILL.md`. If `scripts/` or `assets/` exist, reuse them over rewriting.",
    "5. **Coordination** — When multiple skills apply, pick the minimal set needed.",
    "   Announce which skill(s) you are using and why (one short line).",
    "6. **Failure handling** — If a skill cannot be applied, state the issue clearly",
    "   and continue with the best alternative.",
    "",
  ].join("\n");
}
