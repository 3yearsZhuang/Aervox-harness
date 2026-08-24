import { createHash } from "node:crypto";
import type { McpPolicyInput, McpPolicyResult, McpTool } from "@aervox/mcp-port";
import { selectMcpTools } from "@aervox/mcp-port";
import type { PersonaRevisionConfig } from "@aervox/persona";
import {
  buildSkillsPrompt,
  enumerateAvailableSkills,
  filterSkills,
  type SkillRecord,
} from "@aervox/skill-runtime";

export type PromptCompositionInput = {
  coreSystemPrompt: string;
  safetyPolicyPrompt: string;
  personaConfig: PersonaRevisionConfig;
  activeSkills: readonly SkillRecord[];
  workspaceSkills: readonly SkillRecord[];
  mcp: Omit<McpPolicyInput, "allowedMcpToolIds" | "tools"> & { tools: readonly McpTool[] };
};

export type PromptCompositionResult = {
  systemPrompt: string;
  skills: SkillRecord[];
  mcp: McpPolicyResult;
  contextVersion: string;
};

export function composeSystemPrompt(input: PromptCompositionInput): PromptCompositionResult {
  const allSkills = enumerateAvailableSkills(input.activeSkills, input.workspaceSkills);
  const skills = filterSkills(allSkills, input.personaConfig.allowedSkillNames);
  const skillsPrompt = buildSkillsPrompt(skills);
  const mcp = selectMcpTools({
    ...input.mcp,
    tools: input.mcp.tools,
    allowedMcpToolIds: input.personaConfig.allowedMcpToolIds,
  });
  const sections = [
    "<core-system-instructions>",
    input.coreSystemPrompt.trim(),
    "</core-system-instructions>",
    "<persona-instructions>",
    input.personaConfig.systemPromptAppend.trim(),
    "</persona-instructions>",
  ];
  if (skillsPrompt) sections.push("<available-skills>", skillsPrompt, "</available-skills>");
  sections.push("<non-overridable-safety-and-data-policy>", input.safetyPolicyPrompt.trim(), "</non-overridable-safety-and-data-policy>");
  const systemPrompt = sections.join("\n\n");
  const contextVersion = createHash("sha256")
    .update(systemPrompt)
    .update(JSON.stringify(mcp.tools.map((tool) => tool.id)))
    .digest("hex");
  return { systemPrompt, skills, mcp, contextVersion };
}
