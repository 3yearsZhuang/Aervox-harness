import { describe, it, expect } from "vitest";
import { zipSync, unzipSync } from "fflate";
import { executeArchive } from "../src/modules/ecosystem/plugins/archive-worker.js";
import { isSafeZipEntryPath, PLUGIN_ARCHIVE_LIMITS } from "../src/modules/ecosystem/plugins/package-bundle.js";

describe("bounded plugin archive CPU isolation", () => {
  it("preserves bytes and path/expansion checks through the Worker", async () => {
    const files = { "a.txt": [new Uint8Array([1, 2, 3]), { mtime: new Date("2026-01-01T00:00:00Z") }] } as const;
    const packed = await executeArchive<Uint8Array>({ kind: "pack", input: files, limits: PLUGIN_ARCHIVE_LIMITS, isSafePath: isSafeZipEntryPath });
    expect(packed).toEqual(zipSync(files, { level: 6 }));
    expect(await executeArchive({ kind: "unpack", input: packed, limits: PLUGIN_ARCHIVE_LIMITS, isSafePath: isSafeZipEntryPath })).toEqual(unzipSync(packed));
    await expect(executeArchive({ kind: "unpack", input: zipSync({ "../escape": new Uint8Array([1]) }), limits: PLUGIN_ARCHIVE_LIMITS, isSafePath: isSafeZipEntryPath })).rejects.toThrow("Unsafe");
    await expect(executeArchive({ kind: "unpack", input: packed, limits: { ...PLUGIN_ARCHIVE_LIMITS, entryBytes: 1 }, isSafePath: isSafeZipEntryPath })).rejects.toThrow("limit");
  });
  it("aborts work and recovers capacity", async () => {
    const controller = new AbortController();
    const operation = executeArchive({ kind: "pack", input: { "large.txt": new Uint8Array(4 * 1024 * 1024) }, limits: PLUGIN_ARCHIVE_LIMITS, isSafePath: isSafeZipEntryPath, signal: controller.signal });
    const assertion = expect(operation).rejects.toThrow("cancelled"); controller.abort(); await assertion;
    expect(await executeArchive<Uint8Array>({ kind: "pack", input: { "a": new Uint8Array([1]) }, limits: PLUGIN_ARCHIVE_LIMITS, isSafePath: isSafeZipEntryPath })).toBeInstanceOf(Uint8Array);
  });
});
