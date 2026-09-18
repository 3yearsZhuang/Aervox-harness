#!/usr/bin/env node
/**
 * Aervox｜思隅 — CI / 增量门禁的"变更作用域"解析（ITER-001 可重现验证入口）。
 *
 * 为什么需要它：Turbo 的差异过滤器 `--filter=...[<base>]` 只能看见**包目录内**的
 * 变更，仓库里却存在两类声明在包目录之外的 Turbo 输入：
 *
 * 1. 包级任务的自定义 inputs，如 `@aervox/api#test` 的 `../../plugins/**`；
 * 2. 无包前缀任务的共享 inputs，如 `test` 的 `../../vitest.shared.ts`。
 *
 * 只改这些路径时，缓存哈希确实变了（`cache=MISS`），但差异过滤器会选中 0 个任务
 * ——任务从不被调度，本地 `./aervox ci` 与 `./aervox test` 因此假绿；根级
 * `globalDependencies`（如 `tsconfig.base*.json`）甚至连哈希都不变，陈旧结果被
 * 直接重放。工作流触发路径若不同步，CI 侧同样不会重新验证。
 *
 * 本模块把「变更文件 → 受影响范围」显式解析出来，并让同一份声明同时约束
 * 本地增量门禁与 GitHub Actions 触发路径（见 `scripts/ci-scope.test.mjs`）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 依次回退的增量基准：优先远端 main，其次本地 main，最后 HEAD~1。 */
export function getBaseRef(cwd = ROOT_DIR) {
  for (const ref of ["origin/main", "main", "HEAD~1"]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", ref], { stdio: "ignore", cwd });
      return ref;
    } catch {
      // 该候选不存在，继续下一个
    }
  }
  return null;
}

/**
 * 工作区 + 已提交变更的文件集合（仓库根相对 POSIX 路径）。
 * 同时覆盖未提交改动与 `base...HEAD` 已提交差量，重命名的旧路径也保留。
 */
export function getChangedFiles(baseRef = getBaseRef(), cwd = ROOT_DIR) {
  const changed = new Set();

  const status = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    encoding: "utf8",
    cwd,
  });
  const tokens = status.split("\0").filter((token) => token.length > 0);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const statusCode = token.slice(0, 2);
    const file = token.slice(3);
    if (file) changed.add(file);
    // `-z` 下重命名/复制条目会把原路径作为下一个 NUL 分隔字段附加。
    if (statusCode.includes("R") || statusCode.includes("C")) {
      const original = tokens[i + 1];
      if (original) {
        changed.add(original);
        i += 1;
      }
    }
  }

  if (baseRef) {
    const diff = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", `${baseRef}...HEAD`], {
      encoding: "utf8",
      cwd,
    });
    for (const file of diff.split("\0")) {
      if (file) changed.add(file);
    }
  }

  return [...changed];
}

/**
 * glob → 正则。语义与 GitHub Actions `paths` / Turbo inputs 一致：
 * `*` 不跨 `/`，`**` 跨目录（`**\/` 允许零层）。
 */
