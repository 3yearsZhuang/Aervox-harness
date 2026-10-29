/**
 * Aervox｜思隅 — 插件打包导出脚本
 *
 * 扫描 plugins/ 目录下的所有内置插件，读取 plugin.manifest.json，
 * 并使用 fflate 压缩生成 dist/plugins/<id>-v<version>.aervox-plugin 分发包。
 *
 * **构建可重现性**：分发包是校验和载体（预检会展示 SHA-256），字节必须
 * 只由源码内容决定。fflate 的 ZIP 条目时间戳默认取**当前时间**、且 `fs.readdir`
 * 的返回顺序在平台间不稳定，两者都会让源码未变时产出不同字节与不同校验和。
 * 因此这里固定条目时间并显式排序。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { assertCoreSubmodule } from './core-submodule.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PLUGINS_DIR = path.join(ROOT_DIR, "plugins");
// 输出目录可用环境变量覆盖，供回归测试在临时目录中验证可重现性（不污染工作区产物）。
const DIST_DIR = process.env.AERVOX_PLUGIN_DIST_DIR
  ? path.resolve(process.env.AERVOX_PLUGIN_DIST_DIR)
  : path.join(ROOT_DIR, "dist", "plugins");

/**
 * 写入固化的 DOS 时间（ZIP 纪元 1980-01-01 本地零点）。
 * 用本地构造保证任意时区下 `getFullYear/Month/Date` 取值一致，编码结果相同。
 */
const REPRODUCIBLE_MTIME = new Date(1980, 0, 1, 0, 0, 0);

/** 按名称排序后再遍历，消除平台差异带来的条目顺序抖动。 */
function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * 分发包内容采用**允许清单**（fail-closed）。
 *
 * 第一方插件的实现源码与声明同置于 `plugins/<id>/`，但分发包是
 * 校验和载体，必须只含声明与资源。此前的目录递归打包会把 `src/`、`package.json`、
 * `node_modules/` 一并压入。这里按角色分类：
 *   - `dist`：声明与资源 → 进包（AVX-PLUG-001 §8.1 布局）；
 *   - `local`：仅本地开发用的载体 → 明确排除；
 *   - 其余：**未知角色直接失败**，避免"静默漏发"或"静默泄露"。
 */
export const DIST_FILENAMES = new Set([
  "plugin.manifest.json",
  "manifest.json",
  "config.schema.json",
  "SKILL.md",
  "skill.md",
  "icon.svg",
  "icon.png",
  "LICENSE",
  "NOTICE",
  "CHANGELOG.md",
]);

export const DIST_DIR_PREFIXES = ["skills/", "pages/"];

export const LOCAL_ONLY_FILENAMES = new Set([
  "package.json",
  "tsconfig.json",
  "tsconfig.ui.json",
  "tsconfig.type-tests.json",
  "vitest.config.ts",
  "vitest.config.js",
  "pnpm-lock.yaml",
  "README.md",
  ".gitignore",
  ".DS_Store",
]);

export const LOCAL_ONLY_DIR_PREFIXES = ["src/", "dist/", "node_modules/", "test/", "tests/", "__tests__/", ".turbo/"];

/** 判断插件根内相对路径在分发包中的角色：dist | local | unknown */
export function classifyDistEntry(rel, isDirectory = false) {
  const asDir = isDirectory ? `${rel}/` : rel;
  if (!isDirectory && DIST_FILENAMES.has(rel)) return "dist";
  if (!isDirectory && LOCAL_ONLY_FILENAMES.has(rel)) return "local";
  if (DIST_DIR_PREFIXES.some((prefix) => asDir.startsWith(prefix))) return "dist";
  if (LOCAL_ONLY_DIR_PREFIXES.some((prefix) => asDir.startsWith(prefix))) return "local";
  return "unknown";
}

/** 按允许清单收集待打包文件；返回 { files, unexpected, skipped } */
async function collectDistFiles(dir, base = "", budget = { bytes: 0, entries: 0 }) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = {};
  const unexpected = [];
  const skipped = [];
  for (const entry of [...entries].sort(byName)) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new Error(`Unsupported plugin resource: ${path.join(base, entry.name)}`);
    }
    const full = path.join(dir, entry.name);
    const rel = path.join(base, entry.name).replace(/\\/g, "/");
    const role = classifyDistEntry(rel, entry.isDirectory());
    if (role === "unknown") {
      unexpected.push(rel);
      continue;
    }
    if (role === "local") {
      skipped.push(rel);
      continue;
    }
    if (entry.isDirectory()) {
      const nested = await collectDistFiles(full, rel, budget);
      Object.assign(files, nested.files);
      unexpected.push(...nested.unexpected);
    } else {
      const stat = await fs.lstat(full);
      if (stat.nlink > 1) throw new Error(`Hard-linked plugin resource: ${rel}`);
      budget.bytes += stat.size;
      budget.entries++;
      if (stat.size > 5 * 1024 * 1024 || budget.bytes > 50 * 1024 * 1024 || budget.entries > 2048) throw new Error("Plugin resources exceed archive limits");
      const data = await fs.readFile(full);
      files[rel] = [new Uint8Array(data), { mtime: REPRODUCIBLE_MTIME }];
    }
  }
  return { files, unexpected, skipped };
}

