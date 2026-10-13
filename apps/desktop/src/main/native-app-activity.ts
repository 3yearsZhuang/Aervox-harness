import { NativeRuntimeClient, type NativeArtifact } from "@aervox/native-runtime";
import type { AppActivityProvider } from "./proactive-source-adapters.js";

export type { ActivityLease as NativeActivityLease } from "@aervox/native-runtime";
import type { ActivityLease as NativeActivityLease } from "@aervox/native-runtime";
/** Grant/revision ownership remains in the trusted TS host. No renderer supplies leases. */
export function createNativeAppActivityProvider(options: {
  artifact: NativeArtifact;
  getLease: () => Promise<NativeActivityLease | null>;
}): AppActivityProvider & { close(): Promise<void>; revoke(): Promise<void> } {
  const runtime = new NativeRuntimeClient(options.artifact, { idleMs: 15_000 });
  let serial: Promise<unknown> = Promise.resolve();
  let generation = 0;
  let closed = false;
  return {
    async probe() {
      try { return await runtime.request("activity.probe"); }
      catch { return { status: "unavailable", osStatus: "unknown", ready: false, canRequest: false, reason: "native_activity_artifact_unavailable" }; }
    },
    async list() {
      // Capture ownership before queuing: revoke also invalidates work waiting on getLease().
      const epoch = generation;
      const isCurrent = () => !closed && epoch === generation;
      const run = serial.then(async () => {
        if (!isCurrent()) return [];
        const lease = await options.getLease();
        if (!isCurrent()) return [];
        if (!lease) { await runtime.reset(); return []; }
        await runtime.request("activity.lease", lease);
        if (!isCurrent()) return [];
        const captured = await runtime.request("activity.capture", lease);
        if (!isCurrent()) return [];
        // An asynchronous OS capture cannot outlive the authorization snapshot it started with.
        const current = await options.getLease();
        if (!isCurrent()) return [];
        if (!current || current.deviceId !== lease.deviceId || current.revisionId !== lease.revisionId || current.epoch !== lease.epoch) {
          await runtime.reset(); return [];
        }
        if (!Array.isArray(captured.records) || captured.records.length > 1) throw new Error("native_activity_response_invalid");
        return captured.records.map(record => ({
          applicationId: record.applicationId, applicationName: record.applicationName ?? undefined,
          bundleId: record.bundleId ?? undefined, processId: record.processId, isFrontmost: record.isFrontmost,
          activeSince: typeof record.activeSinceMs === "number" && Number.isFinite(record.activeSinceMs)
            ? new Date(record.activeSinceMs).toISOString() : undefined,
          activeForMs: record.activeForMs,
        }));
      });
      serial = run.catch(() => undefined);
      return run;
    },
    async request() { await runtime.request("activity.request"); },
    async close() { closed = true; generation++; await runtime.close(); await serial; },
    async revoke() { generation++; await runtime.reset(); },
  };
}