export function globToRegExp(pattern) {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

export function matchesGlob(file, pattern) {
  return globToRegExp(pattern).test(file);
}

/** 把包内相对声明（`../../plugins/**`）归一化为仓库根相对 glob。 */
export function normalizeDeclaredInput(glob) {
  let normalized = glob;
  while (normalized.startsWith("../")) normalized = normalized.slice(3);
  return normalized.replace(/^\.\//, "");
}

/**
 * 从 turbo.json 提取"声明在包目录之外"的输入。
 *
 * - `packageInputs`：`@aervox/api#test` 这类带包前缀的任务，可直接映射回该包；
 * - `sharedInputs`：`test` 这类无包前缀任务，对所有含该脚本的包生效；
 * - `globalDependencies`：根级共享配置，变更即影响全部任务。
 *
 * 包内输入（`src/**` 等）由 Turbo 自身的差异检测与哈希覆盖，这里不重复声明。
 */
export function loadTurboScope(turboJsonPath = path.join(ROOT_DIR, "turbo.json")) {
  const config = JSON.parse(fs.readFileSync(turboJsonPath, "utf8"));
  const globalDependencies = (config.globalDependencies ?? []).map(normalizeDeclaredInput);
  const packageInputs = [];
  const sharedInputs = [];

  for (const [taskKey, taskConfig] of Object.entries(config.tasks ?? {})) {
    for (const raw of taskConfig?.inputs ?? []) {
      if (!raw.startsWith("../")) continue;
      const glob = normalizeDeclaredInput(raw);
      if (taskKey.includes("#")) {
        const [pkg, task] = taskKey.split("#");
        packageInputs.push({ pkg, task, glob, raw });
      } else {
        sharedInputs.push({ task: taskKey, glob, raw });
      }
    }
  }

  return { globalDependencies, packageInputs, sharedInputs };
}

/**
 * 把变更文件解析为受影响的验证范围：
 *
 * - `full`：命中共享输入或根级依赖 → 无法安全收窄，跑全量；
 * - `scoped`：命中某包声明的包外输入 → 显式带上该包及其下游；
 * - `diff-only`：仅包内变更，交给 `--filter=...[base]` 自行判定。
 */
export function resolveChangeScope(changedFiles, scope) {
  const reasons = [];
  const packages = new Set();
  let affectsAll = false;

  for (const decl of scope.packageInputs) {
    const hits = changedFiles.filter((file) => matchesGlob(file, decl.glob));
    if (hits.length > 0) {
      packages.add(decl.pkg);
      reasons.push({ kind: "package-input", label: `${decl.pkg}#${decl.task} ← ${decl.raw}`, hits });
    }
  }

  for (const decl of scope.sharedInputs) {
    const hits = changedFiles.filter((file) => matchesGlob(file, decl.glob));
    if (hits.length > 0) {
      affectsAll = true;
      reasons.push({ kind: "shared-input", label: `${decl.task} ← ${decl.raw}`, hits });
    }
  }

  for (const glob of scope.globalDependencies) {
    const hits = changedFiles.filter((file) => matchesGlob(file, glob));
    if (hits.length > 0) {
      affectsAll = true;
      reasons.push({ kind: "global-dependency", label: glob, hits });
    }
  }

  if (affectsAll) return { mode: "full", packages: [], reasons };
  if (packages.size > 0) return { mode: "scoped", packages: [...packages].sort(), reasons };
  return { mode: "diff-only", packages: [], reasons };
}

/** 构造 Turbo 过滤器参数：增量范围 + 包外输入命中的包（含其下游）。 */
export function buildTurboFilterArgs(baseRef, changeScope) {
  if (!baseRef || changeScope.mode === "full") return [];
  const args = [`--filter=...[${baseRef}]`];
  for (const pkg of changeScope.packages) args.push(`--filter=${pkg}...`);
  return args;
}

/** 人类可读的作用域说明，便于在门禁输出中复现"为什么跑了这些包"。 */
export function describeChangeScope(baseRef, changeScope) {
  const lines = [];
  if (changeScope.mode === "full") {
    lines.push("  范围: 全量（共享输入或根级依赖变更，无法安全收窄）");
  } else if (changeScope.mode === "scoped") {
    lines.push(`  范围: 增量 + 包外输入命中包 ${changeScope.packages.join(", ")}`);
  } else {
    lines.push(`  范围: 仅包内增量（基准 ${baseRef ?? "无"}）`);
  }
  for (const reason of changeScope.reasons) {
    lines.push(`  - [${reason.kind}] ${reason.label} ← ${reason.hits.slice(0, 3).join(", ")}${reason.hits.length > 3 ? ` 等 ${reason.hits.length} 项` : ""}`);
  }
  return lines.join("\n");
}

/**
 * 解析工作流的 `on.pull_request.paths` / `on.push.paths`。
 * 内联写法（`on: [push]`）无法识别时返回 null，由断言侧按失败处理（fail-closed）。
 */
export function readWorkflowPaths(workflowPath) {
  const lines = fs.readFileSync(workflowPath, "utf8").split(/\r?\n/);
  const result = { pullRequest: null, push: null };
  let eventKey = null;
  let eventIndent = -1;
  let pathsIndent = -1;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;

    if (pathsIndent >= 0 && indent > pathsIndent) {
      const entry = /^-\s+(.*)$/.exec(trimmed);
      if (entry) {
        result[eventKey].push(entry[1].trim().replace(/^["']|["']$/g, ""));
        continue;
      }
    }

    if (pathsIndent >= 0 && indent <= pathsIndent) pathsIndent = -1;

    const eventMatch = /^(pull_request|push)\s*:\s*$/.exec(trimmed);
    if (eventMatch) {
      eventKey = eventMatch[1] === "pull_request" ? "pullRequest" : "push";
      result[eventKey] = [];
      eventIndent = indent;
      continue;
    }

    if (eventKey && indent > eventIndent && /^paths\s*:\s*$/.test(trimmed)) {
      pathsIndent = indent;
    }
  }

  return result;
}

/** 找出未被工作流触发路径覆盖的必需输入（覆盖 = 等值或 glob 命中）。 */
export function findUncoveredPaths(workflowPaths, requiredPaths) {
  if (!Array.isArray(workflowPaths) || workflowPaths.length === 0) return [...requiredPaths];
  return requiredPaths.filter(
    (required) => !workflowPaths.some((entry) => entry === required || matchesGlob(required, entry)),
  );
}

/** 代码侧必需触发路径 = 全部包外 Turbo 输入 + 根级 globalDependencies。 */
export function collectRequiredCodePaths(scope) {
  return [
    ...new Set([
      ...scope.globalDependencies,
      ...scope.packageInputs.map((decl) => decl.glob),
      ...scope.sharedInputs.map((decl) => decl.glob),
    ]),
  ].sort();
}
