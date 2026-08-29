/**
 * CAP-033 desktop wide-source adapters.
 *
 * This module is deliberately independent from Electron's runtime singleton. The
 * main process supplies the small Electron/native interfaces it owns, which keeps
 * the adapters testable and makes the permission boundary explicit:
 *
 * - `osStatus` is the permission signal reported by the operating system or a
 *   trusted native provider;
 * - `status` is the effective adapter status;
 * - `ready` means that the adapter can actually produce a capture batch now;
 * - `granted` is never inferred from adapter presence alone.
 *
 * The default capture paths are metadata-only. They do not read browser history
 * rows, file contents, window titles, clipboard contents, or screen pixels. A
 * caller must explicitly request content, and screen/app providers must opt in to
 * that request themselves.
 */

import { createHash } from "node:crypto";
import {
  access as fsAccess,
  constants as fsConstants,
  lstat as fsLstat,
  readdir as fsReaddir,
  realpath as fsRealpath,
} from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type {
  ProfileOsStatus,
  ProfileSourceId,
} from "@aervox/contracts/proactive";

/** Sources implemented by this increment. */
export const PROACTIVE_WIDE_SOURCE_IDS = [
  "device.screen_capture",
  "device.browser_activity",
  "filesystem.full_disk_watch",
  "device.app_activity",
] as const;

export type ProactiveWideSourceId = (typeof PROACTIVE_WIDE_SOURCE_IDS)[number];

export type SupportedPlatform = NodeJS.Platform;

export interface ProactiveSourceCaptureOptions {
  /** Screen providers may return pixels only when this is explicitly true. */
  readonly includeContent?: boolean;
  /** Additional opt-in required by providers for sensitive fields. */
  readonly allowSensitiveContent?: boolean;
  readonly maxItems?: number;
  readonly maxDepth?: number;
  /** File roots explicitly selected by the user. No roots means no file scan. */
  readonly roots?: readonly string[];
  readonly includePaths?: boolean;
  readonly signal?: AbortSignal;
}

