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

async function readDirRecursive(dir, base = "") {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = {};
  for (const entry of [...entries].sort(byName)) {
    const full = path.join(dir, entry.name);
    const rel = path.join(base, entry.name).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      Object.assign(files, await readDirRecursive(full, rel));
    } else {
      const data = await fs.readFile(full);
      files[rel] = [new Uint8Array(data), { mtime: REPRODUCIBLE_MTIME }];
    }
  }
  return files;
}

async function main() {
  await fs.mkdir(DIST_DIR, { recursive: true });
  const entries = [...(await fs.readdir(PLUGINS_DIR, { withFileTypes: true }))].sort(byName);
  const exported = [];

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

    const files = await readDirRecursive(pluginDir);
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

  console.table(exported);
  console.log(`[export-plugins] 成功打包 ${exported.length} 个插件至 ${DIST_DIR}`);
}

main().catch((err) => {
  console.error("[export-plugins] 打包失败:", err);
  process.exit(1);
});
