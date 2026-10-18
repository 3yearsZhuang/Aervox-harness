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

import { homedir as osHomedir } from "node:os";
import { type ProactiveWideSourceId, type ProactiveSourceAdapter, type ProactiveSourceAdapters, type ProactiveSourceAdapterDependencies } from "./types";
import { mergeFileSystem, uniquePaths, platformHome } from "./shared";

import { createScreenCaptureAdapter } from "./screen";
import { createBrowserHistoryAdapter } from "./browser-history";
import { createFileMetadataAdapter } from "./file-metadata";
import { createAppActivityAdapter } from "./app-activity";
export {
  PROACTIVE_WIDE_SOURCE_IDS,
  type ProactiveWideSourceId,
  type SupportedPlatform,
  type ProactiveSourceCaptureOptions,
  type ProactiveSourceProbe,
  type ProactiveCaptureRecord,
  type ProactiveCaptureBatch,
  type ProactiveSourceAdapter,
  type ProactiveSourceAdapters,
  type ProactiveCapabilityProbeResult,
  toCapabilityProbe,
  type SystemPreferencesLike,
  type ScreenLike,
  type DesktopCapturerLike,
  type ScreenCaptureProvider,
  type BrowserHistoryMetadata,
  type BrowserHistoryProvider,
  type AppActivityRecord,
  type AppActivityProvider,
  type FileStatLike,
  type FileDirentLike,
  type FileSystemLike,
  type FullDiskAccessProbe,
  type ProactiveSourceAdapterDependencies,
  type ProactiveSourceProbeOverride
} from "./types";

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
