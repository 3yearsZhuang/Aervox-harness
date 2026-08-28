/**
 * Aervox｜思隅 @aervox/api — 系统级 Persona Bundle 导入导出
 */
import { createHash } from "node:crypto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { TenantContext, SqlitePersonaRepository, SkillRegistrationModel } from "@aervox/database";
import type { SkillManager } from "../skills/skill-manager.js";
import {
  assertNonEmpty,
  computeRevisionChecksum,
  PERSONA_SCHEMA_VERSION,
  validatePersonaConfig,
  type Persona,
  type PersonaBundleExportResult,
  type PersonaBundleImportPreview,
  type PersonaBundleManifest,
  type PersonaRevision,
  type PersonaSource,
} from "./types.js";

function readJsonFile(files: Record<string, Uint8Array>, path: string): unknown {
  const file = files[path];
  if (!file) throw new Error(`Missing ${path} in bundle`);
  return JSON.parse(strFromU8(file));
}

export async function exportPersonaBundle(input: {
  persona: Persona;
  revision: PersonaRevision;
  skillManager: SkillManager;
  availableToolIds?: string[];
  availableVoiceProviderIds?: string[];
}): Promise<PersonaBundleExportResult> {
  const allActiveSkills = await input.skillManager.listSkills(true);
  const allowed = input.revision.config.allowedSkillNames
    ? new Set(input.revision.config.allowedSkillNames)
    : null;
  const targetSkills = allowed
    ? allActiveSkills.filter((s) => allowed.has(s.name))
    : allActiveSkills;

  const skillZipFiles: Record<string, Uint8Array> = {};
  const manifestSkills: PersonaBundleManifest["skills"] = [];
  const missingDependencies: string[] = [];

  for (const skill of targetSkills) {
    const folderFiles = await input.skillManager.readSkillFolderFiles(skill.name);
    if (folderFiles && folderFiles.length > 0) {
      for (const file of folderFiles) {
        skillZipFiles[`${skill.name}/${file.relativePath}`] = new Uint8Array(file.data);
      }
    } else {
      // 如果文件夹未找到，尝试使用 content
      const content = await input.skillManager.readSkillMarkdown(skill.name);
      if (content) {
        skillZipFiles[`${skill.name}/SKILL.md`] = strToU8(content.content);
      }
    }
    manifestSkills.push({
      name: skill.name,
      version: 1,
      checksum: skill.checksum ?? createHash("sha256").update(skill.name).digest("hex"),
      source: skill.source,
      exported: true,
    });
  }

  // 检查缺失的技能依赖
  if (input.revision.config.allowedSkillNames) {
    const targetNames = new Set(targetSkills.map((s) => s.name));
    for (const name of input.revision.config.allowedSkillNames) {
      if (!targetNames.has(name)) {
        missingDependencies.push(`skill:${name}`);
      }
    }
  }

  // 检查缺失的工具依赖
  if (input.availableToolIds && input.revision.config.allowedMcpToolIds) {
    const toolSet = new Set(input.availableToolIds);
    for (const id of input.revision.config.allowedMcpToolIds) {
      if (!toolSet.has(id)) {
        missingDependencies.push(`tool:${id}`);
      }
    }
  }

  // 检查缺失的语音依赖
  const voiceProviderId = input.revision.config.voice?.providerId;
  if (
    voiceProviderId &&
    input.availableVoiceProviderIds &&
    !input.availableVoiceProviderIds.includes(voiceProviderId)
  ) {
    missingDependencies.push(`voice:${voiceProviderId}`);
  }

  const manifest: PersonaBundleManifest = {
    schemaVersion: PERSONA_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    personaId: input.persona.id,
    personaRevisionId: input.revision.id,
    personaChecksum: input.revision.checksum,
    skills: manifestSkills,
    missingDependencies: [...new Set(missingDependencies)],
  };

  const personaJson = {
    schemaVersion: PERSONA_SCHEMA_VERSION,
    name: input.persona.name,
    description: input.persona.description,
    source: input.persona.source,
    config: input.revision.config,
  };

  const skillZip = zipSync(skillZipFiles, { level: 6 });
  const bundleBytes = zipSync(
    {
      "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
      "persona.json": strToU8(JSON.stringify(personaJson, null, 2)),
      "skills/skills.zip": skillZip,
    },
    { level: 6 },
  );

  return {
    bytes: bundleBytes,
    manifest,
    skillNames: targetSkills.map((s) => s.name),
    missingDependencies: manifest.missingDependencies,
  };
}

