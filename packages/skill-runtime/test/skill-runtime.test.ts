import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  buildSkillsPrompt,
  createSkillsZip,
  enumerateAvailableSkills,
  filterSkills,
  parseSkillZip,
  type SkillRecord,
} from "../src/index.js";

function skill(name: string, source: "active" | "workspace" = "workspace"): SkillRecord {
  const markdown = `---\nname: ${name}\ndescription: ${name} skill\n---\n\nUse ${name} when relevant.`;
  return {
    id: `id-${name}`,
    workspaceId: "w",
    name,
    description: `${name} skill`,
    source,
    version: 1,
    checksum: "a".repeat(64),
    enabled: true,
    valid: true,
    validationErrors: [],
    files: { "SKILL.md": strToU8(markdown), "references/guide.md": strToU8("guide") },
    skillMarkdown: markdown,
    importedAt: new Date().toISOString(),
  };
}

describe("Anthropic Skills runtime", () => {
  it("enumerates workspace definitions over active definitions", () => {
    const result = enumerateAvailableSkills([skill("shared", "active"), skill("active")], [skill("shared"), skill("workspace")]);
    expect(result.map((item) => item.name)).toEqual(["active", "shared", "workspace"]);
    expect(result.find((item) => item.name === "shared")?.source).toBe("workspace");
  });

  it("implements undefined, empty, and allowlist Skill filtering", () => {
    const skills = [skill("a"), skill("b")];
    expect(filterSkills(skills, undefined)).toHaveLength(2);
    expect(filterSkills(skills, [])).toHaveLength(0);
    expect(filterSkills(skills, ["b"])).toEqual([skills[1]]);
  });

  it("validates and round trips standard Skill ZIPs", () => {
    const source = skill("demo");
    const zip = createSkillsZip([source]);
    const parsed = parseSkillZip(zip, { workspaceId: "w" });
    expect(parsed[0]?.name).toBe("demo");
    expect(parsed[0]?.files["references/guide.md"]).toBeDefined();
    expect(buildSkillsPrompt(parsed)).toContain("demo: demo skill");
  });

  it("rejects malformed Skill frontmatter", () => {
    const zip = zipSync({ "bad/SKILL.md": strToU8("---\nname: Bad Name\ndescription: x\n---\n\nbody") });
    expect(() => parseSkillZip(zip, { workspaceId: "w" })).toThrow(/validation failed/i);
  });
});
