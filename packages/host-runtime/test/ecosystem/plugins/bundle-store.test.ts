import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { PageAssetBoundaryError, PluginBundleStore } from "../../../src/modules/ecosystem/plugins/bundle-store.js";

const limits = { entries: 20, bytes: 1024, entryBytes: 512 };

describe("PluginBundleStore Page file boundary", () => {
  let temporary: string;
  let root: string;
  let outside: string;
  let page: string;
  let store: PluginBundleStore;

  beforeEach(async () => {
    temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aervox-page-boundary-")));
    root = path.join(temporary, "plugins");
    outside = path.join(temporary, "outside");
    page = path.join(root, "demo", "pages", "dashboard");
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "canary.txt"), "KEEP_OUTSIDE");
    store = new PluginBundleStore(root);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(temporary, { recursive: true, force: true });
  });

  it("creates nested resources, overwrites the same file and preserves bytes/hash/export", async () => {
    const first = Buffer.from([0, 255, 10, 42]);
    expect(await store.writeAsset("demo", "dashboard", "nested/image.png", first))
      .toBe(crypto.createHash("sha256").update(first).digest("hex"));
    const target = path.join(page, "nested", "image.png");
    const before = await fs.stat(target);
    const replacement = Buffer.from([9, 0]);
    await store.writeAsset("demo", "dashboard", "nested/image.png", replacement);
    expect((await fs.stat(target)).ino).toBe(before.ino);
    expect((await store.readAsset("demo", "dashboard", "nested/image.png")).content).toEqual(replacement);
    expect(await store.exportPageAssets("demo", "dashboard", limits))
      .toEqual({ "nested/image.png": new Uint8Array(replacement) });
    await fs.writeFile(path.join(page, "large.txt"), Buffer.alloc(513));
    await expect(store.exportPageAssets("demo", "dashboard", limits)).rejects.toThrow("export limits");
  });

  it("permits a configured storage-root alias while rejecting links below it", async () => {
    const alias = path.join(temporary, "root-alias");
    await fs.symlink(root, alias, "dir");
    const aliased = new PluginBundleStore(alias);
    await aliased.writeAsset("demo", "dashboard", "index.html", Buffer.from("LOCAL"));
    expect((await aliased.readAsset("demo", "dashboard", "index.html")).content.toString()).toBe("LOCAL");
    expect(await aliased.exportPageAssets("demo", "dashboard", limits)).toHaveProperty("index.html");
  });

  it.each(["demo", "demo/pages", "demo/pages/dashboard", "demo/pages/dashboard/nested"])
    ("rejects an existing directory link at %s before creating outside directories", async (relative) => {
      const link = path.join(root, ...relative.split("/"));
      await fs.mkdir(path.dirname(link), { recursive: true });
      await fs.symlink(outside, link, "dir");
      await expect(store.writeAsset("demo", "dashboard", "nested/new/deep.txt", Buffer.from("ATTACK")))
        .rejects.toBeInstanceOf(PageAssetBoundaryError);
      expect(await fs.readdir(outside)).toEqual(["canary.txt"]);
      expect(await fs.readFile(path.join(outside, "canary.txt"), "utf8")).toBe("KEEP_OUTSIDE");
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(link)).toBe(outside);
    });

  it("rejects a final file link without overwriting its target or unlinking it", async () => {
    await fs.mkdir(page, { recursive: true });
    const link = path.join(page, "canary.txt");
    await fs.symlink(path.join(outside, "canary.txt"), link);
    await expect(store.writeAsset("demo", "dashboard", "canary.txt", Buffer.from("ATTACK")))
      .rejects.toBeInstanceOf(PageAssetBoundaryError);
    await expect(store.readAsset("demo", "dashboard", "canary.txt")).rejects.toBeInstanceOf(PageAssetBoundaryError);
    await expect(store.exportPageAssets("demo", "dashboard", limits)).rejects.toThrow("symlink");
    expect(await fs.readFile(path.join(outside, "canary.txt"), "utf8")).toBe("KEEP_OUTSIDE");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
  });

  it("rejects a link to another Page inside the same Bundle", async () => {
    await fs.mkdir(page, { recursive: true });
    const otherPage = path.join(root, "demo", "pages", "other");
    await fs.mkdir(otherPage);
    await fs.writeFile(path.join(otherPage, "keep.txt"), "KEEP_OTHER_PAGE");
    const link = path.join(page, "linked");
    await fs.symlink(otherPage, link, "dir");
    await expect(store.writeAsset("demo", "dashboard", "linked/keep.txt", Buffer.from("ATTACK")))
      .rejects.toBeInstanceOf(PageAssetBoundaryError);
    await expect(store.readAsset("demo", "dashboard", "linked/keep.txt")).rejects.toBeInstanceOf(PageAssetBoundaryError);
    await expect(store.exportPageAssets("demo", "dashboard", limits)).rejects.toThrow("symlink");
    expect(await fs.readFile(path.join(otherPage, "keep.txt"), "utf8")).toBe("KEEP_OTHER_PAGE");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
  });

  it("rejects a hardlinked resource for write/read/export and leaves both names intact", async () => {
    await fs.mkdir(page, { recursive: true });
    const linked = path.join(page, "canary.txt");
    await fs.link(path.join(outside, "canary.txt"), linked);
    await expect(store.writeAsset("demo", "dashboard", "canary.txt", Buffer.from("ATTACK")))
      .rejects.toBeInstanceOf(PageAssetBoundaryError);
    await expect(store.readAsset("demo", "dashboard", "canary.txt")).rejects.toBeInstanceOf(PageAssetBoundaryError);
    await expect(store.exportPageAssets("demo", "dashboard", limits)).rejects.toBeInstanceOf(PageAssetBoundaryError);
    expect(await fs.readFile(linked, "utf8")).toBe("KEEP_OUTSIDE");
    expect(await fs.readFile(path.join(outside, "canary.txt"), "utf8")).toBe("KEEP_OUTSIDE");
    expect((await fs.stat(linked)).nlink).toBe(2);
  });

  it.each(["../outside/canary.txt", "/absolute.txt", "nested/../file.txt", "nested\\file.txt", "nul\0.txt"])
    ("rejects invalid resource path %j before creating the Page", async (relative) => {
      await expect(store.writeAsset("demo", "dashboard", relative, Buffer.from("ATTACK")))
        .rejects.toBeInstanceOf(PageAssetBoundaryError);
      expect(await fs.readdir(root)).toEqual([]);
    });

  it("does not truncate an existing inode when an ancestor becomes a link during open", async () => {
    await fs.mkdir(page, { recursive: true });
    await fs.writeFile(path.join(page, "canary.txt"), "KEEP_LOCAL");
    const savedPage = `${page}-saved`;
    const originalOpen = fs.open.bind(fs);
    const opened = vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
      if (target === path.join(page, "canary.txt")) {
        await fs.rename(page, savedPage);
        await fs.symlink(outside, page, "dir");
      }
      return originalOpen(target, flags, mode);
    });
    await expect(store.writeAsset("demo", "dashboard", "canary.txt", Buffer.from("ATTACK")))
      .rejects.toBeInstanceOf(PageAssetBoundaryError);
    expect(opened).toHaveBeenCalled();
    expect(await fs.readFile(path.join(outside, "canary.txt"), "utf8")).toBe("KEEP_OUTSIDE");
    expect(await fs.readFile(path.join(savedPage, "canary.txt"), "utf8")).toBe("KEEP_LOCAL");
  });

  it("does not truncate a hardlink substituted between lstat and open", async () => {
    await fs.mkdir(page, { recursive: true });
    const target = path.join(page, "canary.txt");
    await fs.writeFile(target, "KEEP_LOCAL");
    const originalOpen = fs.open.bind(fs);
    const opened = vi.spyOn(fs, "open").mockImplementation(async (openedPath, flags, mode) => {
      if (openedPath === target) {
        await fs.rename(target, `${target}.saved`);
        await fs.link(path.join(outside, "canary.txt"), target);
      }
      return originalOpen(openedPath, flags, mode);
    });
    await expect(store.writeAsset("demo", "dashboard", "canary.txt", Buffer.from("ATTACK")))
      .rejects.toBeInstanceOf(PageAssetBoundaryError);
    expect(opened).toHaveBeenCalled();
    expect(await fs.readFile(path.join(outside, "canary.txt"), "utf8")).toBe("KEEP_OUTSIDE");
    expect(await fs.readFile(`${target}.saved`, "utf8")).toBe("KEEP_LOCAL");
  });

  it("rejects generation writes before creating resources and reads the active generation", async () => {
    const generation = "12345678-1234-1234-1234-123456789012";
    store.setGenerationResolver(async () => generation);
    await expect(store.writeAsset("demo", "dashboard", "index.html", Buffer.from("ATTACK")))
      .rejects.toThrow("immutable");
    expect(await fs.readdir(root)).toEqual([]);
    const generationPage = path.join(root, "demo", "releases", generation, "content", "pages", "dashboard");
    await fs.mkdir(generationPage, { recursive: true });
    await fs.writeFile(path.join(generationPage, "index.html"), "GENERATION");
    expect((await store.readAsset("demo", "dashboard", "index.html")).content.toString()).toBe("GENERATION");
    expect(await store.exportPageAssets("demo", "dashboard", limits)).toHaveProperty("index.html");
  });

  it("rejects generation ancestors that link to external Page resources", async () => {
    const generation = "12345678-1234-1234-1234-123456789012";
    store.setGenerationResolver(async () => generation);
    await fs.mkdir(path.join(root, "demo"));
    await fs.symlink(outside, path.join(root, "demo", "releases"), "dir");
    await fs.mkdir(path.join(outside, generation, "content", "pages", "dashboard"), { recursive: true });
    await fs.writeFile(path.join(outside, generation, "content", "pages", "dashboard", "index.html"), "OUTSIDE_GENERATION");
    await expect(store.readAsset("demo", "dashboard", "index.html")).rejects.toBeInstanceOf(PageAssetBoundaryError);
    await expect(store.exportPageAssets("demo", "dashboard", limits)).rejects.toBeInstanceOf(PageAssetBoundaryError);
    expect(await fs.readFile(path.join(outside, "canary.txt"), "utf8")).toBe("KEEP_OUTSIDE");
  });
});