/** Bounded discovery supports legacy roots and the seven ecosystem categories. */
export async function discoverPluginDirectories(root) {
  const directories = [];
  const categories = new Set(["tool", "bot", "ui", "proactive", "sync", "workflow", "theme"]);
  const children = async directory => {
    try { return (await fs.readdir(directory, { withFileTypes: true })).sort(byName); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  };
  for (const entry of await children(root)) {
    if (entry.isSymbolicLink()) throw new Error(`Linked plugin source: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    try { await fs.access(path.join(directory, "plugin.manifest.json")); directories.push(directory); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const category of await children(path.join(root, "plugins"))) {
    if (category.isSymbolicLink()) throw new Error(`Linked category: ${category.name}`);
    if (!category.isDirectory()) continue;
    if (!categories.has(category.name)) throw new Error(`Unknown plugin category: ${category.name}`);
    for (const entry of await children(path.join(root, "plugins", category.name))) {
      if (entry.isSymbolicLink()) throw new Error(`Linked plugin source: ${entry.name}`);
      if (!entry.isDirectory()) continue;
      const directory = path.join(root, "plugins", category.name, entry.name);
      await fs.access(path.join(directory, "plugin.manifest.json"));
      directories.push(directory);
    }
  }
  return directories.sort();
}

/** Shared packaging authority for host exports, release assets and reproducibility gates. */
export async function exportPluginDirectory(pluginDir, { distDir = DIST_DIR, write = true } = {}) {
  const { validatePluginBundleFiles } = await import("../packages/contracts/dist/plugin-validation.js");
  const manifest = JSON.parse(await fs.readFile(path.join(pluginDir, "plugin.manifest.json"), "utf8"));
  const { files, unexpected, skipped } = await collectDistFiles(pluginDir);
  if (unexpected.length) throw new Error(`${manifest.metadata.id}: unclassified entries: ${unexpected.join(", ")}`);
  const resources = Object.values(files);
  if (resources.length > 2048 || resources.some(([bytes]) => bytes.byteLength > 5 * 1024 * 1024)
    || resources.reduce((sum, [bytes]) => sum + bytes.byteLength, 0) > 50 * 1024 * 1024) throw new Error("Plugin resources exceed archive limits");
  const validation = validatePluginBundleFiles(Object.fromEntries(Object.entries(files).map(([name, [bytes]]) => [name, bytes])));
  if (validation.issues.length) throw new Error(`${manifest.metadata.id}: ${validation.issues.map(issue => `${issue.path}: ${issue.message}`).join("; ")}`);
  const bytes = zipSync(files, { level: 9 });
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("Plugin archive exceeds compressed size limit");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const { id, version } = manifest.metadata;
  if (!/^[a-z0-9._-]+$/.test(id) || !/^[a-zA-Z0-9.+_-]+$/.test(version)) throw new Error("Unsafe distribution filename");
  const filename = `${id}-v${version}.aervox-plugin`;
  if (write) {
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(path.join(distDir, filename), bytes);
  }
  return { id, version, filename, bytes, checksum, size: bytes.length, manifest, filesCount: Object.keys(files).length, skipped };
}

async function main() {
  assertCoreSubmodule(ROOT_DIR);
  const entries = await discoverPluginDirectories(PLUGINS_DIR);
  const filterIndex = process.argv.indexOf("--plugin-id");
  const filter = filterIndex < 0 ? undefined : process.argv[filterIndex + 1];
  if (filterIndex >= 0 && !filter) throw new Error("--plugin-id requires an ID");
  const exported = [];
  const ids = new Set();
  for (const directory of entries) {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, "plugin.manifest.json"), "utf8"));
    if (ids.has(manifest.metadata.id)) throw new Error(`Duplicate plugin identity: ${manifest.metadata.id}`);
    ids.add(manifest.metadata.id);
    if (filter && manifest.metadata.id !== filter) continue;
    const result = await exportPluginDirectory(directory);
    exported.push({ id: result.id, version: result.version, filename: result.filename, size: result.size,
      checksum: result.checksum, filesCount: result.filesCount });
  }
  if (filter && !exported.length) throw new Error(`Plugin not found: ${filter}`);
  console.table(exported);
  console.log(`[export-plugins] Exported ${exported.length} packages to ${DIST_DIR}`);
}

// 仅在作为脚本直接执行时打包；被测试 import 时不得产生副作用（避免污染工作区产物）。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[export-plugins] 打包失败:", err);
    process.exit(1);
  });
}
