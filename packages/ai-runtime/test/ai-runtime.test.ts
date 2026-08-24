import { describe, expect, it } from "vitest";
import { composeSystemPrompt } from "../src/index.js";
import type { SkillRecord } from "@aervox/skill-runtime";
import type { McpTool } from "@aervox/mcp-port";

const makeSkill = (name: string): SkillRecord => ({
  id: name, workspaceId: "w", name, description: `${name} description`, source: "workspace", version: 1, checksum: "a".repeat(64), enabled: true, valid: true, validationErrors: [], files: { "SKILL.md": new TextEncoder().encode("x") }, skillMarkdown: "x", importedAt: new Date().toISOString(),
});
const tool: McpTool = { id: "server:tool", serverId: "server", name: "tool", inputSchema: {}, scopes: [], healthy: true, authorized: true, revoked: false, killSwitch: false };

describe("AI context composition", () => {
  it("appends Persona and filtered Skills while keeping safety last", () => {
    const result = composeSystemPrompt({
      coreSystemPrompt: "core",
      safetyPolicyPrompt: "safety",
      personaConfig: { systemPromptAppend: "persona", allowedSkillNames: ["allowed"], allowedMcpToolIds: undefined },
      activeSkills: [],
      workspaceSkills: [makeSkill("allowed"), makeSkill("other")],
      mcp: { tools: [tool] },
    });
    expect(result.systemPrompt).toContain("persona");
    expect(result.systemPrompt).toContain("allowed description");
    expect(result.systemPrompt).not.toContain("other description");
    expect(result.systemPrompt.indexOf("<non-overridable-safety-and-data-policy>")).toBeGreaterThan(result.systemPrompt.indexOf("persona"));
  });
});
