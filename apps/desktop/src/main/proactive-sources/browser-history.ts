import { join, resolve } from "node:path";
import { type SupportedPlatform, type ProactiveSourceProbe, type ProactiveCaptureRecord, type ProactiveSourceAdapter, type BrowserHistoryProvider, type FileStatLike, type FileSystemLike } from "./types";
import { EMPTY_REASON, nowIso, boundedInt, hashPath, normalizeProbe, emptyBatch, makeRecord } from "./shared";

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

export function createBrowserHistoryAdapter(input: {
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
