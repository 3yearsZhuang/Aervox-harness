#!/usr/bin/env node
/**
 * Aervox｜思隅 — 增量文档门禁检查器
 *
 * 仅对 Git 变更（暂存区 + 工作区 + 分支差异）中的 Markdown 文档执行
 * Markdownlint 与 Vale 术语检查。当无任何 Markdown 变更时，0 秒快速放行。
 */
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";

function getBaseRef() {
  const candidates = ["origin/main", "main", "HEAD~1"];
  for (const ref of candidates) {
    try {
      execSync(`git rev-parse --verify ${ref}`, { stdio: "ignore" });
      return ref;
    } catch {
      // 尝试下一个候选
    }
  }
  return null;
}

function getAffectedMarkdownFiles() {
  const baseRef = getBaseRef();
  const changedFiles = new Set();

  // 1. 工作区与暂存区未提交变更
  try {
    const statusOut = execSync("git status --porcelain -uall", { encoding: "utf-8" });
    for (const line of statusOut.split("\n")) {
      if (!line || line.length < 4) continue;
      // porcelain 固定格式: 2 字符 XY + 1 空格 + 文件路径
      const filePath = line.slice(3).trim();
      if (filePath.endsWith(".md")) {
        changedFiles.add(filePath);
      }
    }
  } catch {
    // 忽略异常
  }

  // 2. 分支相对基准分支的已提交变更
  if (baseRef) {
    try {
      const diffOut = execSync(`git diff --name-only ${baseRef}...HEAD`, { encoding: "utf-8" });
      for (const line of diffOut.split("\n")) {
        const filePath = line.trim();
        if (filePath.endsWith(".md")) {
          changedFiles.add(filePath);
        }
      }
    } catch {
      // 忽略异常
    }
  }

  // 过滤掉已删除的文件
  return Array.from(changedFiles).filter((f) => fs.existsSync(f));
}

const mdFiles = getAffectedMarkdownFiles();

if (mdFiles.length === 0) {
  console.log("✓ [docs-affected] 无 Markdown 文档变更，文档门禁 0 秒快速放行。");
  process.exit(0);
}

console.log(`[docs-affected] 检测到 ${mdFiles.length} 个变更文档，执行增量门禁校验:`);
for (const f of mdFiles) {
  console.log(`  - ${f}`);
}

// 1. 增量 Markdownlint
console.log("\n[docs-affected] 执行增量 Markdownlint...");
const lintRes = spawnSync(
  "npx",
  ["markdownlint-cli2", "--config", ".markdownlint-cli2.jsonc", ...mdFiles],
  { stdio: "inherit" },
);
if (lintRes.status !== 0) {
  process.exit(lintRes.status ?? 1);
}

// 2. 增量 Vale 散文与术语一致性
console.log("\n[docs-affected] 执行增量 Vale 术语检查...");
const valeRes = spawnSync(
  "vale",
  ["--minAlertLevel=error", ...mdFiles],
  { stdio: "inherit" },
);
if (valeRes.status !== 0) {
  process.exit(valeRes.status ?? 1);
}

// 3. 全局文档治理与死链一致性校验（约 1s，确保整体引用图谱未被破坏）
console.log("\n[docs-affected] 执行文档治理完整性校验...");
const govRes = spawnSync(
  "node",
  ["scripts/docs-governance.mjs", "--strict"],
  { stdio: "inherit" },
);
process.exit(govRes.status ?? 0);
