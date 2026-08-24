/**
 * Anthropic Agent Skills compatible registry and ZIP bundle helpers.
 *
 * Skills are treated as prompt resources. They never grant tool permissions.
 */
import { createHash, randomUUID } from "node:crypto";
import { posix as pathPosix } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { parseDocument } from "yaml";

export const SKILL_BUNDLE_SCHEMA_VERSION = 1;
export const MAX_SKILL_ARCHIVE_BYTES = 25 * 1024 * 1024;
export const MAX_SKILL_FILES = 1_000;
export const MAX_SKILL_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
export const MAX_SKILL_FILE_BYTES = 10 * 1024 * 1024;

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const forbiddenPromptPatterns = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /override\s+(the\s+)?system\s+(prompt|policy|instructions?)/i,
  /bypass\s+(safety|permissions?|authorization)/i,
  /reveal\s+(the\s+)?system\s+prompt/i,
];

export type SkillSource = "active" | "workspace" | "imported";

export type SkillFrontmatter = {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  allowedTools?: string[];
};

export type SkillRecord = {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  allowedTools?: string[];
  source: SkillSource;
  version: number;
  checksum: string;
  enabled: boolean;
  valid: boolean;
  validationErrors: string[];
  files: Record<string, Uint8Array>;
  skillMarkdown: string;
  importedAt: string;
};

export type SkillSummary = Omit<SkillRecord, "files" | "skillMarkdown">;

export type SkillBundleManifestEntry = {
  name: string;
  version: number;
  checksum: string;
  source: SkillSource;
  license?: string;
  exported: boolean;
};

export type SkillBundleManifest = {
  schemaVersion: number;
  exportedAt: string;
  skills: SkillBundleManifestEntry[];
};

export type SkillImportConflict = {
  name: string;
  existingChecksum: string;
  incomingChecksum: string;
};

export class SkillValidationError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = "SkillValidationError";
  }
}

export class SkillConflictError extends Error {
  constructor(readonly conflict: SkillImportConflict) {
    super(`Skill ${conflict.name} already exists with a different checksum`);
    this.name = "SkillConflictError";
  }
}

export function checksumBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function checksumText(value: string): string {
  return checksumBytes(strToU8(value));
}

function normalizeArchivePath(input: string): string {
  const normalized = pathPosix.normalize(input.replaceAll("\\", "/"));
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    throw new SkillValidationError("Unsafe archive path", [input]);
  }
  return normalized.replace(/^\.\//, "");
}

function isZipSymlink(externalFileAttributes: number): boolean {
  return ((externalFileAttributes >>> 16) & 0o170000) === 0o120000;
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  ) >>> 0;
}

/** Parse central-directory metadata before decompression to reject dangerous archives. */
export function validateZipArchive(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_SKILL_ARCHIVE_BYTES) {
    throw new SkillValidationError("Skill ZIP exceeds the compressed size limit", [
      `${bytes.byteLength} > ${MAX_SKILL_ARCHIVE_BYTES}`,
    ]);
  }

  let end = -1;
  const searchStart = Math.max(0, bytes.length - 65_557);
  for (let index = bytes.length - 22; index >= searchStart; index -= 1) {
    if (readUint32(bytes, index) === 0x06054b50) {
      end = index;
      break;
    }
  }
  if (end < 0) {
    throw new SkillValidationError("Invalid ZIP: end-of-central-directory not found", []);
  }

  const entryCount = readUint16(bytes, end + 10);
  const centralDirectorySize = readUint32(bytes, end + 12);
  let cursor = readUint32(bytes, end + 16);
  if (entryCount > MAX_SKILL_FILES) {
    throw new SkillValidationError("Skill ZIP contains too many files", [
      `${entryCount} > ${MAX_SKILL_FILES}`,
    ]);
  }
  if (cursor + centralDirectorySize > bytes.length) {
    throw new SkillValidationError("Invalid ZIP central directory", []);
  }

  let totalUncompressed = 0;
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (readUint32(bytes, cursor) !== 0x02014b50) {
      throw new SkillValidationError("Invalid ZIP central-directory entry", []);
    }
    const compressedSize = readUint32(bytes, cursor + 20);
    const uncompressedSize = readUint32(bytes, cursor + 24);
    const fileNameLength = readUint16(bytes, cursor + 28);
    const extraLength = readUint16(bytes, cursor + 30);
    const commentLength = readUint16(bytes, cursor + 32);
    const externalAttributes = readUint32(bytes, cursor + 38);
    const fileNameStart = cursor + 46;
    const fileName = strFromU8(bytes.subarray(fileNameStart, fileNameStart + fileNameLength));

    normalizeArchivePath(fileName);
    if (isZipSymlink(externalAttributes)) {
      throw new SkillValidationError("Symbolic links are not allowed in Skill ZIPs", [
        fileName,
      ]);
    }
    if (uncompressedSize > MAX_SKILL_FILE_BYTES) {
      throw new SkillValidationError("A Skill ZIP file exceeds the size limit", [fileName]);
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > 200) {
      throw new SkillValidationError("Suspicious ZIP compression ratio", [fileName]);
    }
    totalUncompressed += uncompressedSize;
    cursor = fileNameStart + fileNameLength + extraLength + commentLength;
  }

  if (totalUncompressed > MAX_SKILL_UNCOMPRESSED_BYTES) {
    throw new SkillValidationError("Skill ZIP exceeds the uncompressed size limit", [
      `${totalUncompressed} > ${MAX_SKILL_UNCOMPRESSED_BYTES}`,
    ]);
  }
}

