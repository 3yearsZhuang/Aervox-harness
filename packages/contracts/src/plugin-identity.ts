/** Stable ecosystem names are separate from package versions and storage paths. */
import { z } from "zod";

export const PLUGIN_CATEGORIES = ["tool", "bot", "ui", "proactive", "sync", "workflow", "theme"] as const;
export const pluginCategorySchema = z.enum(PLUGIN_CATEGORIES);
export type PluginCategory = z.infer<typeof pluginCategorySchema>;
export const PLUGIN_ECOSYSTEM_ID_PATTERN = /^ap-(tool|bot|ui|proactive|sync|workflow|theme)-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isStandardPluginId(id: string): boolean {
  return id.length <= 64 && PLUGIN_ECOSYSTEM_ID_PATTERN.test(id);
}

export const pluginEcosystemIdSchema = z.string().max(64).refine(isStandardPluginId, {
  message: "Plugin id must be ap-<category>-<kebab-case-slug>",
});

/** Legacy logical names remain readable. Namespaced names are encoded before disk access. */
export function isPluginSkillName(name: string): boolean {
  if (!name || name.length > 128) return false;
  const parts = name.split(":");
  if (parts.length > 2) return false;
  return parts.every(part => /^(?!\.{1,2}$)[\w.-]+$/.test(part)
    && !part.endsWith(".") && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

/** Percent is forbidden in logical names, so this encoding cannot collide with a legacy name. */
export function pluginSkillDirectoryName(name: string): string {
  if (!isPluginSkillName(name)) throw new Error("Invalid skill name");
  return name.replace(":", "%3A");
}

/** Recognize only canonical storage encoding; never decode arbitrary path escapes. */
export function pluginSkillNameFromDirectoryName(directory: string): string | null {
  const name = directory.replace("%3A", ":");
  return isPluginSkillName(name) && pluginSkillDirectoryName(name) === directory ? name : null;
}
