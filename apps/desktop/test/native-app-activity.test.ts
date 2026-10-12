import { describe, it, expect, vi, beforeEach } from "vitest";
const calls = vi.hoisted(() => ({ methods: [] as string[], reset: vi.fn(), close: vi.fn(), capture: vi.fn() }));
vi.mock("@aervox/native-runtime", () => ({ NativeRuntimeClient: class {
  async request(method: string) { calls.methods.push(method); return method === "activity.capture" ? calls.capture() : { ready: true, status: "granted" }; }
  reset = calls.reset; close = calls.close;
} }));
import { createNativeAppActivityProvider, type NativeActivityLease } from "../src/main/native-app-activity.js";
const lease: NativeActivityLease = { deviceId: "d", revisionId: "r", epoch: "e", ttlMs: 5000, source: "device.app_activity" };
beforeEach(() => { vi.clearAllMocks(); calls.methods = []; calls.capture.mockResolvedValue({ records: [{ applicationId: "app", processId: 1, windowTitle: "secret", processPath: "/secret" }] }); });
describe("native activity authorization bridge", () => {
  it("does not capture without a current Host lease", async () => {
    const provider = createNativeAppActivityProvider({ artifact: { binary: "/unused", sha256: "0".repeat(64) }, getLease: async () => null });
    expect(await provider.list!({ includeSensitiveMetadata: false, maxItems: 10 })).toEqual([]);
    expect(calls.methods).not.toContain("activity.capture"); expect(calls.reset).toHaveBeenCalled();
  });
  it("discards a late response after revision or device changes and strips content fields", async () => {
    let current: NativeActivityLease | null = lease;
    const provider = createNativeAppActivityProvider({ artifact: { binary: "/unused", sha256: "0".repeat(64) }, getLease: async () => current });
    const records = await provider.list!({ includeSensitiveMetadata: true, maxItems: 10 });
    expect(records[0]).toMatchObject({ applicationId: "app", processId: 1 });
    expect(records[0]).not.toHaveProperty("windowTitle"); expect(records[0]).not.toHaveProperty("processPath");
    calls.capture.mockImplementationOnce(async () => { current = { ...lease, revisionId: "revoked" }; return { records: [{ applicationId: "old" }] }; });
    expect(await provider.list!({ includeSensitiveMetadata: false, maxItems: 10 })).toEqual([]);
    expect(calls.reset).toHaveBeenCalled();
    await provider.close(); expect(calls.close).toHaveBeenCalled();
  });
});