function parseFrontmatter(markdown: string): {
  frontmatter: SkillFrontmatter;
  body: string;
  issues: string[];
} {
  const issues: string[] = [];
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) {
    return {
      frontmatter: { name: "", description: "" },
      body: markdown,
      issues: ["SKILL.md must begin with YAML frontmatter"],
    };
  }

  const normalized = markdown.replaceAll("\r\n", "\n");
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) {
    return {
      frontmatter: { name: "", description: "" },
      body: normalized,
      issues: ["SKILL.md frontmatter is not terminated with ---"],
    };
  }

  const yamlText = normalized.slice(4, closing);
  const body = normalized.slice(closing + 5).trim();
  const document = parseDocument(yamlText, { uniqueKeys: true });
  if (document.errors.length > 0) {
    issues.push(...document.errors.map((error) => error.message));
  }
  const value = document.toJS() as Record<string, unknown> | null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push("SKILL.md frontmatter must be a YAML object");
  }

  const allowedToolsValue = value?.["allowed-tools"] ?? value?.allowedTools;
  const allowedTools = Array.isArray(allowedToolsValue)
    ? allowedToolsValue.filter((item): item is string => typeof item === "string")
    : typeof allowedToolsValue === "string"
      ? allowedToolsValue.split(/\s+/).filter(Boolean)
      : undefined;

  return {
    frontmatter: {
      name: typeof value?.name === "string" ? value.name : "",
      description: typeof value?.description === "string" ? value.description : "",
      ...(typeof value?.license === "string" ? { license: value.license } : {}),
      ...(typeof value?.compatibility === "string"
        ? { compatibility: value.compatibility }
        : {}),
      ...(value?.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
        ? { metadata: value.metadata as Record<string, unknown> }
        : {}),
      ...(allowedTools ? { allowedTools } : {}),
    },
    body,
    issues,
  };
}

function validateSkillDefinition(
  directoryName: string,
  markdown: string,
): { frontmatter: SkillFrontmatter; issues: string[] } {
  const { frontmatter, body, issues } = parseFrontmatter(markdown);
  if (!frontmatter.name) issues.push("frontmatter.name is required");
  if (!frontmatter.description) issues.push("frontmatter.description is required");
  if (frontmatter.name.length > 64) issues.push("frontmatter.name must be at most 64 characters");
  if (frontmatter.description.length > 1_024) {
    issues.push("frontmatter.description must be at most 1024 characters");
  }
  if (frontmatter.name && !skillNamePattern.test(frontmatter.name)) {
    issues.push("frontmatter.name must use lowercase letters, digits, and single hyphens");
  }
  if (frontmatter.name && frontmatter.name !== directoryName) {
    issues.push("frontmatter.name must match its parent directory name");
  }
  if (!body) issues.push("SKILL.md must include instructions after the frontmatter");
  for (const pattern of forbiddenPromptPatterns) {
    if (pattern.test(body)) {
      issues.push(`SKILL.md contains a forbidden policy-override pattern: ${pattern.source}`);
    }
  }
  return { frontmatter, issues };
}

