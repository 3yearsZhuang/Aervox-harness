#!/usr/bin/env node
/**
 * Aervox｜思隅 — 增量文档门禁检查器。
 *
 * 普通编辑只检查变更 Markdown；排版/术语配置变化时检查全部项目文档。
 * 文档、文档资产或治理输入变化时仍检查全仓本地链接，避免删除目标后跳过入链校验。
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
  return file.startsWith("docs/") || file.endsWith(".md") ||
    (file.startsWith("scripts/docs-") && file.endsWith(".mjs")) ||
    file === "mise.toml" ||
    file === ".github/workflows/docs.yml" ||
    file === ".markdownlint-cli2.jsonc" ||
    file === ".lycheeignore" ||
    file === ".vale.ini" ||
    file.startsWith(".vale/");
}

/**
 * 受治 Markdown 范围：与 `mise tasks run ci-docs` 的检查清单保持一致
 * （`docs/**` + 根 README/AGENTS/CONTRIBUTING/CHANGELOG/plan.md）。增量门禁若放宽到
 * 任意 `.md`，会去 lint 全量门禁从不检查的路径（如 `.agents/` 下的代理定义），
 * 使本地 `ci-fast` 因无关文件的历史排版问题变红。
 */
export function isGovernedMarkdown(file) {
  return (
    (file.endsWith(".md") && file.startsWith("docs/")) ||
    file === "README.md" ||
    file === "AGENTS.md" ||
    file === "CONTRIBUTING.md" ||
    file === "CHANGELOG.md" ||
    file === "plan.md"
  );
}

export function selectDocumentationChecks(changedFiles, exists = fs.existsSync) {
  const uniquePaths = [...new Set(changedFiles)];
  return {
    markdownFiles: uniquePaths.filter((file) => isGovernedMarkdown(file) && exists(file)),
    runGovernance: uniquePaths.some(isGovernanceInput),
    runMemoryDeletionStudy: uniquePaths.some((file) => file.startsWith("docs/explanation/memory-deletion-study/")),
    lintAll: uniquePaths.some((file) =>
      file === ".markdownlint-cli2.jsonc" || file === ".vale.ini" ||
      file.startsWith(".vale/") || file === "mise.toml",
    ),
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

  if (checks.lintAll) {
    checks.markdownFiles = fs.globSync(["docs/**/*.md", "README.md", "AGENTS.md", "CONTRIBUTING.md", "CHANGELOG.md", "plan.md"]).sort();
  }
  if (checks.markdownFiles.length > 0) {
    console.log(`[docs-affected] 检查 ${checks.markdownFiles.length} 个${checks.lintAll ? "全部" : "变更"}文档：`);
    for (const file of checks.markdownFiles) console.log(`  - ${file}`);
    // markdownlint-cli2 由 mise [tools] 固定版本并注入 PATH（见 mise.toml）。
    // 此前用 `npx` 现取：既不受版本真源约束，又会因~/.npm/_npx 缓存锁残留而整条门禁失败。
    const lintStatus = run("markdownlint-cli2", ["--config", ".markdownlint-cli2.jsonc", ...checks.markdownFiles]);
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

  if (checks.runMemoryDeletionStudy) {
    console.log("[docs-affected] 校验记忆删除研究的归档 JSON 与 CSV...");
    const studyStatus = run(process.execPath, [
      "scripts/memory-deletion-research/validate-report.mjs",
      "docs/explanation/memory-deletion-study/results",
    ]);
    if (studyStatus !== 0) {
      process.exitCode = studyStatus;
      return;
    }
  }

  console.log("[docs-affected] 检查文档 ID、ADR 状态与本地链接...");
  process.exitCode = run(process.execPath, ["scripts/docs-governance.mjs"]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
