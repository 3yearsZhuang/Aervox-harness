import type { ProfileOsStatus } from "@aervox/contracts/proactive";
import { type SupportedPlatform, type ProactiveSourceProbe, type ProactiveSourceAdapter, type SystemPreferencesLike, type AppActivityProvider } from "./types";
import { EMPTY_REASON, nowIso, boundedInt, normalizeProbe, emptyBatch, makeRecord } from "./shared";

export function createAppActivityAdapter(input: {
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