export function calculateSkillChecksum(files: Record<string, Uint8Array>): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(files).sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(files[path]!);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function unzipSafe(bytes: Uint8Array): Record<string, Uint8Array> {
  validateZipArchive(bytes);
  const raw = unzipSync(bytes);
  const files: Record<string, Uint8Array> = {};
  for (const [inputPath, content] of Object.entries(raw)) {
    const path = normalizeArchivePath(inputPath);
    if (path.endsWith("/")) continue;
    files[path] = content;
  }
  return files;
}

function decodeZip(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSafe(bytes);
}

function groupSkillDirectories(files: Record<string, Uint8Array>): Map<string, Record<string, Uint8Array>> {
  const roots = new Map<string, Record<string, Uint8Array>>();
  for (const [path, content] of Object.entries(files)) {
    const [root, ...rest] = path.split("/");
    if (!root || rest.length === 0) {
      throw new SkillValidationError("Skill ZIP files must be inside a Skill directory", [path]);
    }
    const relativePath = rest.join("/");
    const group = roots.get(root) ?? {};
    group[relativePath] = content;
    roots.set(root, group);
  }
  return roots;
}

export function skillChecksum(skill: Pick<SkillRecord, "files">): string {
  return calculateSkillChecksum(skill.files);
}

function normalizeSkillRecord(skill: SkillRecord): SkillRecord {
  return { ...skill, checksum: skillChecksum(skill) };
}

export function parseSkillZip(
  bytes: Uint8Array,
  input: { workspaceId: string; source?: SkillSource },
): SkillRecord[] {
  const files = decodeZip(bytes);
  const groups = groupSkillDirectories(files);

  const result: SkillRecord[] = [];
  const allIssues: string[] = [];
  for (const [directoryName, skillFiles] of groups) {
    const skillMarkdownBytes = skillFiles["SKILL.md"];
    if (!skillMarkdownBytes) {
      allIssues.push(`${directoryName}/SKILL.md is required`);
      continue;
    }
    const skillMarkdown = strFromU8(skillMarkdownBytes);
    const { frontmatter, issues } = validateSkillDefinition(directoryName, skillMarkdown);
    if (issues.length > 0) {
      allIssues.push(...issues.map((issue) => `${directoryName}: ${issue}`));
      continue;
    }
    result.push({
      id: `skill_${randomUUID()}`,
      workspaceId: input.workspaceId,
      name: frontmatter.name,
      description: frontmatter.description,
      ...(frontmatter.license ? { license: frontmatter.license } : {}),
      ...(frontmatter.compatibility ? { compatibility: frontmatter.compatibility } : {}),
      ...(frontmatter.metadata ? { metadata: frontmatter.metadata } : {}),
      ...(frontmatter.allowedTools ? { allowedTools: frontmatter.allowedTools } : {}),
      source: input.source ?? "imported",
      version: 1,
      checksum: calculateSkillChecksum(skillFiles),
      enabled: true,
      valid: true,
      validationErrors: [],
      files: skillFiles,
      skillMarkdown,
      importedAt: new Date().toISOString(),
    });
  }
  if (allIssues.length > 0) {
    throw new SkillValidationError("Skill ZIP validation failed", allIssues);
  }
  return result;
}

export function summarizeSkill(skill: SkillRecord): SkillSummary {
  const { files: _files, skillMarkdown: _skillMarkdown, ...summary } = skill;
  return summary;
}