export interface ProactiveSourceProbe {
  readonly sourceId: ProactiveWideSourceId;
  readonly platform: SupportedPlatform;
  /** Effective adapter state; `granted` requires a usable adapter. */
  readonly status: ProfileOsStatus;
  /** Raw OS/native permission state when one is exposed. */
  readonly osStatus: ProfileOsStatus;
  /** True only when the effective status is `granted`. */
  readonly granted: boolean;
  /** True only when a capture operation can run without another setup step. */
  readonly ready: boolean;
  readonly canRequest: boolean;
  readonly reason?: string;
  readonly checkedAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ProactiveCaptureRecord {
  readonly sourceId: ProactiveWideSourceId;
  readonly eventType: string;
  readonly contentType: "application/json" | "text/plain" | "image/png";
  readonly observedAt: string;
  /** Metadata payloads are the default; content providers may opt in explicitly. */
  readonly payload?: unknown;
  readonly payloadText?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ProactiveCaptureBatch {
  readonly sourceId: ProactiveWideSourceId;
  readonly capturedAt: string;
  readonly records: readonly ProactiveCaptureRecord[];
  readonly complete: boolean;
  readonly nextCursor?: string;
  readonly skipped?: number;
  readonly reason?: string;
}

export interface ProactiveSourceAdapter {
  readonly sourceId: ProactiveWideSourceId;
  probe(): Promise<ProactiveSourceProbe>;
  capture(options?: ProactiveSourceCaptureOptions): Promise<ProactiveCaptureBatch>;
  /** Explicit user request hook; it must never silently grant a capability. */
  request?(): Promise<ProactiveSourceProbe>;
  close?(): Promise<void> | void;
}

export interface ProactiveSourceAdapters {
  readonly screenCapture: ProactiveSourceAdapter;
  readonly browserHistory: ProactiveSourceAdapter;
  readonly fileMetadata: ProactiveSourceAdapter;
  readonly appActivity: ProactiveSourceAdapter;
  readonly all: readonly ProactiveSourceAdapter[];
  get(sourceId: ProactiveWideSourceId): ProactiveSourceAdapter;
  probe(sourceId: ProfileSourceId | string): Promise<ProactiveSourceProbe | undefined>;
  probeAll(): Promise<readonly ProactiveSourceProbe[]>;
  capture(sourceId: ProactiveWideSourceId, options?: ProactiveSourceCaptureOptions): Promise<ProactiveCaptureBatch>;
  captureAll(options?: ProactiveSourceCaptureOptions): Promise<readonly ProactiveCaptureBatch[]>;
  request(sourceId: ProactiveWideSourceId): Promise<ProactiveSourceProbe>;
  close(): Promise<void>;
}

/** Narrow result shape accepted by `createProactiveHost({ capabilityProbe })`. */
export interface ProactiveCapabilityProbeResult {
  readonly status: ProfileOsStatus;
  readonly reason?: string;
  readonly canRequest?: boolean;
  readonly ready?: boolean;
  readonly granted?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export function toCapabilityProbe(result: ProactiveSourceProbe): ProactiveCapabilityProbeResult {
  return {
    status: result.status,
    reason: result.reason,
    canRequest: result.canRequest,
    ready: result.ready,
    granted: result.granted,
    metadata: result.metadata,
  };
}

type MediaPermission = "not-determined" | "granted" | "denied" | "restricted" | "unknown";

export interface SystemPreferencesLike {
  getMediaAccessStatus?: (mediaType: "screen") => MediaPermission;
  isTrustedAccessibilityClient?: (prompt: boolean) => boolean;
}

interface DisplayLike {
  readonly id?: number | string;
  readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly workArea?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly scaleFactor?: number;
  readonly rotation?: number;
}

export interface ScreenLike {
  getAllDisplays?: () => readonly DisplayLike[];
}

interface DesktopSourceLike {
  readonly id?: string;
  readonly name?: string;
  readonly display_id?: string;
  readonly thumbnail?: { toDataURL?: () => string };
}

export interface DesktopCapturerLike {
  getSources?: (options: {
    types: ("screen" | "window")[];
    thumbnailSize?: { readonly width: number; readonly height: number };
    fetchWindowIcons?: boolean;
  }) => Promise<readonly DesktopSourceLike[]>;
}

export interface ScreenCaptureProvider {
  probe?: () => ProbeOverride | Promise<ProbeOverride>;
  capture?: (options: {
    readonly includeContent: boolean;
    readonly allowSensitiveContent: boolean;
    readonly maxItems: number;
  }) => Promise<readonly ProactiveCaptureRecord[]>;
  request?: () => void | Promise<void>;
}

export interface BrowserHistoryMetadata {
  readonly browser: string;
  readonly profile?: string;
  readonly path: string;
  readonly size?: number;
  readonly modifiedAt?: string;
  readonly format?: string;
}

export interface BrowserHistoryProvider {
  probe?: () => ProbeOverride | Promise<ProbeOverride>;
  /** A native bridge can provide aggregate metadata or rows when explicitly opted in. */
  capture?: (options: {
    readonly includeContent: boolean;
    readonly allowSensitiveContent: boolean;
    readonly maxItems: number;
  }) => Promise<readonly BrowserHistoryMetadata[]>;
  request?: () => void | Promise<void>;
}

export interface AppActivityRecord {
  readonly applicationId?: string;
  readonly applicationName?: string;
  readonly bundleId?: string;
  readonly processId?: number;
  readonly processPath?: string;
  readonly windowTitle?: string;
  readonly activeSince?: string;
  readonly activeForMs?: number;
  readonly isFrontmost?: boolean;
  readonly [key: string]: unknown;
}

export interface AppActivityProvider {
  probe?: () => ProbeOverride | Promise<ProbeOverride>;
  list?: (options: {
    readonly includeSensitiveMetadata: boolean;
    readonly maxItems: number;
  }) => Promise<readonly AppActivityRecord[]>;
  request?: () => void | Promise<void>;
}

export interface FileStatLike {
  readonly size: number;
  readonly mtimeMs: number;
  readonly birthtimeMs?: number;
  readonly mode?: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface FileDirentLike {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface FileSystemLike {
  access(path: string): Promise<void>;
  lstat(path: string): Promise<FileStatLike>;
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<readonly FileDirentLike[]>;
}

export interface FullDiskAccessProbe {
  (): ProbeOverride | Promise<ProbeOverride>;
}

export interface ProactiveSourceAdapterDependencies {
  readonly platform?: SupportedPlatform;
  readonly homeDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  readonly systemPreferences?: SystemPreferencesLike;
  readonly screen?: ScreenLike;
  readonly desktopCapturer?: DesktopCapturerLike;
  readonly screenCapture?: ScreenCaptureProvider;
  readonly browserHistory?: BrowserHistoryProvider;
  readonly appActivity?: AppActivityProvider;
  readonly fullDiskAccessProbe?: FullDiskAccessProbe;
  readonly fileRoots?: readonly string[];
  readonly fileSystem?: Partial<FileSystemLike>;
}

export interface ProactiveSourceProbeOverride {
  readonly status: ProfileOsStatus;
  readonly osStatus?: ProfileOsStatus;
  readonly ready?: boolean;
  readonly canRequest?: boolean;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

type ProbeOverride = ProactiveSourceProbeOverride;

const EMPTY_REASON = "source_adapter_not_ready";

function nowIso(now: () => Date): string {
  try {
    const value = now();
    return Number.isFinite(value.getTime()) ? value.toISOString() : new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value as number)));
}

function hashPath(path: string): string {
  return createHash("sha256").update(path, "utf8").digest("hex").slice(0, 24);
}

/** Remove fields that could carry source content from a provider metadata object. */
function metadataOnly(value: unknown): unknown {
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

function mediaToStatus(value: MediaPermission | undefined): ProfileOsStatus {
  if (value === "granted") return "granted";
  if (value === "denied" || value === "restricted") return "denied";
  if (value === "not-determined") return "prompt";
  return "unknown";
}

function isProfileOsStatus(value: unknown): value is ProfileOsStatus {
  return value === "granted"
    || value === "denied"
    || value === "prompt"
    || value === "unavailable"
    || value === "unknown";
}

function normalizeProbe(
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

function emptyBatch(
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

function makeRecord(
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

function defaultFileSystem(): FileSystemLike {
  return {
    access: async (path) => {
      await fsAccess(path, fsConstants.R_OK);
    },
    lstat: async (path) => fsLstat(path),
    realpath: async (path) => fsRealpath(path),
    readdir: async (path) => (await fsReaddir(path, { withFileTypes: true })) as unknown as readonly FileDirentLike[],
  };
}

function mergeFileSystem(input?: Partial<FileSystemLike>): FileSystemLike {
  const defaults = defaultFileSystem();
  return {
    access: input?.access ?? defaults.access,
    lstat: input?.lstat ?? defaults.lstat,
    realpath: input?.realpath ?? defaults.realpath,
    readdir: input?.readdir ?? defaults.readdir,
  };
}

function uniquePaths(paths: readonly string[]): string[] {
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

function isWithinRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function platformHome(platform: SupportedPlatform, env: Readonly<Record<string, string | undefined>>, fallback: string): string {
  if (platform === "win32") return env.USERPROFILE ?? (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : fallback);
  return env.HOME ?? fallback;
}

interface BrowserHistoryCandidate {
  readonly browser: string;
  readonly profile?: string;
  readonly path: string;
  readonly format: string;
}

function browserHistoryCandidates(
  platform: SupportedPlatform,
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): readonly BrowserHistoryCandidate[] {
  const localAppData = env.LOCALAPPDATA ?? join(homeDir, "AppData", "Local");
  const appData = env.APPDATA ?? join(homeDir, "AppData", "Roaming");
  const configHome = env.XDG_CONFIG_HOME ?? join(homeDir, ".config");
  const candidates: BrowserHistoryCandidate[] = [];
  const addChromium = (browser: string, base: string, profile = "Default") => {
    candidates.push({ browser, profile, path: join(base, profile, "History"), format: "chromium-history" });
  };

  if (platform === "darwin") {
    addChromium("chrome", join(homeDir, "Library", "Application Support", "Google", "Chrome"));
    addChromium("chrome-beta", join(homeDir, "Library", "Application Support", "Google", "Chrome Beta"));
    addChromium("edge", join(homeDir, "Library", "Application Support", "Microsoft Edge"));
    addChromium("brave", join(homeDir, "Library", "Application Support", "BraveSoftware", "Brave-Browser"));
    addChromium("arc", join(homeDir, "Library", "Application Support", "Arc", "User Data"));
    candidates.push({ browser: "safari", path: join(homeDir, "Library", "Safari", "History.db"), format: "safari-history" });
    candidates.push({ browser: "firefox", path: join(homeDir, "Library", "Application Support", "Firefox", "Profiles"), format: "firefox-profiles" });
  } else if (platform === "win32") {
    addChromium("chrome", join(localAppData, "Google", "Chrome", "User Data"));
    addChromium("edge", join(localAppData, "Microsoft", "Edge", "User Data"));
    addChromium("brave", join(localAppData, "BraveSoftware", "Brave-Browser", "User Data"));
    addChromium("vivaldi", join(localAppData, "Vivaldi", "User Data"));
    candidates.push({ browser: "firefox", path: join(appData, "Mozilla", "Firefox", "Profiles"), format: "firefox-profiles" });
  } else {
    addChromium("chrome", join(configHome, "google-chrome"));
    addChromium("chromium", join(configHome, "chromium"));
    addChromium("edge", join(configHome, "microsoft-edge"));
    addChromium("brave", join(configHome, "BraveSoftware", "Brave-Browser"));
    addChromium("vivaldi", join(configHome, "vivaldi"));
    candidates.push({ browser: "firefox", path: join(homeDir, ".mozilla", "firefox"), format: "firefox-profiles" });
  }
  return candidates;
}

function createScreenCaptureAdapter(input: {
  readonly platform: SupportedPlatform;
  readonly now: () => Date;
  readonly systemPreferences?: SystemPreferencesLike;
  readonly screen?: ScreenLike;
  readonly desktopCapturer?: DesktopCapturerLike;
  readonly provider?: ScreenCaptureProvider;
}): ProactiveSourceAdapter {
  const sourceId = "device.screen_capture" as const;

  const probe = async (): Promise<ProactiveSourceProbe> => {
    let override: ProbeOverride | undefined;
    if (input.provider?.probe) {
      try {
        override = await input.provider.probe();
      } catch (error) {
        return normalizeProbe(sourceId, input.platform, input.now, {
          status: "unknown",
          osStatus: "unknown",
          ready: false,
          canRequest: false,
          reason: error instanceof Error ? error.message : "screen_probe_failed",
        });
      }
    }

    let osStatus: ProfileOsStatus = "unknown";
    try {
      osStatus = mediaToStatus(input.systemPreferences?.getMediaAccessStatus?.("screen"));
    } catch {
      osStatus = "unknown";
    }
    const captureAvailable = Boolean(input.provider?.capture || input.desktopCapturer?.getSources);
    if (override) {
      const providerReady = Boolean(input.provider?.capture || input.desktopCapturer?.getSources);
      return normalizeProbe(sourceId, input.platform, input.now, {
        ...override,
        ready: override.ready === true && providerReady,
        reason: override.ready === true && !providerReady
          ? "screen_capture_provider_unavailable"
          : override.reason,
      }, "screen_probe_override");
    }
    if (osStatus === "denied") {
      return normalizeProbe(sourceId, input.platform, input.now, {
        status: "denied",
        osStatus,
        ready: false,
        canRequest: input.platform === "darwin",
        reason: "screen_permission_denied",
      });
    }
    if (osStatus === "prompt") {
      return normalizeProbe(sourceId, input.platform, input.now, {
        status: "prompt",
        osStatus,
        ready: false,
        canRequest: input.platform === "darwin",
        reason: "screen_permission_required",
      });
    }
    if (!captureAvailable) {
      return normalizeProbe(sourceId, input.platform, input.now, {
        status: "unavailable",
        osStatus,
        ready: false,
        canRequest: false,
        reason: "screen_capture_provider_unavailable",
      });
    }
    if (osStatus === "granted") {
      return normalizeProbe(sourceId, input.platform, input.now, {
        status: "granted",
        osStatus,
        ready: true,
        canRequest: false,
        metadata: { contentDefault: "metadata_only" },
      });
    }
    // On platforms without an exposed screen-consent API, the adapter may be
    // present but must remain unknown until a trusted provider reports a grant.
    return normalizeProbe(sourceId, input.platform, input.now, {
      status: "unknown",
      osStatus,
      ready: false,
      canRequest: Boolean(input.provider?.request),
      reason: "screen_permission_probe_unavailable",
    });
  };

  return {
    sourceId,
    probe,
    async request() {
      try {
        await input.provider?.request?.();
      } catch {
        // Probe below reports the authoritative state.
      }
      return probe();
    },
    async capture(options = {}) {
      const state = await probe();
      if (!state.ready) return emptyBatch(sourceId, input.now, state.reason ?? EMPTY_REASON);
      const maxItems = boundedInt(options.maxItems, 32, 1, 500);
      const includeContent = options.includeContent === true && options.allowSensitiveContent === true;

      if (input.provider?.capture) {
        try {
          const records = await input.provider.capture({
            includeContent,
            allowSensitiveContent: options.allowSensitiveContent === true,
            maxItems,
          });
          return {
            sourceId,
            capturedAt: nowIso(input.now),
            records: records.slice(0, maxItems).map((record) =>
              includeContent ? record : {
                sourceId,
                eventType: record.eventType,
                contentType: "application/json" as const,
                payload: metadataOnly(record.metadata) ?? { adapter: "screen-provider-metadata-only" },
                observedAt: record.observedAt,
                ...(record.metadata ? { metadata: metadataOnly(record.metadata) as Readonly<Record<string, unknown>> } : {}),
              }),
            complete: records.length <= maxItems,
            nextCursor: records.length > maxItems ? String(maxItems) : undefined,
          };
        } catch (error) {
          return emptyBatch(sourceId, input.now, error instanceof Error ? error.message : "screen_capture_failed");
        }
      }

      const records: ProactiveCaptureRecord[] = [];
      if (input.screen?.getAllDisplays) {
        try {
          for (const display of input.screen.getAllDisplays().slice(0, maxItems)) {
            records.push(makeRecord(sourceId, "screen.display.metadata", input.now, {
              displayId: display.id === undefined ? undefined : String(display.id),
              bounds: display.bounds,
              workArea: display.workArea,
              scaleFactor: display.scaleFactor,
              rotation: display.rotation,
              adapter: "electron-screen-metadata-v1",
            }));
          }
        } catch {
          // Continue to an explicit pixel capture path if one was requested.
        }
      }

      if (includeContent && input.desktopCapturer?.getSources && records.length < maxItems) {
        try {
          const sources = await input.desktopCapturer.getSources({
            types: ["screen", "window"],
            thumbnailSize: { width: 320, height: 200 },
            fetchWindowIcons: false,
          });
          for (const source of sources.slice(0, maxItems - records.length)) {
            const dataUrl = source.thumbnail?.toDataURL?.();
            records.push(makeRecord(sourceId, "screen.capture", input.now, {
              id: source.id,
              name: source.name,
              displayId: source.display_id,
              ...(dataUrl ? { dataUrl } : {}),
              adapter: "electron-desktop-capturer-v1",
            }, undefined, dataUrl ? "image/png" : "application/json"));
          }
        } catch (error) {
          return {
            sourceId,
            capturedAt: nowIso(input.now),
            records,
            complete: false,
            reason: error instanceof Error ? error.message : "screen_capture_failed",
          };
        }
      }
      return {
        sourceId,
        capturedAt: nowIso(input.now),
        records,
        complete: true,
        reason: records.length === 0 ? "screen_metadata_unavailable" : undefined,
      };
    },
  };
}

function createBrowserHistoryAdapter(input: {
  readonly platform: SupportedPlatform;
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => Date;
  readonly fileSystem: FileSystemLike;
  readonly provider?: BrowserHistoryProvider;
}): ProactiveSourceAdapter {
  const sourceId = "device.browser_activity" as const;
  const candidates = browserHistoryCandidates(input.platform, input.homeDir, input.env);

  /**
   * Expand profile roots without opening a history database. Directory names
   * and file stat/access checks are sufficient for an availability probe.
   */
  const expandCandidates = async (): Promise<BrowserHistoryCandidate[]> => {
    const expanded: BrowserHistoryCandidate[] = [];
    const seen = new Set<string>();
    const add = (candidate: BrowserHistoryCandidate) => {
      if (seen.has(candidate.path)) return;
      seen.add(candidate.path);
      expanded.push(candidate);
    };
    for (const candidate of candidates) {
      if (candidate.format === "firefox-profiles") {
        try {
          const rootStat = await input.fileSystem.lstat(candidate.path);
          if (rootStat.isDirectory()) {
            const entries = await input.fileSystem.readdir(candidate.path);
            for (const entry of entries) {
              if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
              add({
                browser: candidate.browser,
                profile: entry.name,
                path: join(candidate.path, entry.name, "places.sqlite"),
                format: "firefox-history",
              });
            }
            continue;
          }
        } catch {
          // The root may not exist; retain no synthetic grant.
        }
      }
      add(candidate);

      // Chromium browsers may have Profile 1/Profile 2 in addition to Default.
      // Enumerate only immediate profile directories and never inspect database
      // contents.
      if (candidate.format === "chromium-history") {
        const browserRoot = resolve(candidate.path, "..", "..");
        try {
          const rootStat = await input.fileSystem.lstat(browserRoot);
          if (rootStat.isDirectory()) {
            const entries = await input.fileSystem.readdir(browserRoot);
            for (const entry of entries) {
              if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
              add({
                browser: candidate.browser,
                profile: entry.name,
                path: join(browserRoot, entry.name, "History"),
                format: "chromium-history",
              });
            }
          }
        } catch {
          // Profile discovery is best effort; the static candidate remains valid.
        }
      }
    }
    return expanded;
  };

  const inspect = async (): Promise<{ readable: BrowserHistoryCandidate[]; denied: BrowserHistoryCandidate[] }> => {
    const readable: BrowserHistoryCandidate[] = [];
    const denied: BrowserHistoryCandidate[] = [];
    for (const candidate of await expandCandidates()) {
      try {
        const stat = await input.fileSystem.lstat(candidate.path);
        // A history candidate must be a file. Profile roots are expanded above
        // and are never themselves treated as a readable history database.
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        await input.fileSystem.access(candidate.path);
        readable.push(candidate);
      } catch {
        // A profile directory may exist without being readable; retain it as a
        // denied candidate only when the path itself exists.
        try {
          await input.fileSystem.lstat(candidate.path);
          denied.push(candidate);
        } catch {
          // Candidate does not exist.
        }
      }
    }
    return { readable, denied };
  };

  const probe = async (): Promise<ProactiveSourceProbe> => {
    if (input.provider?.probe) {
      try {
        const override = await input.provider.probe();
        return normalizeProbe(sourceId, input.platform, input.now, {
          ...override,
          ready: override.ready === true && Boolean(input.provider.capture),
          reason: override.ready === true && !input.provider.capture
            ? "browser_history_provider_unavailable"
            : override.reason,
        }, "browser_probe_override");
      } catch (error) {
        return normalizeProbe(sourceId, input.platform, input.now, {
          status: "unknown",
          osStatus: "unknown",
          ready: false,
          canRequest: false,
          reason: error instanceof Error ? error.message : "browser_probe_failed",
        });
      }
    }
    const inspected = await inspect();
    if (inspected.readable.length > 0) {
      return normalizeProbe(sourceId, input.platform, input.now, {
        status: "granted",
        osStatus: "granted",
        ready: true,
        canRequest: false,
        metadata: {
          readableDatabases: inspected.readable.map((candidate) => ({
            browser: candidate.browser,
            profile: candidate.profile,
            pathHash: hashPath(candidate.path),
            format: candidate.format,
          })),
          contentDefault: "metadata_only",
        },
      });
    }
    if (inspected.denied.length > 0) {
      return normalizeProbe(sourceId, input.platform, input.now, {
        status: "denied",
        osStatus: "denied",
        ready: false,
        canRequest: true,
        reason: "browser_history_path_denied",
        metadata: { deniedPathCount: inspected.denied.length },
      });
    }
    return normalizeProbe(sourceId, input.platform, input.now, {
      status: "unavailable",
      osStatus: "unknown",
      ready: false,
      canRequest: Boolean(input.provider?.request),
      reason: "browser_history_not_found",
    });
  };

  return {
    sourceId,
    probe,
    async request() {
      try {
        await input.provider?.request?.();
      } catch {
        // The following probe is authoritative.
      }
      return probe();
    },
    async capture(options = {}) {
      const state = await probe();
      if (!state.ready) return emptyBatch(sourceId, input.now, state.reason ?? EMPTY_REASON);
      const maxItems = boundedInt(options.maxItems, 64, 1, 500);
      const includePaths = options.includePaths === true;
      const includeContent = options.includeContent === true && options.allowSensitiveContent === true;
      const records: ProactiveCaptureRecord[] = [];

      if (input.provider?.capture) {
        try {
          const metadata = await input.provider.capture({
            includeContent,
            allowSensitiveContent: options.allowSensitiveContent === true,
            maxItems,
          });
          for (const item of metadata.slice(0, maxItems)) {
            const stat = await input.fileSystem.lstat(item.path).catch(() => undefined);
            records.push(makeRecord(sourceId, "browser.history.metadata", input.now, {
              browser: item.browser,
              profile: item.profile,
              pathHash: hashPath(item.path),
              ...(includePaths ? { path: item.path } : {}),
              size: item.size ?? stat?.size,
              modifiedAt: item.modifiedAt,
              format: item.format,
              adapter: "browser-history-provider-v1",
            }));
          }
          return {
            sourceId,
            capturedAt: nowIso(input.now),
            records,
            complete: metadata.length <= maxItems,
            nextCursor: metadata.length > maxItems ? String(maxItems) : undefined,
          };
        } catch (error) {
          return emptyBatch(sourceId, input.now, error instanceof Error ? error.message : "browser_capture_failed");
        }
      }

      const inspected = await inspect();
      for (const candidate of inspected.readable.slice(0, maxItems)) {
        let stat: FileStatLike | undefined;
        try {
          stat = await input.fileSystem.lstat(candidate.path);
        } catch {
          // It may disappear between probe and capture.
        }
        records.push(makeRecord(sourceId, "browser.history.metadata", input.now, {
          browser: candidate.browser,
          profile: candidate.profile,
          pathHash: hashPath(candidate.path),
          ...(includePaths ? { path: candidate.path } : {}),
          size: stat?.size,
          modifiedAt: stat && Number.isFinite(stat.mtimeMs) ? new Date(stat.mtimeMs).toISOString() : undefined,
          format: candidate.format,
          adapter: "browser-history-filesystem-metadata-v1",
          contentOmitted: true,
        }));
      }
      return {
        sourceId,
        capturedAt: nowIso(input.now),
        records,
        complete: inspected.readable.length <= maxItems,
        nextCursor: inspected.readable.length > maxItems ? String(maxItems) : undefined,
        skipped: inspected.denied.length,
        reason: records.length === 0 ? "browser_history_changed_during_capture" : undefined,
      };
    },
  };
}

function createFileMetadataAdapter(input: {
  readonly platform: SupportedPlatform;
  readonly now: () => Date;
  readonly fileSystem: FileSystemLike;
  readonly configuredRoots: readonly string[];
  readonly fullDiskAccessProbe?: FullDiskAccessProbe;
}): ProactiveSourceAdapter {
  const sourceId = "filesystem.full_disk_watch" as const;

  const probe = async (): Promise<ProactiveSourceProbe> => {
    if (input.configuredRoots.length === 0) {
      if (input.fullDiskAccessProbe) {
        try {
          return normalizeProbe(sourceId, input.platform, input.now, await input.fullDiskAccessProbe(), "full_disk_probe_override");
        } catch (error) {
          return normalizeProbe(sourceId, input.platform, input.now, {
            status: "unknown",
            osStatus: "unknown",
            ready: false,
            canRequest: true,
            reason: error instanceof Error ? error.message : "full_disk_probe_failed",
          });
        }
      }
      return normalizeProbe(sourceId, input.platform, input.now, {
        status: "prompt",
        osStatus: "unknown",
        ready: false,
        canRequest: true,
        reason: "file_roots_required",
        metadata: { contentDefault: "metadata_only", scanDefault: "disabled" },
      });
    }

    const roots = uniquePaths(input.configuredRoots);
    let readable = 0;
    let denied = 0;
    for (const root of roots) {
      try {
        const original = await input.fileSystem.lstat(root);
        if (original.isSymbolicLink()) {
          denied += 1;
          continue;
        }
        const canonical = await input.fileSystem.realpath(root);
        const stat = await input.fileSystem.lstat(canonical);
        if (stat.isSymbolicLink()) {
          denied += 1;
          continue;
        }
        await input.fileSystem.access(canonical);
        readable += 1;
      } catch {
        denied += 1;
      }
    }
    if (readable === roots.length && roots.length > 0) {
      return normalizeProbe(sourceId, input.platform, input.now, {
        status: "granted",
        osStatus: "granted",
        ready: true,
        canRequest: false,
        metadata: {
          rootCount: roots.length,
          roots: roots.map((root) => ({ pathHash: hashPath(root) })),
          contentDefault: "metadata_only",
        },
      });
    }
    return normalizeProbe(sourceId, input.platform, input.now, {
      status: readable > 0 ? "denied" : "denied",
      osStatus: "denied",
      ready: false,
      canRequest: true,
      reason: readable > 0 ? "file_root_scope_partial" : "file_root_access_denied",
      metadata: { rootCount: roots.length, readable, denied },
    });
  };

  return {
    sourceId,
    probe,
    async request() {
      if (input.fullDiskAccessProbe) {
        try {
          await input.fullDiskAccessProbe();
        } catch {
          // Probe below remains authoritative.
        }
      }
      return probe();
    },
    async capture(options = {}) {
      const state = await probe();
      if (!state.ready) return emptyBatch(sourceId, input.now, state.reason ?? EMPTY_REASON);
      const roots = uniquePaths(options.roots ?? input.configuredRoots);
      if (roots.length === 0) return emptyBatch(sourceId, input.now, "file_roots_required");

      // An options-level root may narrow the configured scope, but it may not
      // silently widen it. When a native full-disk probe is the authority and
      // no roots were configured, the explicit roots are covered by that grant.
      if (input.configuredRoots.length > 0 && options.roots) {
        const authorizedRoots: string[] = [];
        for (const configured of uniquePaths(input.configuredRoots)) {
          try {
            const original = await input.fileSystem.lstat(configured);
            if (original.isSymbolicLink()) continue;
            authorizedRoots.push(await input.fileSystem.realpath(configured));
          } catch {
            // The probe below has already made this an unavailable scope.
          }
        }
        for (const requested of roots) {
          let requestedCanonical: string;
          try {
            const original = await input.fileSystem.lstat(requested);
            if (original.isSymbolicLink()) return emptyBatch(sourceId, input.now, "file_root_symlink_denied");
            requestedCanonical = await input.fileSystem.realpath(requested);
          } catch {
            return emptyBatch(sourceId, input.now, "file_root_access_denied");
          }
          if (!authorizedRoots.some((authorized) => isWithinRoot(authorized, requestedCanonical))) {
            return emptyBatch(sourceId, input.now, "file_root_out_of_scope");
          }
        }
      }
      const maxItems = boundedInt(options.maxItems, 200, 1, 5_000);
      const maxDepth = boundedInt(options.maxDepth, 8, 0, 64);
      const signal = options.signal;
      const includePaths = options.includePaths !== false;
      const records: ProactiveCaptureRecord[] = [];
      const queue: Array<{ path: string; root: string; depth: number }> = [];
      const visited = new Set<string>();
      let skipped = 0;

      for (const root of roots) {
        try {
          // Check the user-supplied path before realpath so a symlink root cannot
          // be laundered into an apparently safe canonical target.
          const original = await input.fileSystem.lstat(root);
          if (original.isSymbolicLink()) {
            skipped += 1;
            continue;
          }
          const canonical = await input.fileSystem.realpath(root);
          const stat = await input.fileSystem.lstat(canonical);
          if (stat.isSymbolicLink()) {
            skipped += 1;
            continue;
          }
          queue.push({ path: canonical, root: canonical, depth: 0 });
        } catch {
          skipped += 1;
        }
      }

      while (queue.length > 0 && records.length < maxItems) {
        if (signal?.aborted) {
          return {
            sourceId,
            capturedAt: nowIso(input.now),
            records,
            complete: false,
            nextCursor: queue[0]?.path,
            skipped,
            reason: "capture_aborted",
          };
        }
        const item = queue.shift();
        if (!item) break;
        let canonical: string;
        try {
          const original = await input.fileSystem.lstat(item.path);
          if (original.isSymbolicLink()) {
            skipped += 1;
            continue;
          }
          canonical = await input.fileSystem.realpath(item.path);
          if (!isWithinRoot(item.root, canonical) || visited.has(canonical)) {
            skipped += 1;
            continue;
          }
          visited.add(canonical);
          const stat = await input.fileSystem.lstat(canonical);
          if (stat.isSymbolicLink()) {
            skipped += 1;
            continue;
          }
          const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
          records.push(makeRecord(sourceId, "filesystem.metadata", input.now, {
            ...(includePaths ? { path: canonical } : {}),
            pathHash: hashPath(canonical),
            relativePath: relative(item.root, canonical),
            kind,
            size: stat.size,
            modifiedAt: Number.isFinite(stat.mtimeMs) ? new Date(stat.mtimeMs).toISOString() : undefined,
            createdAt: stat.birthtimeMs !== undefined && Number.isFinite(stat.birthtimeMs)
              ? new Date(stat.birthtimeMs).toISOString()
              : undefined,
            mode: stat.mode,
            extension: kind === "file" ? extname(basename(canonical)).toLowerCase() || undefined : undefined,
            adapter: "filesystem-metadata-v1",
            contentOmitted: true,
          }));

          if (stat.isDirectory() && item.depth < maxDepth) {
            const entries = (await input.fileSystem.readdir(canonical)).slice().sort((a, b) => a.name.localeCompare(b.name));
            for (const entry of entries) {
              if (entry.isSymbolicLink()) {
                skipped += 1;
                continue;
              }
              const child = resolve(canonical, entry.name);
              if (!isWithinRoot(item.root, child)) {
                skipped += 1;
                continue;
              }
              queue.push({ path: child, root: item.root, depth: item.depth + 1 });
            }
          }
        } catch {
          skipped += 1;
        }
      }

      const complete = queue.length === 0;
      return {
        sourceId,
        capturedAt: nowIso(input.now),
        records,
        complete,
        nextCursor: complete ? undefined : queue[0]?.path,
        skipped,
        reason: records.length === 0 ? "file_metadata_unavailable" : undefined,
      };
    },
  };
}

function createAppActivityAdapter(input: {
  readonly platform: SupportedPlatform;
  readonly now: () => Date;
  readonly systemPreferences?: SystemPreferencesLike;
  readonly provider?: AppActivityProvider;
}): ProactiveSourceAdapter {
  const sourceId = "device.app_activity" as const;

  const accessibilityStatus = (): ProfileOsStatus => {
    if (input.platform !== "darwin") return "unknown";
    if (!input.systemPreferences?.isTrustedAccessibilityClient) return "unknown";
    try {
      return input.systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied";
    } catch {
      return "unknown";
    }
  };

  const probe = async (): Promise<ProactiveSourceProbe> => {
    if (input.provider?.probe) {
      try {
        const override = await input.provider.probe();
        return normalizeProbe(sourceId, input.platform, input.now, {
          ...override,
          ready: override.ready === true && Boolean(input.provider.list),
          reason: override.ready === true && !input.provider.list
            ? "app_activity_provider_unavailable"
            : override.reason,
        }, "app_activity_probe_override");
      } catch (error) {
        return normalizeProbe(sourceId, input.platform, input.now, {
          status: "unknown",
          osStatus: "unknown",
          ready: false,
          canRequest: false,
          reason: error instanceof Error ? error.message : "app_activity_probe_failed",
        });
      }
    }
    const osStatus = accessibilityStatus();
    if (osStatus === "denied") {
      return normalizeProbe(sourceId, input.platform, input.now, {
        status: "denied",
        osStatus,
        ready: false,
        canRequest: input.platform === "darwin",
        reason: "accessibility_permission_denied",
      });
    }
    if (!input.provider?.list) {
      return normalizeProbe(sourceId, input.platform, input.now, {
        status: "unavailable",
        osStatus,
        ready: false,
        canRequest: input.platform === "darwin",
        reason: "app_activity_provider_unavailable",
      });
    }
    // A list function without an authoritative permission probe must not be
    // treated as granted. Native providers should implement `probe`.
    return normalizeProbe(sourceId, input.platform, input.now, {
      status: "unknown",
      osStatus,
      ready: false,
      canRequest: Boolean(input.provider.request),
      reason: "app_activity_permission_probe_required",
    });
  };

  return {
    sourceId,
    probe,
    async request() {
      try {
        await input.provider?.request?.();
        if (input.platform === "darwin") input.systemPreferences?.isTrustedAccessibilityClient?.(true);
      } catch {
        // The subsequent probe is authoritative.
      }
      return probe();
    },
    async capture(options = {}) {
      const state = await probe();
      if (!state.ready || !input.provider?.list) return emptyBatch(sourceId, input.now, state.reason ?? EMPTY_REASON);
      const maxItems = boundedInt(options.maxItems, 64, 1, 500);
      try {
        const entries = await input.provider.list({
          includeSensitiveMetadata: options.allowSensitiveContent === true,
          maxItems,
        });
        const records = entries.slice(0, maxItems).map((entry) => makeRecord(sourceId, "app.activity.metadata", input.now, {
          applicationId: entry.applicationId,
          applicationName: entry.applicationName,
          bundleId: entry.bundleId,
          processId: entry.processId,
          ...(options.allowSensitiveContent === true && entry.processPath ? { processPath: entry.processPath } : {}),
          activeSince: entry.activeSince,
          activeForMs: entry.activeForMs,
          isFrontmost: entry.isFrontmost,
          adapter: "app-activity-provider-v1",
          // Window titles, URLs, command lines and arbitrary provider fields are
          // intentionally excluded from the default payload.
          contentOmitted: true,
        }));
        return {
          sourceId,
          capturedAt: nowIso(input.now),
          records,
          complete: entries.length <= maxItems,
          nextCursor: entries.length > maxItems ? String(maxItems) : undefined,
        };
      } catch (error) {
        return emptyBatch(sourceId, input.now, error instanceof Error ? error.message : "app_activity_capture_failed");
      }
    },
  };
}

/**
 * Construct the four CAP-033 wide-source adapters.
 *
 * The factory does not import Electron at runtime. Pass `systemPreferences`,
 * `screen`, and `desktopCapturer` from the Electron main process, plus trusted
 * native providers for app activity/browser bridges when those are available.
 */
export function createProactiveSourceAdapters(
  dependencies: ProactiveSourceAdapterDependencies = {},
): ProactiveSourceAdapters {
  const platform = dependencies.platform ?? process.platform;
  const env = dependencies.env ?? process.env;
  const homeDir = dependencies.homeDir ?? platformHome(platform, env, osHomedir());
  const now = dependencies.now ?? (() => new Date());
  const fileSystem = mergeFileSystem(dependencies.fileSystem);
  const configuredRoots = uniquePaths(dependencies.fileRoots ?? []);

  const screenCapture = createScreenCaptureAdapter({
    platform,
    now,
    systemPreferences: dependencies.systemPreferences,
    screen: dependencies.screen,
    desktopCapturer: dependencies.desktopCapturer,
    provider: dependencies.screenCapture,
  });
  const browserHistory = createBrowserHistoryAdapter({
    platform,
    homeDir,
    env,
    now,
    fileSystem,
    provider: dependencies.browserHistory,
  });
  const fileMetadata = createFileMetadataAdapter({
    platform,
    now,
    fileSystem,
    configuredRoots,
    fullDiskAccessProbe: dependencies.fullDiskAccessProbe,
  });
  const appActivity = createAppActivityAdapter({
    platform,
    now,
    systemPreferences: dependencies.systemPreferences,
    provider: dependencies.appActivity,
  });
  const all = [screenCapture, browserHistory, fileMetadata, appActivity] as const;
  const byId = new Map<ProactiveWideSourceId, ProactiveSourceAdapter>(all.map((adapter) => [adapter.sourceId, adapter]));

  return {
    screenCapture,
    browserHistory,
    fileMetadata,
    appActivity,
    all,
    get(sourceId) {
      const adapter = byId.get(sourceId);
      if (!adapter) throw new Error(`unknown_proactive_source: ${sourceId}`);
      return adapter;
    },
    async probe(sourceId) {
      const adapter = byId.get(sourceId as ProactiveWideSourceId);
      return adapter ? adapter.probe() : undefined;
    },
    async probeAll() {
      return Promise.all(all.map((adapter) => adapter.probe()));
    },
    capture(sourceId, options) {
      const adapter = byId.get(sourceId);
      if (!adapter) throw new Error(`unknown_proactive_source: ${sourceId}`);
      return adapter.capture(options);
    },
    captureAll(options) {
      return Promise.all(all.map((adapter) => adapter.capture(options)));
    },
    async request(sourceId) {
      const adapter = this.get(sourceId);
      return adapter.request ? adapter.request() : adapter.probe();
    },
    async close() {
      await Promise.all(all.map(async (adapter) => {
        await adapter.close?.();
      }));
    },
  };
}

/** Explicit alias used by callers that want to emphasize Electron wiring. */
export const createElectronProactiveSourceAdapters = createProactiveSourceAdapters;

/** Build a host-compatible probe callback without granting unsupported sources. */
export function createProactiveCapabilityProbe(
  adapters: ProactiveSourceAdapters,
): (sourceId: ProfileSourceId) => Promise<ProactiveCapabilityProbeResult | undefined> {
  return async (sourceId) => {
    const result = await adapters.probe(sourceId);
    return result ? toCapabilityProbe(result) : undefined;
  };
}
