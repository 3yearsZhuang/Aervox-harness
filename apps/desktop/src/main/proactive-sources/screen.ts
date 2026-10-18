import type { ProfileOsStatus } from "@aervox/contracts/proactive";
import { type SupportedPlatform, type ProactiveSourceProbe, type ProactiveCaptureRecord, type ProactiveSourceAdapter, type SystemPreferencesLike, type ScreenLike, type DesktopCapturerLike, type ScreenCaptureProvider, type ProbeOverride } from "./types";
import { EMPTY_REASON, nowIso, boundedInt, metadataOnly, mediaToStatus, normalizeProbe, emptyBatch, makeRecord } from "./shared";

export function createScreenCaptureAdapter(input: {
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
