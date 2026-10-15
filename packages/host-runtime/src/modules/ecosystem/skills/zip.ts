import { executeArchive, ARCHIVE_LIMITS, normalizeSkillArchivePath } from "../../../shared/archive-worker.js";

export interface ZipEntry { name: string; isDirectory: boolean; data: Buffer }

/** Shared worker budget, with Skill-specific path normalization. */
export async function unzip(buffer: Buffer, signal?: AbortSignal): Promise<ZipEntry[]> {
  const files = await executeArchive<Record<string, Uint8Array>>({
    kind: "unpack", input: buffer, limits: ARCHIVE_LIMITS, normalizePath: normalizeSkillArchivePath, signal,
  });
  return Object.entries(files).map(([name, data]) => ({
    name: name.replace(/\/$/, ""), isDirectory: name.endsWith("/"), data: Buffer.from(data),
  }));
}
