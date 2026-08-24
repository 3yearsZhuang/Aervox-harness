import { createHash, randomUUID } from "node:crypto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  createSkillsManifest,
  createSkillsZip,
  enumerateAvailableSkills,
  filterSkills,
  parseSkillZip,
  unzipSafe,
  type SkillRecord,
} from "@aervox/skill-runtime";

export const PERSONA_SCHEMA_VERSION = 1;

export type PersonaSource = "builtin" | "user_created" | "imported";
export type PersonaStatus = "active" | "archived";
export type VoiceSelection = {
  enabled: boolean;
  providerId: string;
  modelId: string;
  speakerId?: string;
  settings?: Record<string, string | number | boolean>;
};

export type PersonaRevisionConfig = {
  systemPromptAppend: string;
  allowedSkillNames?: string[];
  allowedMcpToolIds?: string[];
  voice?: VoiceSelection;
};

export type Persona = {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  name: string;
  description: string;
  source: PersonaSource;
  status: PersonaStatus;
  currentRevisionId: string;
  createdAt: string;
  updatedAt: string;
};

export type PersonaRevision = {
  id: string;
  personaId: string;
  revision: number;
  config: PersonaRevisionConfig;
  checksum: string;
  createdAt: string;
};

export type ActivePersonaSelection = {
  workspaceId: string;
  subjectUserId: string;
  personaId: string;
  revisionId: string;
  selectedAt: string;
};

export type PersonaContextSnapshot = {
  personaId: string;
  revisionId: string;
  revisionChecksum: string;
  promptChecksum: string;
  skillChecksums: string[];
  mcpToolIds: string[];
  voice?: VoiceSelection;
  createdAt: string;
};

export type PersonaBundleManifest = {
  schemaVersion: number;
  exportedAt: string;
  personaId: string;
  personaRevisionId: string;
  personaChecksum: string;
  skills: ReturnType<typeof createSkillsManifest>["skills"];
  missingDependencies: string[];
};

export type PersonaBundleExportResult = {
  bytes: Uint8Array;
  manifest: PersonaBundleManifest;
  skillNames: string[];
  missingDependencies: string[];
};

export type PersonaBundleImportPreview = {
  persona: Omit<Persona, "id" | "currentRevisionId" | "createdAt" | "updatedAt">;
  revision: Omit<PersonaRevision, "id" | "personaId" | "createdAt">;
  skills: SkillRecord[];
  manifest: PersonaBundleManifest;
  missingDependencies: string[];
};

export type PersonaRepository = {
  list(workspaceId: string, subjectUserId: string): Persona[];
  get(workspaceId: string, subjectUserId: string, personaId: string): Persona | undefined;
  getRevision(personaId: string, revisionId?: string): PersonaRevision | undefined;
  create(input: CreatePersonaInput): { persona: Persona; revision: PersonaRevision };
  update(input: UpdatePersonaInput): { persona: Persona; revision: PersonaRevision } | undefined;
  delete(workspaceId: string, subjectUserId: string, personaId: string): boolean;
  activate(workspaceId: string, subjectUserId: string, personaId: string, revisionId?: string): ActivePersonaSelection | undefined;
  active(workspaceId: string, subjectUserId: string): ActivePersonaSelection | undefined;
};

export type CreatePersonaInput = {
  workspaceId: string;
  subjectUserId: string;
  name: string;
  description?: string;
  source?: PersonaSource;
  config: PersonaRevisionConfig;
};

export type UpdatePersonaInput = {
  workspaceId: string;
  subjectUserId: string;
  personaId: string;
  expectedRevision: number;
  name?: string;
  description?: string;
  config: PersonaRevisionConfig;
};

function assertNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  return normalized;
}

