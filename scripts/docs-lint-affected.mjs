#!/usr/bin/env node
/**
 * Aervox｜思隅 — 增量文档门禁检查器。
 *
 * 普通编辑只检查变更 Markdown；排版/术语配置变化时检查全部项目文档。
 * 文档、文档资产或治理输入变化时仍检查全仓本地链接，避免删除目标后跳过入链校验。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePorcelainStatus } from "./docs-governance.mjs";
import { collectDocumentationFiles, isGovernedMarkdown, isProjectDocumentation, isDocumentationToolInput } from "./docs-config.mjs";
import { runDocumentationChecks } from "./docs-check.mjs";

export { isGovernedMarkdown };

function getBaseRef() {
  for (const ref of ["origin/main", "main", "HEAD~1"]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", ref], { stdio: "ignore" });
      return ref;
    } catch {
      // 尝试下一个候选；无基准时仍检查工作区/暂存区。
    }
  }
  return null;
}

function getChangedFiles() {
  const baseRef = getBaseRef();
  const status = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    encoding: "utf8",
  });
  const changedFiles = new Set(parsePorcelainStatus(status));
  if (baseRef) {
    // 已提交的重命名也保留旧路径，避免文档/治理脚本改名后只剩非治理后缀。
    const diff = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", `${baseRef}...HEAD`], {
      encoding: "utf8",
    });
    for (const file of diff.split("\0")) {
      if (file) changedFiles.add(file);
    }
  }
  return [...changedFiles];
}

export function isGovernanceInput(file) {
  return isProjectDocumentation(file) || file.endsWith(".md") ||
    (file.startsWith("scripts/docs-") && file.endsWith(".mjs")) ||
    file === "mise.toml" || file === ".github/workflows/docs.yml";
}

export function selectDocumentationChecks(changedFiles, exists = fs.existsSync) {
  const uniquePaths = [...new Set(changedFiles)];
  return {
    markdownFiles: uniquePaths.filter((file) => isGovernedMarkdown(file) && exists(file)),
    runGovernance: uniquePaths.some(isGovernanceInput),
    lintAll: uniquePaths.some((file) =>
      isDocumentationToolInput(file) || file === "scripts/docs-config.mjs" ||
      file === "scripts/docs-check.mjs" || file === "mise.toml",
    ),
  };
}

function main() {
  let checks;
  try {
    checks = selectDocumentationChecks(getChangedFiles());
  } catch (error) {
    console.error(`[docs-affected] 无法确定 Git 变动：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  if (!checks.runGovernance) {
    console.log("✓ [docs-affected] 无文档或治理输入变更，快速放行。");
    return;
  }

  if (checks.lintAll) {
    checks.markdownFiles = collectDocumentationFiles(process.cwd());
  }
  if (checks.markdownFiles.length > 0) {
    console.log(`[docs-affected] 检查 ${checks.markdownFiles.length} 个${checks.lintAll ? "全部" : "变更"}文档：`);
    for (const file of checks.markdownFiles) console.log(`  - ${file}`);
  } else {
    console.log("[docs-affected] 无现存 Markdown 待 lint；继续检查删除与治理输入变更。");
  }

  process.exitCode = runDocumentationChecks({ root: process.cwd(), files: checks.markdownFiles });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
