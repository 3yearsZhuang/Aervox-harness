/**
 * Aervox｜思隅 @aervox/api — 出厂源打包允许清单一致性（CR-060）
 *
 * 同一份「`.aervox-plugin` 分发包允许清单」存在两个消费者：
 * - 构建期导出脚本 `scripts/export-plugins.mjs`（生成 `dist-plugins/*.aervox-plugin`）；
 * - 运行时出厂集市安装 `installFromMarket`（API 从 `plugins/<id>/` 就地打包）。
 *
 * 两者若漂移，会出现「导出的包能装、集市就地装的包装不上」这类只有用户才能发现的缺陷；
 * 故在此机器断言两份清单与分类矩阵逐项一致，并以端到端用例锁定「实现目录不进包」。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strFromU8, unzipSync, zipSync } from "fflate";
import {
  DIST_DIR_PREFIXES,
  DIST_FILENAMES,
  LOCAL_ONLY_DIR_PREFIXES,
  LOCAL_ONLY_FILENAMES,
  classifyDistEntry,
} from "../../../scripts/export-plugins.mjs";
import {
  PLUGIN_BUNDLE_DIR_PREFIXES,
  PLUGIN_BUNDLE_FILENAMES,
  PLUGIN_BUNDLE_LOCAL_DIR_PREFIXES,
  PLUGIN_BUNDLE_LOCAL_FILENAMES,
  classifyPluginBundleEntry,
  collectMarketBundleFiles,
} from "../src/modules/ecosystem/plugins/package-bundle.js";

const CLASSIFICATION_SAMPLES: Array<[string, boolean]> = [
  ["plugin.manifest.json", false],
  ["manifest.json", false],
  ["config.schema.json", false],
  ["SKILL.md", false],
  ["skills", true],
  ["skills/handout.md", false],
  ["pages", true],
  ["pages/index.html", false],
  ["package.json", false],
  ["tsconfig.json", false],
  ["vitest.config.ts", false],
  ["README.md", false],
  ["src", true],
  ["src/server/index.ts", false],
  ["dist", true],
  ["dist/server/index.js", false],
  ["node_modules", true],
  ["node_modules/@aervox-core", false],
  ["test", true],
  [".turbo", true],
  ["unknown-dir", true],
  ["random.bin", false],
];

describe("CR-060 分发包允许清单单一事实源", () => {
  it("导出脚本与出厂集市安装的允许清单逐项一致", () => {
    expect([...PLUGIN_BUNDLE_FILENAMES]).toEqual([...DIST_FILENAMES]);
    expect([...PLUGIN_BUNDLE_DIR_PREFIXES]).toEqual([...DIST_DIR_PREFIXES]);
    expect([...PLUGIN_BUNDLE_LOCAL_FILENAMES]).toEqual([...LOCAL_ONLY_FILENAMES]);
    expect([...PLUGIN_BUNDLE_LOCAL_DIR_PREFIXES]).toEqual([...LOCAL_ONLY_DIR_PREFIXES]);
  });

  it("两侧分类矩阵逐例一致（含未知角色 fail-closed）", () => {
    for (const [rel, isDir] of CLASSIFICATION_SAMPLES) {
      expect(
        classifyPluginBundleEntry(rel, isDir),
        `出厂集市分类不一致：${rel}${isDir ? "/" : ""}`,
      ).toBe(classifyDistEntry(rel, isDir));
    }
    // 未登记角色的判定必须是 unknown（由调用方 fail-closed），不得静默归入 dist/local
    expect(classifyPluginBundleEntry("random.bin", false)).toBe("unknown");
    expect(classifyPluginBundleEntry("unknown-dir", true)).toBe("unknown");
  });

  it("本地开发载体（源码 / 依赖链接 / 构建产物）被明确排除", () => {
    for (const excluded of ["src/", "dist/", "node_modules/", "test/", ".turbo/"]) {
      expect(PLUGIN_BUNDLE_LOCAL_DIR_PREFIXES).toContain(excluded);
      expect(PLUGIN_BUNDLE_DIR_PREFIXES).not.toContain(excluded);
    }
    for (const excluded of ["package.json", "tsconfig.json", "vitest.config.ts"]) {
      expect(PLUGIN_BUNDLE_LOCAL_FILENAMES).toContain(excluded);
      expect(PLUGIN_BUNDLE_FILENAMES).not.toContain(excluded);
    }
  });

  it("出厂源就地打包只收声明与资源，符号链接目录不再触发 EISDIR", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "avx-market-bundle-"));
    try {
      const pluginDir = path.join(root, "fixture");
      await fs.mkdir(path.join(pluginDir, "src"), { recursive: true });
      await fs.mkdir(path.join(pluginDir, "dist"), { recursive: true });
      await fs.mkdir(path.join(pluginDir, "node_modules"), { recursive: true });
      await fs.mkdir(path.join(pluginDir, "skills"), { recursive: true });
      await fs.writeFile(path.join(pluginDir, "plugin.manifest.json"), "{}");
      await fs.writeFile(path.join(pluginDir, "SKILL.md"), "# skill");
      await fs.writeFile(path.join(pluginDir, "package.json"), "{}");
      await fs.writeFile(path.join(pluginDir, "src/index.ts"), "export {};");
      await fs.writeFile(path.join(pluginDir, "dist/index.js"), "export {};");
      await fs.writeFile(path.join(pluginDir, "skills/one.md"), "# one");
      // 工作区依赖在包内是**指向目录的符号链接**：旧实现对其 readFile 会抛 EISDIR
      await fs.symlink(path.join(root, "outside"), path.join(pluginDir, "node_modules/@aervox-core"));

      const files = await collectMarketBundleFiles(pluginDir);
      expect(Object.keys(files).sort()).toEqual([
        "SKILL.md",
        "plugin.manifest.json",
        "skills/one.md",
      ]);
      // 就地打包结果必须可被同一条安装管线解压消费
      expect(Object.keys(unzipSync(zipSync(files))).sort()).toEqual(Object.keys(files).sort());
      expect(strFromU8(files["SKILL.md"] as Uint8Array)).toBe("# skill");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("出厂源出现未登记角色的条目时 fail-closed 拒绝打包", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "avx-market-unknown-"));
    try {
      const pluginDir = path.join(root, "fixture");
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(path.join(pluginDir, "plugin.manifest.json"), "{}");
      await fs.writeFile(path.join(pluginDir, "mystery.asset"), "?");
      await expect(collectMarketBundleFiles(pluginDir)).rejects.toThrow(/未登记角色/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("现有出厂插件目录全部落在允许清单内（不因收紧清单漏发资源）", async () => {
    const pluginsRoot = path.resolve(__dirname, "../../../plugins");
    const entries = await fs.readdir(pluginsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(pluginsRoot, entry.name);
      await expect(collectMarketBundleFiles(dir)).resolves.toBeTypeOf("object");
    }
  });
});