function validateConfig(config: PersonaRevisionConfig): PersonaRevisionConfig {
  const systemPromptAppend = assertNonEmpty(config.systemPromptAppend, "systemPromptAppend");
  if (systemPromptAppend.length > 32_000) throw new Error("systemPromptAppend is too long");
  const normalizeList = (values: string[] | undefined, field: string): string[] | undefined => {
    if (values === undefined) return undefined;
    const normalized = [...new Set(values.map((value) => assertNonEmpty(value, field)))];
    return normalized;
  };
  return {
    systemPromptAppend,
    ...(config.allowedSkillNames !== undefined
      ? { allowedSkillNames: normalizeList(config.allowedSkillNames, "allowedSkillNames") }
      : {}),
    ...(config.allowedMcpToolIds !== undefined
      ? { allowedMcpToolIds: normalizeList(config.allowedMcpToolIds, "allowedMcpToolIds") }
      : {}),
    ...(config.voice ? { voice: { ...config.voice } } : {}),
  };
}

function revisionChecksum(config: PersonaRevisionConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export function createPersonaContextSnapshot(input: {
  persona: Persona;
  revision: PersonaRevision;
  skills: readonly SkillRecord[];
  mcpToolIds: readonly string[];
}): PersonaContextSnapshot {
  return {
    personaId: input.persona.id,
    revisionId: input.revision.id,
    revisionChecksum: input.revision.checksum,
    promptChecksum: createHash("sha256").update(input.revision.config.systemPromptAppend).digest("hex"),
    skillChecksums: input.skills.map((skill) => skill.checksum),
    mcpToolIds: [...input.mcpToolIds],
    ...(input.revision.config.voice ? { voice: { ...input.revision.config.voice } } : {}),
    createdAt: new Date().toISOString(),
  };
}

export class InMemoryPersonaRepository implements PersonaRepository {
  readonly #personas = new Map<string, Persona>();
  readonly #revisions = new Map<string, PersonaRevision[]>();
  readonly #active = new Map<string, ActivePersonaSelection>();

  list(workspaceId: string, subjectUserId: string): Persona[] {
    return [...this.#personas.values()]
      .filter((persona) => persona.workspaceId === workspaceId && persona.subjectUserId === subjectUserId && persona.status !== "archived")
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  get(workspaceId: string, subjectUserId: string, personaId: string): Persona | undefined {
    const persona = this.#personas.get(personaId);
    return persona && persona.workspaceId === workspaceId && persona.subjectUserId === subjectUserId ? persona : undefined;
  }

  getRevision(personaId: string, revisionId?: string): PersonaRevision | undefined {
    const revisions = this.#revisions.get(personaId) ?? [];
    return revisionId ? revisions.find((revision) => revision.id === revisionId) : revisions.at(-1);
  }

  create(input: CreatePersonaInput): { persona: Persona; revision: PersonaRevision } {
    const name = assertNonEmpty(input.name, "name");
    const now = new Date().toISOString();
    const personaId = `persona_${randomUUID()}`;
    const revision = this.createRevision(personaId, 1, input.config, now);
    const persona: Persona = {
      id: personaId,
      workspaceId: assertNonEmpty(input.workspaceId, "workspaceId"),
      subjectUserId: assertNonEmpty(input.subjectUserId, "subjectUserId"),
      name,
      description: input.description?.trim() ?? "",
      source: input.source ?? "user_created",
      status: "active",
      currentRevisionId: revision.id,
      createdAt: now,
      updatedAt: now,
    };
    this.#personas.set(persona.id, persona);
    this.#revisions.set(persona.id, [revision]);
    return { persona, revision };
  }

  update(input: UpdatePersonaInput): { persona: Persona; revision: PersonaRevision } | undefined {
    const existing = this.get(input.workspaceId, input.subjectUserId, input.personaId);
    if (!existing) return undefined;
    const revisions = this.#revisions.get(existing.id) ?? [];
    if (revisions.at(-1)?.revision !== input.expectedRevision) {
      throw new Error("PERSONA_REVISION_CONFLICT");
    }
    const now = new Date().toISOString();
    const revision = this.createRevision(existing.id, input.expectedRevision + 1, input.config, now);
    const persona: Persona = {
      ...existing,
      ...(input.name !== undefined ? { name: assertNonEmpty(input.name, "name") } : {}),
      ...(input.description !== undefined ? { description: input.description.trim() } : {}),
      currentRevisionId: revision.id,
      updatedAt: now,
    };
    this.#personas.set(persona.id, persona);
    this.#revisions.set(existing.id, [...revisions, revision]);
    return { persona, revision };
  }

  delete(workspaceId: string, subjectUserId: string, personaId: string): boolean {
    const persona = this.get(workspaceId, subjectUserId, personaId);
    if (!persona) return false;
    this.#personas.set(personaId, { ...persona, status: "archived", updatedAt: new Date().toISOString() });
    const activeKey = `${workspaceId}:${subjectUserId}`;
    if (this.#active.get(activeKey)?.personaId === personaId) this.#active.delete(activeKey);
    return true;
  }

  activate(workspaceId: string, subjectUserId: string, personaId: string, revisionId?: string): ActivePersonaSelection | undefined {
    const persona = this.get(workspaceId, subjectUserId, personaId);
    if (!persona || persona.status === "archived") return undefined;
    const revision = this.getRevision(personaId, revisionId ?? persona.currentRevisionId);
    if (!revision) return undefined;
    const selection: ActivePersonaSelection = {
      workspaceId,
      subjectUserId,
      personaId,
      revisionId: revision.id,
      selectedAt: new Date().toISOString(),
    };
    this.#active.set(`${workspaceId}:${subjectUserId}`, selection);
    return selection;
  }

  active(workspaceId: string, subjectUserId: string): ActivePersonaSelection | undefined {
    return this.#active.get(`${workspaceId}:${subjectUserId}`);
  }

  private createRevision(personaId: string, revision: number, config: PersonaRevisionConfig, createdAt: string): PersonaRevision {
    const normalized = validateConfig(config);
    return {
      id: `personarev_${randomUUID()}`,
      personaId,
      revision,
      config: normalized,
      checksum: revisionChecksum(normalized),
      createdAt,
    };
  }
}

function readJsonFile(files: Record<string, Uint8Array>, path: string): unknown {
  const bytes = files[path];
  if (!bytes) throw new Error(`Bundle file is missing: ${path}`);
  return JSON.parse(strFromU8(bytes)) as unknown;
}


export function exportPersonaBundleDetails(input: {
  persona: Persona;
  revision: PersonaRevision;
  activeSkills: readonly SkillRecord[];
  workspaceSkills: readonly SkillRecord[];
  availableMcpToolIds?: readonly string[];
  availableVoiceProviderIds?: readonly string[];
}): PersonaBundleExportResult {
  const allSkills = enumerateAvailableSkills(input.activeSkills, input.workspaceSkills);
  const skills = filterSkills(allSkills, input.revision.config.allowedSkillNames);
  const missingDependencies: string[] = [];
  if (input.revision.config.allowedSkillNames !== undefined) {
    const availableNames = new Set(allSkills.map((skill) => skill.name));
    for (const name of input.revision.config.allowedSkillNames) {
      if (!availableNames.has(name)) missingDependencies.push(`skill:${name}`);
    }
  }
  for (const id of input.revision.config.allowedMcpToolIds ?? []) {
    if (input.availableMcpToolIds && !input.availableMcpToolIds.includes(id)) missingDependencies.push(`mcp:${id}`);
  }
  const providerId = input.revision.config.voice?.providerId;
  if (providerId && input.availableVoiceProviderIds && !input.availableVoiceProviderIds.includes(providerId)) {
    missingDependencies.push(`voice:${providerId}`);
  }
  const manifest: PersonaBundleManifest = {
    schemaVersion: PERSONA_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    personaId: input.persona.id,
    personaRevisionId: input.revision.id,
    personaChecksum: input.revision.checksum,
    skills: createSkillsManifest(skills).skills,
    missingDependencies: [...new Set(missingDependencies)],
  };
  const personaJson = {
    schemaVersion: PERSONA_SCHEMA_VERSION,
    name: input.persona.name,
    description: input.persona.description,
    source: input.persona.source,
    config: input.revision.config,
  };
  const skillZip = createSkillsZip(skills);
  return {
    bytes: zipSync({
      "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
      "persona.json": strToU8(JSON.stringify(personaJson, null, 2)),
      "skills/skills.zip": skillZip,
    }, { level: 6 }),
    manifest,
    skillNames: skills.map((skill) => skill.name),
    missingDependencies: manifest.missingDependencies,
  };
}

export function exportPersonaBundle(input: Parameters<typeof exportPersonaBundleDetails>[0]): Uint8Array {
  return exportPersonaBundleDetails(input).bytes;
}

export function previewPersonaBundle(bytes: Uint8Array, workspaceId: string): PersonaBundleImportPreview {
  const files = unzipSafe(bytes);
  const manifest = readJsonFile(files, "manifest.json") as PersonaBundleManifest;
  const personaJson = readJsonFile(files, "persona.json") as {
    schemaVersion: number;
    name: string;
    description?: string;
    source?: PersonaSource;
    config: PersonaRevisionConfig;
  };
  if (manifest.schemaVersion !== PERSONA_SCHEMA_VERSION || personaJson.schemaVersion !== PERSONA_SCHEMA_VERSION) {
    throw new Error("UNSUPPORTED_PERSONA_BUNDLE_VERSION");
  }
  const normalizedConfig = validateConfig(personaJson.config);
  if (manifest.personaChecksum !== revisionChecksum(normalizedConfig)) {
    throw new Error("PERSONA_BUNDLE_PERSONA_CHECKSUM_MISMATCH");
  }
  const skillZip = files["skills/skills.zip"];
  const skills = skillZip ? parseSkillZip(skillZip, { workspaceId, source: "imported" }) : [];
  if (!Array.isArray(manifest.skills) || !Array.isArray(manifest.missingDependencies)) {
    throw new Error("INVALID_PERSONA_BUNDLE_MANIFEST");
  }
  const skillByName = new Map(skills.map((skill) => [skill.name, skill]));
  for (const entry of manifest.skills) {
    const skill = skillByName.get(entry.name);
    if (!skill || skill.checksum !== entry.checksum) {
      throw new Error(`PERSONA_BUNDLE_SKILL_CHECKSUM_MISMATCH:${entry.name}`);
    }
  }
  const names = new Set(skills.map((skill) => skill.name));
  const missingDependencies = [...manifest.missingDependencies];
  for (const name of personaJson.config.allowedSkillNames ?? []) {
    if (!names.has(name)) missingDependencies.push(`skill:${name}`);
  }
  return {
    persona: {
      workspaceId,
      subjectUserId: "",
      name: assertNonEmpty(personaJson.name, "name"),
      description: personaJson.description ?? "",
      source: "imported",
      status: "active",
    },
    revision: {
      revision: 1,
      config: normalizedConfig,
      checksum: revisionChecksum(normalizedConfig),
    },
    skills,
    manifest: { ...manifest, missingDependencies: [...new Set(missingDependencies)] },
    missingDependencies: [...new Set(missingDependencies)],
  };
}

export function importPersonaBundle(input: {
  bytes: Uint8Array;
  workspaceId: string;
  subjectUserId: string;
  repository: InMemoryPersonaRepository;
  skillImport: (workspaceId: string, bytes: Uint8Array, conflictResolution?: "error" | "replace") => SkillRecord[];
  conflictResolution?: "error" | "replace";
}): { persona: Persona; revision: PersonaRevision; skills: SkillRecord[]; missingDependencies: string[] } {
  const files = unzipSafe(input.bytes);
  const preview = previewPersonaBundle(input.bytes, input.workspaceId);
  const skillZip = files["skills/skills.zip"];
  const skills = skillZip
    ? input.skillImport(input.workspaceId, skillZip, input.conflictResolution ?? "error")
    : [];
  const created = input.repository.create({
    workspaceId: input.workspaceId,
    subjectUserId: input.subjectUserId,
    name: preview.persona.name,
    description: preview.persona.description,
    source: "imported",
    config: preview.revision.config,
  });
  return { ...created, skills, missingDependencies: preview.missingDependencies };
}

export function personaExportSkillNames(input: {
  revision: PersonaRevision;
  activeSkills: readonly SkillRecord[];
  workspaceSkills: readonly SkillRecord[];
}): string[] {
  return filterSkills(
    enumerateAvailableSkills(input.activeSkills, input.workspaceSkills),
    input.revision.config.allowedSkillNames,
  ).map((skill) => skill.name);
}