export function previewPersonaBundle(
  bytes: Uint8Array,
  workspaceId: string,
): PersonaBundleImportPreview {
  const files = unzipSync(bytes);
  const manifest = readJsonFile(files, "manifest.json") as PersonaBundleManifest;
  const personaJson = readJsonFile(files, "persona.json") as {
    schemaVersion: number;
    name: string;
    description?: string;
    source?: PersonaSource;
    config: Persona["status"] extends string ? Parameters<typeof validatePersonaConfig>[0] : never;
  };

  if (
    manifest.schemaVersion !== PERSONA_SCHEMA_VERSION ||
    personaJson.schemaVersion !== PERSONA_SCHEMA_VERSION
  ) {
    throw new Error("UNSUPPORTED_PERSONA_BUNDLE_VERSION");
  }

  const normalizedConfig = validatePersonaConfig(personaJson.config);
  if (manifest.personaChecksum !== computeRevisionChecksum(normalizedConfig)) {
    throw new Error("PERSONA_BUNDLE_PERSONA_CHECKSUM_MISMATCH");
  }

  const skillZipBytes = files["skills/skills.zip"];
  const previewSkills: Array<{ name: string; description: string; checksum: string; version: number }> =
    [];

  if (skillZipBytes) {
    const unzippedSkills = unzipSync(skillZipBytes);
    const skillNames = new Set(
      Object.keys(unzippedSkills).map((k) => k.split("/")[0]).filter(Boolean),
    );
    for (const name of skillNames) {
      const manifestEntry = manifest.skills?.find((s) => s.name === name);
      previewSkills.push({
        name: name!,
        description: `Imported skill: ${name}`,
        checksum: manifestEntry?.checksum ?? "",
        version: manifestEntry?.version ?? 1,
      });
    }
  }

  return {
    persona: {
      workspaceId,
      subjectUserId: "",
      name: assertNonEmpty(personaJson.name, "name"),
      description: personaJson.description ?? "",
      source: "imported",
      status: "active",
      reviewStatus: "draft",
      reviewNotes: "",
      reviewedAt: null,
    },
    revision: {
      revision: 1,
      config: normalizedConfig,
      checksum: computeRevisionChecksum(normalizedConfig),
    },
    skills: previewSkills,
    manifest,
    missingDependencies: manifest.missingDependencies ?? [],
  };
}

export async function importPersonaBundle(input: {
  bytes: Uint8Array;
  tenant: TenantContext;
  personaRepo: SqlitePersonaRepository;
  skillManager: SkillManager;
  conflictResolution?: "error" | "replace";
}): Promise<{
  persona: Persona;
  revision: PersonaRevision;
  skills: SkillRegistrationModel[];
  missingDependencies: string[];
}> {
  const files = unzipSync(input.bytes);
  const preview = previewPersonaBundle(input.bytes, input.tenant.workspaceId);
  const skillZipBytes = files["skills/skills.zip"];
  let installedSkills: SkillRegistrationModel[] = [];

  if (skillZipBytes && skillZipBytes.length > 0) {
    if (input.conflictResolution === "replace") {
      installedSkills = await input.skillManager.installFromZip(Buffer.from(skillZipBytes), {
        overwrite: true,
      });
    } else {
      try {
        installedSkills = await input.skillManager.installFromZip(Buffer.from(skillZipBytes), {
          overwrite: false,
        });
      } catch (err) {
        // 如果同名技能已存在且 checksum 相同，复用既有技能注册
        const existingSkills: SkillRegistrationModel[] = [];
        let allMatched = preview.skills.length > 0;
        for (const s of preview.skills) {
          const existing = await input.skillManager.getSkill(s.name);
          if (existing && (!s.checksum || existing.checksum === s.checksum)) {
            existingSkills.push(existing);
          } else {
            allMatched = false;
            break;
          }
        }
        if (allMatched && existingSkills.length === preview.skills.length) {
          installedSkills = existingSkills;
        } else {
          throw err;
        }
      }
    }
  }

  const created = await input.personaRepo.createPersona(input.tenant, {
    id: `persona_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name: preview.persona.name,
    description: preview.persona.description,
    source: "imported",
    config: preview.revision.config,
    checksum: preview.revision.checksum,
  });

  return {
    persona: {
      id: created.persona.id,
      workspaceId: created.persona.workspaceId,
      subjectUserId: created.persona.subjectUserId,
      name: created.persona.name,
      description: created.persona.description,
      source: created.persona.source as PersonaSource,
      status: created.persona.status as Persona["status"],
      reviewStatus: created.persona.reviewStatus as Persona["reviewStatus"],
      reviewNotes: created.persona.reviewNotes,
      reviewedAt: created.persona.reviewedAt ?? null,
      currentRevisionId: created.persona.currentRevisionId,
      createdAt: created.persona.createdAt,
      updatedAt: created.persona.updatedAt,
    },
    revision: {
      id: created.revision.id,
      personaId: created.revision.personaId,
      revision: created.revision.revision,
      config: created.revision.config as PersonaRevision["config"],
      checksum: created.revision.checksum,
      createdAt: created.revision.createdAt,
    },
    skills: installedSkills,
    missingDependencies: preview.missingDependencies,
  };
}
