import type { ProfileOsStatus, ProfileSourceId } from "@aervox/contracts/proactive";

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

export type MediaPermission = "not-determined" | "granted" | "denied" | "restricted" | "unknown";

export interface SystemPreferencesLike {
  getMediaAccessStatus?: (mediaType: "screen") => MediaPermission;
  isTrustedAccessibilityClient?: (prompt: boolean) => boolean;
}

export interface DisplayLike {
  readonly id?: number | string;
  readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly workArea?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly scaleFactor?: number;
  readonly rotation?: number;
}

export interface ScreenLike {
  getAllDisplays?: () => readonly DisplayLike[];
}

export interface DesktopSourceLike {
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

export type ProbeOverride = ProactiveSourceProbeOverride;
