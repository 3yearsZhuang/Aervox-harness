import { describe, it, expect, vi, beforeEach } from "vitest";
const calls = vi.hoisted(() => ({ methods: [] as string[], reset: vi.fn(), close: vi.fn(), capture: vi.fn(), lease: vi.fn() }));
vi.mock("@aervox/native-runtime", () => ({ NativeRuntimeClient: class {
  async request(method: string) {
    calls.methods.push(method);
    if (method === "activity.capture") return calls.capture();
    if (method === "activity.lease") return calls.lease();
    return { ready: true, status: "granted" };
  }
  reset = calls.reset; close = calls.close;
} }));
import { createNativeAppActivityProvider, type NativeActivityLease } from "../src/main/native-app-activity.js";
const lease: NativeActivityLease = { deviceId: "d", revisionId: "r", epoch: "e", ttlMs: 5000, source: "device.app_activity" };
beforeEach(() => {
  vi.clearAllMocks(); calls.methods = [];
  calls.lease.mockResolvedValue({ active: true });
  calls.capture.mockResolvedValue({ records: [{ applicationId: "app", processId: 1, windowTitle: "secret", processPath: "/secret" }] });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
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
  it("invalidates pending authorization and queued captures on revoke, allowing only new calls afterward", async () => {
    const authorization = deferred<NativeActivityLease | null>();
    const getLease = vi.fn().mockImplementationOnce(() => authorization.promise).mockResolvedValue(lease);
    const provider = createNativeAppActivityProvider({ artifact: { binary: "/unused", sha256: "0".repeat(64) }, getLease });
    const first = provider.list!({ includeSensitiveMetadata: false, maxItems: 10 });
    const queued = provider.list!({ includeSensitiveMetadata: false, maxItems: 10 });
    await vi.waitFor(() => expect(getLease).toHaveBeenCalledOnce());
    await provider.revoke();
    authorization.resolve(lease);
    expect(await first).toEqual([]);
    expect(await queued).toEqual([]);
    expect(getLease).toHaveBeenCalledOnce();
    expect(calls.methods).toEqual([]);
    expect(await provider.list!({ includeSensitiveMetadata: false, maxItems: 10 })).toHaveLength(1);
    expect(calls.methods).toEqual(["activity.lease", "activity.capture"]);
    await provider.close();
  });
  it("does not submit capture after revoke interrupts an in-flight lease request", async () => {
    const nativeLease = deferred<unknown>();
    calls.lease.mockImplementationOnce(() => nativeLease.promise);
    const provider = createNativeAppActivityProvider({ artifact: { binary: "/unused", sha256: "0".repeat(64) }, getLease: async () => lease });
    const capture = provider.list!({ includeSensitiveMetadata: false, maxItems: 10 });
    await vi.waitFor(() => expect(calls.methods).toEqual(["activity.lease"]));
    await provider.revoke();
    nativeLease.resolve({ active: true });
    expect(await capture).toEqual([]);
    expect(calls.methods).toEqual(["activity.lease"]);
    await provider.close();
  });
  it("discards an in-flight capture after revoke even if the authorization snapshot still matches", async () => {
    const response = deferred<{ records: Array<{ applicationId: string }> }>();
    calls.capture.mockImplementationOnce(() => response.promise);
    const provider = createNativeAppActivityProvider({ artifact: { binary: "/unused", sha256: "0".repeat(64) }, getLease: async () => lease });
    const capture = provider.list!({ includeSensitiveMetadata: false, maxItems: 10 });
    await vi.waitFor(() => expect(calls.capture).toHaveBeenCalledOnce());
    await provider.revoke();
    response.resolve({ records: [{ applicationId: "old" }] });
    expect(await capture).toEqual([]);
    await provider.close();
  });
});