/** Workspace definitions shadow active definitions with the same name. */
export function enumerateAvailableSkills(
  activeSkills: readonly SkillRecord[],
  workspaceSkills: readonly SkillRecord[],
): SkillRecord[] {
  const byName = new Map<string, SkillRecord>();
  for (const skill of activeSkills) {
    if (skill.enabled && skill.valid) byName.set(skill.name, skill);
  }
  // A workspace record shadows an active record even when disabled/invalid;
  // otherwise a user could not reliably turn off a globally active Skill.
  for (const skill of workspaceSkills) byName.set(skill.name, skill);
  return [...byName.values()]
    .filter((skill) => skill.enabled && skill.valid)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function filterSkills(
  skills: readonly SkillRecord[],
  allowedSkillNames: readonly string[] | undefined,
): SkillRecord[] {
  if (allowedSkillNames === undefined) return [...skills];
  const allowed = new Set(allowedSkillNames);
  return skills.filter((skill) => allowed.has(skill.name));
}

/** Build prompt-only Skill metadata. Full SKILL.md/resources remain progressively loadable. */
export function buildSkillsPrompt(skills: readonly SkillRecord[]): string {
  if (skills.length === 0) return "";
  const lines = [
    "The following Skills are available as prompt-level guidance only.",
    "They do not grant tool permissions. Load full SKILL.md/resources only when the task requires them.",
  ];
  for (const skill of skills) {
    lines.push(`- ${skill.name}: ${skill.description} (checksum: ${skillChecksum(skill)})`);
  }
  return lines.join("\n");
}

export function createSkillsZip(skills: readonly SkillRecord[]): Uint8Array {
  const archive: Record<string, Uint8Array> = {};
  for (const skill of skills) {
    for (const [relativePath, content] of Object.entries(skill.files)) {
      archive[`${skill.name}/${normalizeArchivePath(relativePath)}`] = content;
    }
  }
  return zipSync(archive, { level: 6 });
}

export function createSkillsManifest(skills: readonly SkillRecord[]): SkillBundleManifest {
  return {
    schemaVersion: SKILL_BUNDLE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    skills: skills.map((skill) => ({
      name: skill.name,
      version: skill.version,
      checksum: skillChecksum(skill),
      source: skill.source,
      ...(skill.license ? { license: skill.license } : {}),
      exported: true,
    })),
  };
}

export class InMemorySkillRegistry {
  readonly #activeByName = new Map<string, SkillRecord>();
  readonly #workspaceById = new Map<string, Map<string, SkillRecord>>();

  constructor(activeSkills: readonly SkillRecord[] = []) {
    for (const skill of activeSkills) this.#activeByName.set(skill.name, normalizeSkillRecord(skill));
  }

  list(workspaceId: string): SkillRecord[] {
    return enumerateAvailableSkills(
      [...this.#activeByName.values()],
      [...(this.#workspaceById.get(workspaceId)?.values() ?? [])],
    );
  }

  get(workspaceId: string, name: string): SkillRecord | undefined {
    return this.#workspaceById.get(workspaceId)?.get(name) ?? this.#activeByName.get(name);
  }

  importZip(
    workspaceId: string,
    bytes: Uint8Array,
    conflictResolution: "error" | "replace" = "error",
  ): SkillRecord[] {
    const incoming = parseSkillZip(bytes, { workspaceId });
    const workspace = this.#workspaceById.get(workspaceId) ?? new Map<string, SkillRecord>();
    for (const skill of incoming) {
      const existing = workspace.get(skill.name) ?? this.#activeByName.get(skill.name);
      if (existing?.checksum === skill.checksum) continue;
      if (existing && conflictResolution === "error") {
        throw new SkillConflictError({
          name: skill.name,
          existingChecksum: existing.checksum,
          incomingChecksum: skill.checksum,
        });
      }
      workspace.set(skill.name, {
        ...skill,
        version: existing ? existing.version + 1 : 1,
      });
    }
    this.#workspaceById.set(workspaceId, workspace);
    return incoming.map((skill) => workspace.get(skill.name) ?? skill);
  }

  setEnabled(workspaceId: string, name: string, enabled: boolean): SkillRecord | undefined {
    const workspace = this.#workspaceById.get(workspaceId) ?? new Map<string, SkillRecord>();
    const existing = workspace.get(name) ?? this.#activeByName.get(name);
    if (!existing) return undefined;
    const updated = { ...existing, workspaceId, source: "workspace" as const, enabled };
    workspace.set(name, updated);
    this.#workspaceById.set(workspaceId, workspace);
    return updated;
  }

  delete(workspaceId: string, name: string): boolean {
    return this.#workspaceById.get(workspaceId)?.delete(name) ?? false;
  }
}
