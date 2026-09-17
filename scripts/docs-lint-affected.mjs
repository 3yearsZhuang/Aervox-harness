#!/usr/bin/env node
/**
 * Aervox｜思隅 — 增量文档门禁检查器。
 *
 * 仅对存在的变更 Markdown 执行排版/术语检查；文档删除或治理关键输入变化时，
 * 仍执行完整治理校验，避免根 plan.md 删除后因没有待 lint 文件而放行。
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePorcelainStatus } from "./docs-governance.mjs";

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
  return file.endsWith(".md") ||
    (file.startsWith("scripts/docs-") && file.endsWith(".mjs")) ||
    file === "docs/_meta/document-policy.json" ||
    file === "docs/_meta/document-catalog.json" ||
    file === "mise.toml" ||
    file === ".github/workflows/docs.yml" ||
    file === ".markdownlint-cli2.jsonc" ||
    file === ".lycheeignore" ||
    file === ".vale.ini" ||
    file.startsWith(".vale/");
}

export function selectDocumentationChecks(changedFiles, exists = fs.existsSync) {
  const uniquePaths = [...new Set(changedFiles)];
  return {
    markdownFiles: uniquePaths.filter((file) => file.endsWith(".md") && exists(file)),
    runGovernance: !exists("plan.md") || uniquePaths.some(isGovernanceInput),
  };
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  return result.status ?? 1;
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

  if (checks.markdownFiles.length > 0) {
    console.log(`[docs-affected] 检查 ${checks.markdownFiles.length} 个变更文档：`);
    for (const file of checks.markdownFiles) console.log(`  - ${file}`);
    const lintStatus = run("npx", ["markdownlint-cli2", "--config", ".markdownlint-cli2.jsonc", ...checks.markdownFiles]);
    if (lintStatus !== 0) {
      process.exitCode = lintStatus;
      return;
    }
    const valeStatus = run("vale", ["--minAlertLevel=error", ...checks.markdownFiles]);
    if (valeStatus !== 0) {
      process.exitCode = valeStatus;
      return;
    }
  } else {
    console.log("[docs-affected] 无现存 Markdown 待 lint；继续检查删除与治理输入变更。");
  }

  console.log("[docs-affected] 执行完整文档治理校验...");
  process.exitCode = run(process.execPath, ["scripts/docs-governance.mjs", "--strict"]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
