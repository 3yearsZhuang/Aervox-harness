import { describe, it, expect } from "vitest";
import { zipSync, unzipSync, strToU8 } from "fflate";
import { previewPersonaBundle } from "@aervox/host-runtime-test/modules/companion/persona/bundle";
import { computeRevisionChecksum, validatePersonaConfig } from "@aervox/host-runtime-test/modules/companion/persona/types";
import { unzip } from "@aervox/host-runtime-test/modules/ecosystem/skills/zip";
import { executeArchive } from "@aervox/host-runtime/shared/archive-worker";
import { isSafeZipEntryPath, PLUGIN_ARCHIVE_LIMITS } from "@aervox/host-runtime-test/modules/ecosystem/plugins/package-bundle";

describe("bounded plugin archive CPU isolation", () => {
  it("preserves resource bytes while normalizing archive timestamps and enforcing path/expansion checks", async () => {
    const files = { "a.txt": [new Uint8Array([1, 2, 3]), { mtime: new Date("2026-01-01T00:00:00Z") }] } as const;
    const packed = await executeArchive<Uint8Array>({ kind: "pack", input: files, limits: PLUGIN_ARCHIVE_LIMITS, isSafePath: isSafeZipEntryPath });
    const canonical = { "a.txt": [files["a.txt"][0], { mtime: new Date(1980, 0, 1, 0, 0, 0) }] } as const;
    expect(packed).toEqual(zipSync(canonical, { level: 9 }));
    expect(unzipSync(packed)["a.txt"]).toEqual(files["a.txt"][0]);
    const repacked = await executeArchive<Uint8Array>({ kind: "pack", input: {
      "a.txt": [files["a.txt"][0], { mtime: new Date("2027-01-01T00:00:00Z") }],
    }, limits: PLUGIN_ARCHIVE_LIMITS, isSafePath: isSafeZipEntryPath });
    expect(repacked).toEqual(packed);
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


describe("shared archive limits and compatibility", () => {
  it("Skill paths accept dot prefixes and Windows separators but reject absolute and duplicate normalized names", async () => {
    const archive = zipSync({ "./skill/SKILL.md": strToU8("skill"), "skill\\script.txt": strToU8("script"), "__MACOSX/ignored": strToU8("ignored") });
    expect((await unzip(Buffer.from(archive))).map(entry => entry.name)).toEqual(["skill/SKILL.md", "skill/script.txt"]);
    for (const path of ["/escape", "C:\\escape", "../escape", "skill/../escape"]) {
      await expect(unzip(Buffer.from(zipSync({ [path]: strToU8("x") })))).rejects.toThrow("Unsafe");
    }
    await expect(unzip(Buffer.from(zipSync({ "./skill/a": strToU8("x"), "skill/a": strToU8("y") })))).rejects.toThrow("Duplicate");
  });

  it("bounds actual inflate even when the central directory advertises a smaller output", async () => {
    const archive = Buffer.from(zipSync({ "a": new Uint8Array(16_384) }));
    const directory = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    archive.writeUInt32LE(1, directory + 24);
    await expect(executeArchive({ kind: "unpack", input: archive, limits: PLUGIN_ARCHIVE_LIMITS })).rejects.toThrow();
  });

  it("rejects files used as ancestor directories in either entry order after path normalization", async () => {
    for (const [file, child] of [["assets", "assets/icons/icon.svg"], ["Data", "data/child"], ["a/B", "A/b/c"]]) {
      const entries: Array<[string, Uint8Array]> = [[file!, strToU8("file")], [child!, strToU8("child")]];
      for (const ordered of [entries, [...entries].reverse()]) {
        const archive = zipSync(Object.fromEntries(ordered));
        await expect(executeArchive({ kind: "unpack", input: archive, limits: PLUGIN_ARCHIVE_LIMITS })).rejects.toThrow("Invalid zip archive");
        const normalized = zipSync(Object.fromEntries(ordered.map(([name, bytes]) => ["./" + name.replaceAll("/", "\\"), bytes])));
        await expect(unzip(Buffer.from(normalized))).rejects.toThrow("Invalid zip archive");
      }
    }
    await expect(unzip(Buffer.from(zipSync({ "SKILL.md": strToU8("one"), "skill.md": strToU8("two") })))).rejects.toThrow("Duplicate");
  });

  it("accepts explicit directories before or after their descendants", async () => {
    const entries: Array<[string, Uint8Array]> = [["assets/", new Uint8Array()], ["assets/icons/", new Uint8Array()], ["assets/icons/icon.svg", strToU8("icon")]];
    for (const ordered of [entries, [...entries].reverse()]) {
      const archive = zipSync(Object.fromEntries(ordered));
      expect(await executeArchive({ kind: "unpack", input: archive, limits: PLUGIN_ARCHIVE_LIMITS })).toEqual(unzipSync(archive));
      expect((await unzip(Buffer.from(archive))).find(entry => entry.name === "assets/icons/icon.svg")?.data.toString()).toBe("icon");
    }
  });

  it("rejects compressed, cumulative expanded, entry-count and checksum violations", async () => {
    const archive = zipSync({ a: new Uint8Array(8), b: new Uint8Array(8) }, { level: 0 });
    for (const limits of [
      { ...PLUGIN_ARCHIVE_LIMITS, compressedBytes: 1 },
      { ...PLUGIN_ARCHIVE_LIMITS, expandedBytes: 10 },
      { ...PLUGIN_ARCHIVE_LIMITS, entries: 1 },
    ]) await expect(executeArchive({ kind: "unpack", input: archive, limits })).rejects.toThrow("limit");
    const corrupted = Buffer.from(archive);
    corrupted[31] = 1;
    await expect(executeArchive({ kind: "unpack", input: corrupted, limits: PLUGIN_ARCHIVE_LIMITS })).rejects.toThrow("checksum");
    const zip64 = Buffer.from(archive);
    zip64.writeUInt32LE(0xffffffff, zip64.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
    await expect(unzip(zip64)).rejects.toThrow("zip64");
  });

  it("shares concurrency capacity across callers and releases it on cancellation", async () => {
    const controllers = [new AbortController(), new AbortController()];
    const operations = controllers.map(controller => executeArchive({ kind: "pack", input: { a: new Uint8Array(1024) }, limits: PLUGIN_ARCHIVE_LIMITS, signal: controller.signal }));
    const settled = Promise.allSettled(operations);
    const third = executeArchive({ kind: "unpack", input: zipSync({ a: new Uint8Array() }), limits: PLUGIN_ARCHIVE_LIMITS });
    controllers.forEach(controller => controller.abort());
    await expect(third).rejects.toThrow("busy");
    expect((await settled).every(result => result.status === "rejected")).toBe(true);
    await expect(unzip(Buffer.from(zipSync({ a: new Uint8Array() })))).resolves.toHaveLength(1);
  });

  it("Persona nested archives consume the remaining outer entry budget", async () => {
    const config = validatePersonaConfig({ systemPromptAppend: "hello" });
    const files = Object.fromEntries(Array.from({ length: 2044 }, (_, index) => [`outer-${index}`, new Uint8Array()]));
    const bytes = zipSync({ ...files,
      "manifest.json": strToU8(JSON.stringify({ schemaVersion: 1, personaChecksum: computeRevisionChecksum(config), skills: [] })),
      "persona.json": strToU8(JSON.stringify({ schemaVersion: 1, name: "test", config })),
      "skills/skills.zip": zipSync({ "one/SKILL.md": strToU8("one"), "two/SKILL.md": strToU8("two") }),
    });
    await expect(previewPersonaBundle(bytes, "local")).rejects.toThrow("entry limit");
  });
});
