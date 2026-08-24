import { describe, expect, it } from "vitest";
import { strToU8, unzipSync } from "fflate";
import { exportPersonaBundle, InMemoryPersonaRepository, previewPersonaBundle } from "../src/index.js";
import { checksumBytes, createSkillsZip, parseSkillZip, type SkillRecord } from "@aervox/skill-runtime";

const skill = (name: string): SkillRecord => {
  const markdown = `---\nname: ${name}\ndescription: ${name} description\n---\n\nbody`;
  const files = { "SKILL.md": strToU8(markdown), "assets/icon.txt": strToU8("icon") };
  const checksum = checksumBytes(new Uint8Array(Buffer.concat(Object.keys(files).sort().map((path) => Buffer.concat([Buffer.from(path), Buffer.from("\0"), Buffer.from(files[path]!), Buffer.from("\0")])))));
  return { id: name, workspaceId: "w", name, description: `${name} description`, source: "workspace", version: 1, checksum, enabled: true, valid: true, validationErrors: [], files, skillMarkdown: markdown, importedAt: new Date().toISOString() };
};

describe("Persona bundles", () => {
  it("exports the actual effective Skill set and imports it", () => {
    const repo = new InMemoryPersonaRepository();
    const { persona, revision } = repo.create({ workspaceId: "w", subjectUserId: "u", name: "Tutor", config: { systemPromptAppend: "Be concise", allowedSkillNames: ["alpha"] } });
    const bundle = exportPersonaBundle({ persona, revision, activeSkills: [], workspaceSkills: [skill("alpha"), skill("beta")] });
    const files = unzipSync(bundle);
    const exportedSkills = parseSkillZip(files["skills/skills.zip"]!, { workspaceId: "w" });
    expect(exportedSkills.map((item) => item.name)).toEqual(["alpha"]);
    const preview = previewPersonaBundle(bundle, "w");
    expect(preview.missingDependencies).toEqual([]);
    expect(preview.revision.config.systemPromptAppend).toBe("Be concise");
  });
  it("exports all Skills when the persona list is undefined and none when empty", () => {
    const repo = new InMemoryPersonaRepository();
    const a = repo.create({ workspaceId: "w", subjectUserId: "u", name: "All", config: { systemPromptAppend: "x" } });
    const all = exportPersonaBundle({ persona: a.persona, revision: a.revision, activeSkills: [], workspaceSkills: [skill("a"), skill("b")] });
    expect(parseSkillZip(unzipSync(all)["skills/skills.zip"]!, { workspaceId: "w" })).toHaveLength(2);
    const noneCreated = repo.create({ workspaceId: "w", subjectUserId: "u", name: "None", config: { systemPromptAppend: "x", allowedSkillNames: [] } });
    const none = exportPersonaBundle({ persona: noneCreated.persona, revision: noneCreated.revision, activeSkills: [], workspaceSkills: [skill("a"), skill("b")] });
    expect(Object.keys(unzipSync(none))).toContain("skills/skills.zip");
    expect(parseSkillZip(unzipSync(none)["skills/skills.zip"]!, { workspaceId: "w" })).toHaveLength(0);
  });
});
