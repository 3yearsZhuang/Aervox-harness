#!/usr/bin/env node
/**
 * Aervox｜思隅 — 智能增量测试调度器
 *
 * 自动识别 Git 变更基准（origin/main -> main -> HEAD~1），
 * 并调度 Turbo 对变更包及其全部下游依赖运行受控并发测试。
 */
import { execSync, spawnSync } from "node:child_process";

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

const baseRef = getBaseRef();
if (!baseRef) {
  console.log("[test-affected] 未检测到有效的 Git 基准分支，回退到全量测试...");
  const res = spawnSync("pnpm", ["test"], { stdio: "inherit" });
  process.exit(res.status ?? 0);
}

console.log(`[test-affected] 增量对比基准: ${baseRef}`);
const filterArg = `...[${baseRef}]`;
const args = ["exec", "turbo", "run", "test", "--concurrency=2", `--filter=${filterArg}`, ...process.argv.slice(2)];

const result = spawnSync("pnpm", args, { stdio: "inherit" });
process.exit(result.status ?? 0);
