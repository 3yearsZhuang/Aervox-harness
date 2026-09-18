#!/usr/bin/env node
/**
 * Aervox｜思隅 — 增量代码门禁检查器（极速本地门禁）
 *
 * 自动识别 Git 变更包及其下游，仅执行必要的边界检查、受影响包构建、
 * 类型检查与增量受控测试，杜绝全量 18 包与冷启动 install 的无效耗时。
 *
 * 包外声明的输入（`plugins/**`、`vitest.shared.ts`、根级 tsconfig）由
 * `scripts/ci-scope.mjs` 显式补入范围：Turbo 的 `--filter=...[<base>]` 只看包目录内
 * 的变更，只改这些路径时会选中 0 个任务——哈希虽变为 MISS，任务却从不被调度。
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
const changeScope = resolveChangeScope(getChangedFiles(baseRef), loadTurboScope());
const filterArgs = buildTurboFilterArgs(baseRef, changeScope);

console.log(`[check-affected] 增量基准分支: ${baseRef ?? "无（全量模式）"}`);
console.log(`[check-affected] ${describeChangeScope(baseRef, changeScope).trimStart()}`);

// 1. 依赖边界检查（AST 解析，保证架构整洁）
console.log("\n[check-affected] 1/3 依赖边界检查...");
const boundaryRes = spawnSync(
  "node",
  ["scripts/import-boundary.mjs"],
  { stdio: "inherit" },
);
if (boundaryRes.status !== 0) {
  process.exit(boundaryRes.status ?? 1);
}

// 2. 增量构建与类型检查（Turbo 增量缓存 + 包外输入命中包）
const scopeLabel = changeScope.mode === "full" ? "全量（无过滤）" : filterArgs.join(" ");
console.log(`\n[check-affected] 2/3 增量构建与类型检查 (${scopeLabel})...`);
const buildArgs = ["exec", "turbo", "run", "build", "typecheck", "--concurrency=2", ...filterArgs];

const buildRes = spawnSync("pnpm", buildArgs, { stdio: "inherit" });
if (buildRes.status !== 0) {
  process.exit(buildRes.status ?? 1);
}

// 3. 增量测试（受控 2 并发，单 worker）
console.log(`\n[check-affected] 3/3 增量受控测试 (${scopeLabel})...`);
const testArgs = ["exec", "turbo", "run", "test", "--concurrency=2", ...filterArgs];

const testRes = spawnSync("pnpm", testArgs, { stdio: "inherit" });
process.exit(testRes.status ?? 0);
