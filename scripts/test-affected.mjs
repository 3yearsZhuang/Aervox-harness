#!/usr/bin/env node
/**
 * Aervox｜思隅 — 智能增量测试调度器
 *
 * 自动识别 Git 变更基准（origin/main -> main -> HEAD~1），
 * 并调度 Turbo 对变更包及其全部下游依赖运行受控并发测试。
 *
 * 与 `check-affected.mjs` 共用 `scripts/ci-scope.mjs`：包外声明的输入
 * （`plugins/**`、`vitest.shared.ts`、根级 tsconfig）不在任何包目录内，
 * Turbo 的差异过滤器看不见它们，需显式补入范围。
 */
import { spawnSync } from "node:child_process";
import {
  buildTurboFilterArgs,
  describeChangeScope,
  getBaseRef,
  getChangedFiles,
  loadTurboScope,
  resolveChangeScope,
} from "./ci-scope.mjs";

const baseRef = getBaseRef();
if (!baseRef) {
  console.log("[test-affected] 未检测到有效的 Git 基准分支，回退到全量测试...");
  const res = spawnSync("pnpm", ["test"], { stdio: "inherit" });
  process.exit(res.status ?? 0);
}

const changeScope = resolveChangeScope(getChangedFiles(baseRef), loadTurboScope());
const filterArgs = buildTurboFilterArgs(baseRef, changeScope);

console.log(`[test-affected] 增量对比基准: ${baseRef}`);
console.log(`[test-affected] ${describeChangeScope(baseRef, changeScope).trimStart()}`);

const args = ["exec", "turbo", "run", "test", "--concurrency=2", ...filterArgs, ...process.argv.slice(2)];

const result = spawnSync("pnpm", args, { stdio: "inherit" });
process.exit(result.status ?? 0);
