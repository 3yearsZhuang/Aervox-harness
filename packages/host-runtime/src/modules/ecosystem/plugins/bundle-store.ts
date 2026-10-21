/**
 * Aervox｜思隅 @aervox/api — 插件 Page 静态资源存储（CAP-020 扩展 · CR-006）
 *
 * 只允许已安装插件 Bundle 本地资源：写入/读取严格限制在
 * <pluginsRoot>/<pluginId>/pages/<pageId>/ 内，拒绝路径穿越和链接资源。
 * 页面不能加载远程 URL；所有业务操作必须经过 Host Bridge。
 */
import fs from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

export function isSafeRelativePath(relPath: string): boolean {
  if (typeof relPath !== "string" || !relPath || relPath.length > 512 || relPath.includes("\0")) return false;
  if (relPath.startsWith("/") || relPath.includes("\\")) return false;
  if (/^[A-Za-z]:/.test(relPath)) return false;
  const parts = relPath.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return false;
  return true;
}

export class PageAssetBoundaryError extends Error {
  constructor(message: string) { super(message); this.name = "PageAssetBoundaryError"; }
}

interface DirectoryIdentity { path: string; dev: number; ino: number }
interface AssetBoundary { root: string; target: string; directories: DirectoryIdentity[] }

function sameFile(left: Stats, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function statIfPresent(target: string): Promise<Stats | null> {
  try { return await fs.lstat(target); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ENOTDIR" || code === "ELOOP") throw new PageAssetBoundaryError("invalid page asset directory");
    throw error;
  }
}

export class PluginBundleStore {
  constructor(private readonly root: string) {}

  private generationResolver?: (id: string) => Promise<string | null>;

  setGenerationResolver(resolver: (id: string) => Promise<string | null>): void {
    this.generationResolver = resolver;
  }

  private generationRoot(pluginId: string, generation: string): string {
    if (!/^(?!\.{1,2}$)[\w.-]+$/.test(pluginId) || !/^[a-f0-9-]{36}$/.test(generation)) {
      throw new Error("invalid plugin generation");
    }
    return path.join(this.root, pluginId, "releases", generation);
  }

  /** Stage bounded, validated content without changing anything visible to the active plugin. */
  async stageBundle(pluginId: string, files: Record<string, Uint8Array>, archive: Uint8Array,
    skills: Array<{name: string; content?: string}>): Promise<{generation: string; skillPaths: Map<string, string>}> {
    const generation = crypto.randomUUID();
    const root = this.generationRoot(pluginId, generation);
    const write = async (relative: string, data: Uint8Array): Promise<void> => {
      if (!isSafeRelativePath(relative)) throw new Error("invalid bundle resource");
      const target = path.join(root, relative);
      await fs.mkdir(path.dirname(target), {recursive: true, mode: 0o700});
      const file = await fs.open(target, "wx", 0o600);
      try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    };
    try {
      await fs.mkdir(this.root, {recursive: true, mode: 0o700});
      for (const directory of [path.join(this.root, pluginId), path.join(this.root, pluginId, "releases")]) {
        await fs.mkdir(directory, {recursive: true, mode: 0o700});
        if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error("symlink in plugin storage");
      }
      for (const [name, data] of Object.entries(files)) await write(`content/${name}`, data);
      await write("original.aervox-plugin", archive);
      await write("owner.json", Buffer.from(JSON.stringify({pluginId, generation, format: 1})));
      const skillPaths = new Map<string, string>();
      for (const skill of skills) {
        if (!/^(?!\.{1,2}$)[\w.-]+$/.test(skill.name)) throw new Error("invalid skill name");
        const relative = `skills/${skill.name}/SKILL.md`;
        await write(relative, Buffer.from(skill.content ?? ""));
        skillPaths.set(skill.name, path.join(root, relative));
      }
      // Files are durable before the SQLite pointer can reference them. Interrupted staging is invisible.
      const syncDirectories = async (dir: string): Promise<void> => {
        for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
          if (entry.isDirectory()) await syncDirectories(path.join(dir, entry.name));
        }
        const handle = await fs.open(dir, "r");
        try { await handle.sync(); }
        catch (error) { if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
        finally { await handle.close(); }
      };
      await syncDirectories(root);
      for (const directory of [path.dirname(root), path.dirname(path.dirname(root)), this.root]) {
        const handle = await fs.open(directory, "r");
        try { await handle.sync(); }
        catch (error) { if (!["EINVAL", "ENOTSUP", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
        finally { await handle.close(); }
      }
      return {generation, skillPaths};
    } catch (error) {
      await fs.rm(root, {recursive: true, force: true}).catch(() => undefined);
      throw error;
    }
  }

  async discardGeneration(pluginId: string, generation: string): Promise<void> {
    // Never erase files if a commit succeeded but its acknowledgement was interrupted.
    if (await this.generationResolver?.(pluginId) === generation) return;
    await fs.rm(this.generationRoot(pluginId, generation), {recursive: true, force: true});
  }

  async readOriginalBundle(pluginId: string, generation: string): Promise<Uint8Array> {
    return new Uint8Array(await fs.readFile(path.join(this.generationRoot(pluginId, generation), "original.aervox-plugin")));
  }

  async deletePluginResources(pluginId: string): Promise<void> {
    if (!/^(?!\.{1,2}$)[\w.-]+$/.test(pluginId)) throw new Error("invalid plugin id");
    const pluginRoot = path.join(this.root, pluginId);
    const releases = path.join(pluginRoot, "releases");
    const rootStat = await fs.lstat(releases).catch(() => null);
    if (rootStat?.isDirectory() && !rootStat.isSymbolicLink()) {
      for (const entry of await fs.readdir(releases, {withFileTypes: true})) {
        if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
        const directory = this.generationRoot(pluginId, entry.name);
        const owner = await fs.readFile(path.join(directory, "owner.json"), "utf8").then(JSON.parse).catch(() => null);
        if (owner?.format === 1 && owner.pluginId === pluginId && owner.generation === entry.name) {
          await fs.rm(directory, {recursive: true, force: true});
        }
      }
    }
    // Unknown notes, backups and legacy directories have no deletion authority.
    await fs.rmdir(releases).catch(() => undefined);
    await fs.rmdir(pluginRoot).catch(() => undefined);
  }

  private async pageRoot(pluginId: string, pageId: string): Promise<string> {
    if (!/^(?!\.{1,2}$)[\w.-]+$/.test(pluginId) || !/^[\w-]+$/.test(pageId)) throw new PageAssetBoundaryError("invalid page identity");
    const generation = await this.generationResolver?.(pluginId);
    return generation ? path.join(this.generationRoot(pluginId, generation), "content", "pages", pageId)
      : path.join(this.root, pluginId, "pages", pageId);
  }

  private async checkDirectories(directories: DirectoryIdentity[]): Promise<void> {
    for (const directory of directories) {
      const stat = await statIfPresent(directory.path);
      if (!stat?.isDirectory() || stat.isSymbolicLink() || !sameFile(stat, directory)
        || await fs.realpath(directory.path) !== directory.path) {
        throw new PageAssetBoundaryError("page asset directory changed or contains a symlink");
      }
    }
  }

  private async checkedDirectories(root: string, target: string, create: boolean): Promise<DirectoryIdentity[]> {
    // The configured root is trusted and may be a macOS/system path alias. Work from its canonical path.
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await fs.realpath(root) !== root) {
      throw new PageAssetBoundaryError("invalid page asset storage root");
    }
    const directories: DirectoryIdentity[] = [{ path: root, dev: rootStat.dev, ino: rootStat.ino }];
    const relative = path.relative(root, target);
    if (relative && !isSafeRelativePath(relative.split(path.sep).join("/"))) throw new PageAssetBoundaryError("invalid page asset directory");
    let current = root;
    for (const part of relative ? relative.split(path.sep) : []) {
      current = path.join(current, part);
      const stat = await statIfPresent(current);
      if (!stat && create) {
        await this.checkDirectories(directories);
        try { await fs.mkdir(current); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      const checked = stat ?? await statIfPresent(current);
      if (!checked?.isDirectory() || checked.isSymbolicLink() || await fs.realpath(current) !== current) {
        throw new PageAssetBoundaryError("page asset directory contains a symlink or is not a directory");
      }
      directories.push({ path: current, dev: checked.dev, ino: checked.ino });
    }
    return directories;
  }

  private async assetBoundary(pluginId: string, pageId: string, relPath: string, create: boolean): Promise<AssetBoundary> {
    if (!isSafeRelativePath(relPath)) throw new PageAssetBoundaryError("invalid page asset path");
    const base = path.resolve(await this.pageRoot(pluginId, pageId));
    const relativeBase = path.relative(path.resolve(this.root), base);
    if (!isSafeRelativePath(relativeBase.split(path.sep).join("/"))) throw new PageAssetBoundaryError("invalid page asset root");
    if (create) await fs.mkdir(this.root, { recursive: true });
    const root = await fs.realpath(this.root);
    const target = path.join(root, relativeBase, ...relPath.split("/"));
    const directories = await this.checkedDirectories(root, path.dirname(target), create);
    return { root, target, directories };
  }

  private async checkAssetFile(handle: FileHandle, boundary: AssetBoundary, expected?: Stats): Promise<Stats> {
    const opened = await handle.stat();
    const current = await statIfPresent(boundary.target);
    if (!opened.isFile() || opened.nlink !== 1 || !current?.isFile() || current.isSymbolicLink()
      || current.nlink !== 1 || !sameFile(opened, current) || (expected && !sameFile(opened, expected))) {
      throw new PageAssetBoundaryError("page asset is not a single regular file or changed during open");
    }
    await this.checkDirectories(boundary.directories);
    if (await fs.realpath(boundary.target) !== boundary.target) throw new PageAssetBoundaryError("page asset escapes page root");
    return opened;
  }

  private async openAsset(boundary: AssetBoundary, write: boolean): Promise<FileHandle> {
    const before = await statIfPresent(boundary.target);
    if ((before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)) || (!before && !write)) {
      throw new PageAssetBoundaryError("invalid page asset: not a single regular file or is a symlink");
    }
    await this.checkDirectories(boundary.directories);
    // Never truncate before checking the opened inode. NONBLOCK also prevents a swapped FIFO from hanging.
    const flags = (write ? constants.O_WRONLY : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_NONBLOCK ?? 0) | (!before && write ? constants.O_CREAT | constants.O_EXCL : 0);
    let handle: FileHandle;
    try { handle = await fs.open(boundary.target, flags, 0o600); }
    catch (error) {
      if (["ELOOP", "EEXIST", "ENOTDIR", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw new PageAssetBoundaryError("page asset changed or contains a symlink");
      }
      throw error;
    }
    try { await this.checkAssetFile(handle, boundary, before ?? undefined); return handle; }
    catch (error) { await handle.close(); throw error; }
  }

  private async readCheckedAsset(pluginId: string, pageId: string, relPath: string, maxBytes = Infinity): Promise<Buffer> {
    const boundary = await this.assetBoundary(pluginId, pageId, relPath, false);
    const handle = await this.openAsset(boundary, false);
    try {
      if ((await handle.stat()).size > maxBytes) throw new Error("page assets exceed export limits");
      const content = await handle.readFile();
      await this.checkAssetFile(handle, boundary);
      if (content.length > maxBytes) throw new Error("page assets exceed export limits");
      return content;
    } finally { await handle.close(); }
  }

  async writeAsset(
    pluginId: string,
    pageId: string,
    relPath: string,
    content: Buffer,
  ): Promise<string> {
    if (await this.generationResolver?.(pluginId)) throw new Error("packaged plugin resources are immutable");
    const boundary = await this.assetBoundary(pluginId, pageId, relPath, true);
    const handle = await this.openAsset(boundary, true);
    try {
      await this.checkAssetFile(handle, boundary);
      await handle.truncate(0);
      await handle.writeFile(content);
    } finally { await handle.close(); }
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  async readAsset(
    pluginId: string,
    pageId: string,
    relPath: string,
  ): Promise<{ content: Buffer; mime: string }> {
    const content = await this.readCheckedAsset(pluginId, pageId, relPath);
    const ext = path.extname(relPath).toLowerCase();
    return { content, mime: MIME[ext] ?? "application/octet-stream" };
  }

  /** 把 Manifest entry（相对 Bundle 根）换算为 Page 目录内相对路径 */
  entryToPageRelative(pluginId: string, pageId: string, entry: string): string {
    const prefix = `pages/${pageId}/`;
    if (!entry.startsWith(prefix)) {
      throw new Error(`page entry must start with "${prefix}"`);
    }
    return entry.slice(prefix.length);
  }

  /** Export the page's real files; never follow links outside the bundle. */
  async exportPageAssets(
    pluginId: string, pageId: string,
    limits: { entries: number; bytes: number; entryBytes: number },
  ): Promise<Record<string, Uint8Array>> {
    const boundary = await this.assetBoundary(pluginId, pageId, "index.html", false);
    const base = path.dirname(boundary.target);
    const files: Record<string, Uint8Array> = {};
    let size = 0;
    let entries = 0;
    const visit = async (relative: string): Promise<void> => {
      await this.checkDirectories(boundary.directories);
      await this.checkedDirectories(boundary.root, path.join(base, relative), false);
      for (const entry of await fs.readdir(path.join(base, relative), { withFileTypes: true })) {
        if (++entries > limits.entries) throw new Error("page assets exceed export limits");
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) throw new Error("symlink in page assets");
        if (entry.isDirectory()) { await visit(name); continue; }
        if (!entry.isFile() || !isSafeRelativePath(name)) throw new Error("invalid page asset");
        const content = await this.readCheckedAsset(pluginId, pageId, name, Math.min(limits.entryBytes, limits.bytes - size));
        size += content.length;
        files[name] = new Uint8Array(content);
      }
    };
    await visit("");
    return files;
  }

  async deletePage(pluginId: string, pageId: string): Promise<void> {
    const target = await this.pageRoot(pluginId, pageId);
    await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
  }
}
