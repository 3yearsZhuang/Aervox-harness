#!/usr/bin/env node
/**
 * Aervox｜思隅 — 插件分发包产物回归测试。
 *
 * 分发包是校验和载体（安装预检会向用户展示 SHA-256），因此产物字节必须只由
 * `plugins/` 源码内容决定。踩过的坑：fflate 的 ZIP 条目时间戳默认取**当前时间**，
 * `fs.readdir` 的顺序也不保证跨平台稳定——两者都会让源码未变时产出不同字节，
 * 使已公布的校验和无法复核。本测试锁住这两点，并防止静默漏包。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { unzipSync } from "fflate";
import { ROOT_DIR } from "./ci-scope.mjs";
import { classifyDistEntry } from "./export-plugins.mjs";

const MANIFEST = "plugin.manifest.json";

/** 在指定输出目录运行一次声明的打包任务（等价 `mise tasks run package-plugins`）。 */
function runExport(distDir, env = {}) {
  execFileSync(process.execPath, ["scripts/export-plugins.mjs"], {
    cwd: ROOT_DIR,
    env: { ...process.env, AERVOX_PLUGIN_DIST_DIR: distDir, ...env },
    stdio: "ignore",
  });
}

/** 目录内全部分发包的“文件名 → SHA-256”，按文件名排序后拼成可比对字符串。 */
function fingerprint(distDir) {
  return fs
    .readdirSync(distDir)
    .filter((file) => file.endsWith(".aervox-plugin"))
    .sort()
    .map((file) => {
      const digest = createHash("sha256").update(fs.readFileSync(path.join(distDir, file))).digest("hex");
      return `${file} ${digest}`;
    })
    .join("\n");
}

function withTempDirs(prefixes, fn) {
  const dirs = prefixes.map((prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  try {
    return fn(dirs);
  } finally {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("分发包字节只由源码决定：重复运行与跨时区一致", () => {
  withTempDirs(["aervox-plugins-a-", "aervox-plugins-b-"], ([dirA, dirB]) => {
    runExport(dirA);
    runExport(dirB, { TZ: "UTC" });

    const fingerprintA = fingerprint(dirA);
    assert.notEqual(fingerprintA, "", "打包任务应至少产出一个 .aervox-plugin");
    assert.equal(fingerprintA, fingerprint(dirB), "同一源码在不同运行/时区下必须产出相同字节");
  });
});

test("打包覆盖 plugins/ 下全部含清单的插件目录，不静默漏包", () => {
  const expected = fs
    .readdirSync(path.join(ROOT_DIR, "plugins"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(ROOT_DIR, "plugins", entry.name, MANIFEST)))
    .map((entry) => entry.name)
    .sort();

  withTempDirs(["aervox-plugins-c-"], ([dir]) => {
    runExport(dir);
    const produced = fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".aervox-plugin"))
      .map((file) => file.replace(/-\d+\.\d+\.\d+\.aervox-plugin$/, ""))
      .sort();

    assert.deepEqual(produced, expected, `插件目录与分发包不一致：期望 ${expected.join(", ")}`);
  });
});

test("允许清单分类：声明与资源进包，本地开发载体排除，未知条目 fail-closed", () => {
  // 声明与资源（AVX-PLUG-001 §8.1 布局）
  for (const rel of ["plugin.manifest.json", "manifest.json", "config.schema.json", "SKILL.md", "skill.md"]) {
    assert.equal(classifyDistEntry(rel), "dist", rel);
  }
  assert.equal(classifyDistEntry("skills", true), "dist");
  assert.equal(classifyDistEntry("pages", true), "dist");
  assert.equal(classifyDistEntry("skills/review/SKILL.md"), "dist");
  assert.equal(classifyDistEntry("pages/dashboard/index.html"), "dist");

  // 本地开发载体（CR-060：第一方实现与声明同置一处，但不得进分发包）
  for (const rel of ["package.json", "tsconfig.json", "vitest.config.ts", "README.md"]) {
    assert.equal(classifyDistEntry(rel), "local", rel);
  }
  for (const rel of ["src", "dist", "node_modules", "test"]) {
    assert.equal(classifyDistEntry(rel, true), "local", rel);
  }
  assert.equal(classifyDistEntry("src/server/index.ts"), "local");
  assert.equal(classifyDistEntry("test/plugin.test.ts"), "local");

  // 未知条目必须显式决策，不得静默进包或静默丢弃
  assert.equal(classifyDistEntry("notes.txt"), "unknown");
  assert.equal(classifyDistEntry("assets", true), "unknown");
  assert.equal(classifyDistEntry("pages-extra/index.html"), "unknown");
});

test("分发包条目全部属于声明与资源允许清单（实现源码不随包发布）", () => {
  withTempDirs(["aervox-plugins-d-"], ([dir]) => {
    runExport(dir);
    const zips = fs.readdirSync(dir).filter((file) => file.endsWith(".aervox-plugin"));
    assert.ok(zips.length > 0, "应至少产出一个分发包");

    for (const zip of zips) {
      const entries = Object.keys(unzipSync(new Uint8Array(fs.readFileSync(path.join(dir, zip)))));
      assert.ok(entries.length > 0, `${zip} 不应为空包`);
      for (const entry of entries) {
        assert.equal(classifyDistEntry(entry), "dist", `${zip} 含非声明条目：${entry}`);
      }
      assert.ok(entries.includes(MANIFEST), `${zip} 必须包含 ${MANIFEST}`);
    }
  });
});
