/**
 * Aervox｜思隅 — 插件打包导出脚本
 *
 * 扫描 plugins/ 目录下的所有内置插件，读取 plugin.manifest.json，
 * 并使用 fflate 压缩生成 dist-plugins/<id>-<version>.aervox-plugin 分发包。
 *
 * **可重现性（ITER-001）**：分发包是校验和载体（预检会展示 SHA-256），字节必须
 * 只由源码内容决定。fflate 的 ZIP 条目时间戳默认取**当前时间**、且 `fs.readdir`
 * 的返回顺序在平台间不稳定，两者都会让源码未变时产出不同字节与不同校验和。
 * 因此这里固定条目时间并显式排序。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PLUGINS_DIR = path.join(ROOT_DIR, "plugins");
// 输出目录可用环境变量覆盖，供回归测试在临时目录中验证可重现性（不污染工作区产物）。
const DIST_DIR = process.env.AERVOX_PLUGIN_DIST_DIR
  ? path.resolve(process.env.AERVOX_PLUGIN_DIST_DIR)
  : path.join(ROOT_DIR, "dist-plugins");

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
 * 背景（CR-060）：第一方插件的实现源码与声明同置于 `plugins/<id>/`，但分发包是
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
]);

export const DIST_DIR_PREFIXES = ["skills/", "pages/"];

export const LOCAL_ONLY_FILENAMES = new Set([
  "package.json",
  "tsconfig.json",
  "tsconfig.ui.json",
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
async function collectDistFiles(dir, base = "") {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = {};
  const unexpected = [];
  const skipped = [];
  for (const entry of [...entries].sort(byName)) {
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
      const nested = await collectDistFiles(full, rel);
      Object.assign(files, nested.files);
      unexpected.push(...nested.unexpected);
    } else {
      const data = await fs.readFile(full);
      files[rel] = [new Uint8Array(data), { mtime: REPRODUCIBLE_MTIME }];
    }
  }
  return { files, unexpected, skipped };
}

async function main() {
  await fs.mkdir(DIST_DIR, { recursive: true });
  const entries = [...(await fs.readdir(PLUGINS_DIR, { withFileTypes: true }))].sort(byName);
  const exported = [];
  const problems = [];

  console.log(`[export-plugins] 开始打包 plugins/ 目录下的插件包...`);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(PLUGINS_DIR, entry.name);
    const manifestPath = path.join(pluginDir, "plugin.manifest.json");

    try {
      await fs.access(manifestPath);
    } catch {
      continue;
    }

    const manifestRaw = await fs.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestRaw);
    const { id, version, displayName } = manifest.metadata;

    const { files, unexpected, skipped } = await collectDistFiles(pluginDir);

    // fail-closed：出现无法归类为「声明/资源」或「本地开发载体」的条目时拒绝打包，
    // 强制作者显式决定该文件的去向，避免实现源码或未知文件静默进入校验和载体。
    if (unexpected.length > 0) {
      problems.push({ id, unexpected });
      continue;
    }
    if (skipped.length > 0) {
      console.log(`[export-plugins] ${id}: 已排除本地开发载体 ${skipped.join(", ")}`);
    }

    const zipped = zipSync(files, { level: 9 });
    const checksum = createHash("sha256").update(zipped).digest("hex");
    const filename = `${id}-${version}.aervox-plugin`;
    const outputPath = path.join(DIST_DIR, filename);

    await fs.writeFile(outputPath, zipped);

    const stats = await fs.stat(outputPath);
    exported.push({
      id,
      displayName,
      version,
      filename,
      size: `${(stats.size / 1024).toFixed(2)} KB`,
      checksum: checksum.slice(0, 16) + "...",
      filesCount: Object.keys(files).length,
    });
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(
        `[export-plugins] ${problem.id}: 存在未归类条目，拒绝打包 —— ${problem.unexpected.join(", ")}\n` +
          `  请将其归入声明与资源（${[...DIST_FILENAMES].join(", ")}、${DIST_DIR_PREFIXES.join("")}），` +
          `或在 scripts/export-plugins.mjs 的 LOCAL_ONLY_* 中登记为本地开发载体。`,
      );
    }
    throw new Error(`${problems.length} 个插件包因未归类条目被拒绝`);
  }

  console.table(exported);
  console.log(`[export-plugins] 成功打包 ${exported.length} 个插件至 ${DIST_DIR}`);
}

// 仅在作为脚本直接执行时打包；被测试 import 时不得产生副作用（避免污染工作区产物）。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[export-plugins] 打包失败:", err);
    process.exit(1);
  });
}
