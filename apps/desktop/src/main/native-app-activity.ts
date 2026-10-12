import { NativeRuntimeClient, type NativeArtifact } from "@aervox/native-runtime";
import type { AppActivityProvider, AppActivityRecord, ProactiveSourceProbeOverride } from "./proactive-source-adapters.js";

export interface NativeActivityLease {
  deviceId: string; revisionId: string; epoch: string; ttlMs: number; source: "device.app_activity";
}
/** Grant/revision ownership remains in the trusted TS host. No renderer supplies leases. */
export function createNativeAppActivityProvider(options: {
  artifact: NativeArtifact;
  getLease: () => Promise<NativeActivityLease | null>;
}): AppActivityProvider & { close(): Promise<void>; revoke(): Promise<void> } {
  const runtime = new NativeRuntimeClient(options.artifact, { idleMs: 15_000 });
  let serial: Promise<unknown> = Promise.resolve();
  return {
    async probe() {
      try { return await runtime.request<ProactiveSourceProbeOverride>("activity.probe"); }
      catch { return { status: "unavailable", osStatus: "unknown", ready: false, canRequest: false, reason: "native_activity_artifact_unavailable" }; }
    },
    async list() {
      const run = serial.then(async () => {
        const lease = await options.getLease();
        if (!lease) { await runtime.reset(); return []; }
        await runtime.request("activity.lease", lease);
        const captured = await runtime.request<{ records: AppActivityRecord[] }>("activity.capture", lease);
        // An asynchronous OS capture cannot outlive the authorization snapshot it started with.
        const current = await options.getLease();
        if (!current || current.deviceId !== lease.deviceId || current.revisionId !== lease.revisionId || current.epoch !== lease.epoch) {
          await runtime.reset(); return [];
        }
        if (!Array.isArray(captured.records) || captured.records.length > 1) throw new Error("native_activity_response_invalid");
        return captured.records.map(record => ({
          applicationId: record.applicationId, applicationName: record.applicationName,
          bundleId: record.bundleId, processId: record.processId, isFrontmost: record.isFrontmost,
          activeSince: typeof record.activeSinceMs === "number" && Number.isFinite(record.activeSinceMs)
            ? new Date(record.activeSinceMs).toISOString() : undefined,
          activeForMs: record.activeForMs,
        }));
      });
      serial = run.catch(() => undefined);
      return run;
    },
    async request() { await runtime.request("activity.request"); },
    async close() { await runtime.close(); await serial; },
    async revoke() { await runtime.reset(); },
  };
}
