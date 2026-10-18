import { createHash } from "node:crypto";
import { access as fsAccess, constants as fsConstants, lstat as fsLstat, readdir as fsReaddir, realpath as fsRealpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ProfileOsStatus } from "@aervox/contracts/proactive";
import { type ProactiveWideSourceId, type SupportedPlatform, type ProactiveSourceProbe, type ProactiveCaptureRecord, type ProactiveCaptureBatch, type MediaPermission, type FileDirentLike, type FileSystemLike, type ProbeOverride } from "./types";

export const EMPTY_REASON = "source_adapter_not_ready";

export function nowIso(now: () => Date): string {
  try {
    const value = now();
    return Number.isFinite(value.getTime()) ? value.toISOString() : new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

export function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value as number)));
}

export function hashPath(path: string): string {
  return createHash("sha256").update(path, "utf8").digest("hex").slice(0, 24);
}

/** Remove fields that could carry source content from a provider metadata object. */
export function metadataOnly(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => metadataOnly(item));
  const blocked = new Set([
    "content",
    "payload",
    "payloadText",
    "data",
    "dataUrl",
    "thumbnail",
    "thumbnailDataUrl",
    "text",
    "body",
    "url",
    "windowTitle",
    "documentTitle",
    "commandLine",
    "arguments",
  ]);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!blocked.has(key.toLowerCase())) result[key] = metadataOnly(item);
  }
  return result;
}

export function mediaToStatus(value: MediaPermission | undefined): ProfileOsStatus {
  if (value === "granted") return "granted";
  if (value === "denied" || value === "restricted") return "denied";
  if (value === "not-determined") return "prompt";
  return "unknown";
}

export function isProfileOsStatus(value: unknown): value is ProfileOsStatus {
  return value === "granted"
    || value === "denied"
    || value === "prompt"
    || value === "unavailable"
    || value === "unknown";
}

export function normalizeProbe(
  sourceId: ProactiveWideSourceId,
  platform: SupportedPlatform,
  now: () => Date,
  input: ProbeOverride,
  fallbackReason?: string,
): ProactiveSourceProbe {
  const rawStatus = isProfileOsStatus(input.status) ? input.status : "unknown";
  const osStatus = isProfileOsStatus(input.osStatus) ? input.osStatus : rawStatus;
  // A provider must explicitly prove readiness. Merely returning `status:
  // granted` cannot turn an unavailable collector into a granted source.
  const ready = input.ready === true;
  const status: ProfileOsStatus = rawStatus === "granted" && !ready ? "unavailable" : rawStatus;
  const granted = status === "granted";
  return {
    sourceId,
    platform,
    status,
    osStatus,
    granted,
    ready: ready && granted,
    canRequest: input.canRequest ?? false,
    reason: input.reason ?? fallbackReason,
    checkedAt: nowIso(now),
    metadata: input.metadata,
  };
}

export function emptyBatch(
  sourceId: ProactiveWideSourceId,
  now: () => Date,
  reason: string,
  extra: Partial<Pick<ProactiveCaptureBatch, "complete" | "nextCursor" | "skipped">> = {},
): ProactiveCaptureBatch {
  return {
    sourceId,
    capturedAt: nowIso(now),
    records: [],
    complete: extra.complete ?? true,
    nextCursor: extra.nextCursor,
    skipped: extra.skipped,
    reason,
  };
}

export function makeRecord(
  sourceId: ProactiveWideSourceId,
  eventType: string,
  now: () => Date,
  payload: unknown,
  metadata?: Readonly<Record<string, unknown>>,
  contentType: ProactiveCaptureRecord["contentType"] = "application/json",
): ProactiveCaptureRecord {
  const record: ProactiveCaptureRecord = { sourceId, eventType, contentType, observedAt: nowIso(now) };
  if (payload !== undefined) (record as { payload?: unknown }).payload = payload;
  if (metadata !== undefined) (record as { metadata?: Readonly<Record<string, unknown>> }).metadata = metadata;
  return record;
}

export function defaultFileSystem(): FileSystemLike {
  return {
    access: async (path) => {
      await fsAccess(path, fsConstants.R_OK);
    },
    lstat: async (path) => fsLstat(path),
    realpath: async (path) => fsRealpath(path),
    readdir: async (path) => (await fsReaddir(path, { withFileTypes: true })) as unknown as readonly FileDirentLike[],
  };
}

export function mergeFileSystem(input?: Partial<FileSystemLike>): FileSystemLike {
  const defaults = defaultFileSystem();
  return {
    access: input?.access ?? defaults.access,
    lstat: input?.lstat ?? defaults.lstat,
    realpath: input?.realpath ?? defaults.realpath,
    readdir: input?.readdir ?? defaults.readdir,
  };
}

export function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of paths) {
    if (typeof value !== "string" || value.trim().length === 0) continue;
    const path = resolve(value);
    if (seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

export function isWithinRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function platformHome(platform: SupportedPlatform, env: Readonly<Record<string, string | undefined>>, fallback: string): string {
  if (platform === "win32") return env.USERPROFILE ?? (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : fallback);
  return env.HOME ?? fallback;
}
