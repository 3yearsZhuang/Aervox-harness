#!/usr/bin/env node
/**
 * Aervox｜思隅 — 增量代码门禁检查器（极速本地门禁）
 *
 * 自动识别 Git 变更包及其下游，仅执行必要的边界检查、受影响包构建、
 * 类型检查与增量受控测试，杜绝全量 18 包与冷启动 install 的无效耗时。
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
console.log(`[check-affected] 增量基准分支: ${baseRef ?? "无（全量模式）"}`);

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

// 2. 增量构建与类型检查（Turbo 增量缓存）
const filterArg = baseRef ? `--filter=...[${baseRef}]` : "";
console.log(`\n[check-affected] 2/3 增量构建与类型检查 (${filterArg || "全量"})...`);
const buildArgs = ["exec", "turbo", "run", "build", "typecheck", "--concurrency=2"];
if (filterArg) buildArgs.push(filterArg);

const buildRes = spawnSync("pnpm", buildArgs, { stdio: "inherit" });
if (buildRes.status !== 0) {
  process.exit(buildRes.status ?? 1);
}

// 3. 增量测试（受控 2 并发，单 worker）
console.log(`\n[check-affected] 3/3 增量受控测试 (${filterArg || "全量"})...`);
const testArgs = ["exec", "turbo", "run", "test", "--concurrency=2"];
if (filterArg) testArgs.push(filterArg);

const testRes = spawnSync("pnpm", testArgs, { stdio: "inherit" });
process.exit(testRes.status ?? 0);
