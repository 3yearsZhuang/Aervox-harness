/**
 * Aervox｜思隅 @aervox/api — 插件 Page 静态资源存储（CAP-020 扩展 · CR-006）
 *
 * 只允许已安装插件 Bundle 本地资源：写入/读取严格限制在
 * <pluginsRoot>/<pluginId>/pages/<pageId>/ 内，拒绝路径穿越、符号链接逃逸与未知类型。
 * 页面不能加载远程 URL；所有业务操作必须经过 Host Bridge。
 */
import fs from "node:fs/promises";
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
  if (!relPath || relPath.length > 512) return false;
  if (relPath.startsWith("/") || relPath.includes("\\")) return false;
  if (/^[A-Za-z]:/.test(relPath)) return false;
  const parts = relPath.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return false;
  return true;
}

export class PluginBundleStore {
  constructor(private readonly root: string) {}

  private pageRoot(pluginId: string, pageId: string): string {
    return path.join(this.root, pluginId, "pages", pageId);
  }

  private resolveInside(pluginId: string, pageId: string, relPath: string): string {
    const base = path.resolve(this.pageRoot(pluginId, pageId));
    const target = path.resolve(base, relPath);
    if (target !== base && !target.startsWith(base + path.sep)) {
      throw new Error("invalid page asset path");
    }
    return target;
  }

  async writeAsset(
    pluginId: string,
    pageId: string,
    relPath: string,
    content: Buffer,
  ): Promise<string> {
    if (!isSafeRelativePath(relPath)) {
      throw new Error(`invalid page asset path: ${relPath}`);
    }
    const target = this.resolveInside(pluginId, pageId, relPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  async readAsset(
    pluginId: string,
    pageId: string,
    relPath: string,
  ): Promise<{ content: Buffer; mime: string }> {
    if (!isSafeRelativePath(relPath)) {
      throw new Error(`invalid page asset path: ${relPath}`);
    }
    const target = this.resolveInside(pluginId, pageId, relPath);
    const content = await fs.readFile(target);
    const ext = path.extname(target).toLowerCase();
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

  async deletePage(pluginId: string, pageId: string): Promise<void> {
    const target = this.pageRoot(pluginId, pageId);
    await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
  }
}
