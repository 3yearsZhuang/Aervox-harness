/**
 * Aervox｜思隅 — 插件打包导出脚本
 *
 * 扫描 plugins/ 目录下的所有内置插件，读取 plugin.manifest.json，
 * 并使用 fflate 压缩生成 dist-plugins/<id>-<version>.aervox-plugin 分发包。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PLUGINS_DIR = path.join(ROOT_DIR, "plugins");
const DIST_DIR = path.join(ROOT_DIR, "dist-plugins");

async function readDirRecursive(dir, base = "") {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = {};
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.join(base, entry.name).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      Object.assign(files, await readDirRecursive(full, rel));
    } else {
      const data = await fs.readFile(full);
      files[rel] = new Uint8Array(data);
    }
  }
  return files;
}

async function main() {
  await fs.mkdir(DIST_DIR, { recursive: true });
  const entries = await fs.readdir(PLUGINS_DIR, { withFileTypes: true });
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
