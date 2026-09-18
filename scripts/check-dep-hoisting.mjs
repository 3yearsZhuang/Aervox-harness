/**
 * Aervox｜思隅 依赖提升与版本分裂守卫
 *
 * 机器事实源：AGENTS.md §3「统一依赖治理」：
 * - 新增依赖一律在根目录执行 `pnpm add -w <pkg>`（开发依赖 `-Dw`）；
 * - 严禁进入各个子包目录单独安装开发运行工具（如 vitest, playwright, turbo 等）；
 * - 严格防止依赖版本分裂与幽灵依赖。
 *
 * 规则：
 * 1. 核心构建/测试工具必须且仅在根 package.json 中声明，子包一律不得重复声明。
 * 2. 根 devDependencies 中的工具若在子包重复声明，必须在 ALLOWLIST 中显式说明原因（如 typescript@5 for vue-tsc）。
 *
 * 用法：
 *   node scripts/check-dep-hoisting.mjs
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** 绝对禁止在任何子包中声明的根级工具包 */
export const FORBIDDEN_IN_SUBPACKAGES = new Set([
  "vitest",
  "playwright",
  "@playwright/test",
  "turbo",
  "electron-builder",
  "@vue/test-utils",
  "happy-dom",
  "sharp",
]);

/**
 * 允许在特定子包中覆盖声明的包及原因
 * 格式：`包名 -> Set(子包目录)`
 */
export const ALLOWED_DUPLICATES = new Map([
  [
    "typescript",
    new Set([
      "packages/ui",
      "apps/web",
      "apps/desktop",
    ]),
  ],
  [
    "@vitejs/plugin-vue",
    new Set([
      "apps/web",
      "apps/desktop",
    ]),
  ],
]);

export function getSubpackageJsonPaths(roots = ["apps", "packages"]) {
  const paths = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const pkgPath = join(root, entry, "package.json");
      if (existsSync(pkgPath)) {
        paths.push({ relDir: `${root}/${entry}`, pkgPath });
      }
    }
  }
  return paths;
}

export function inspectSubpackage(relDir, pkgJson, rootDevDeps) {
  const violations = [];
  const devDeps = Object.keys(pkgJson.devDependencies || {});
  const deps = Object.keys(pkgJson.dependencies || {});

  // 1. 绝对禁止的工具
  for (const d of [...devDeps, ...deps]) {
    if (FORBIDDEN_IN_SUBPACKAGES.has(d)) {
      violations.push({
        pkg: pkgJson.name || relDir,
        dep: d,
        reason: `属于根级统一工具（FORBIDDEN_IN_SUBPACKAGES），必须提升至根 package.json，子包不得声明`,
      });
    }
  }

  // 2. 根 devDependencies 重复声明检查（除白名单外）
  for (const d of devDeps) {
    if (rootDevDeps.has(d) && !FORBIDDEN_IN_SUBPACKAGES.has(d)) {
      const allowedDirs = ALLOWED_DUPLICATES.get(d);
      if (!allowedDirs || !allowedDirs.has(relDir)) {
        violations.push({
          pkg: pkgJson.name || relDir,
          dep: d,
          reason: `已在根 devDependencies 中声明，子包不得重复声明（如确需版本分裂，需在 scripts/check-dep-hoisting.mjs ALLOWED_DUPLICATES 登记）`,
        });
      }
    }
  }

  return violations;
}

export function runInspection(rootPkgPath = "package.json", roots = ["apps", "packages"]) {
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
  const rootDevDeps = new Set(Object.keys(rootPkg.devDependencies || {}));
  const subpackages = getSubpackageJsonPaths(roots);

  const violations = [];
  for (const { relDir, pkgPath } of subpackages) {
    const pkgJson = JSON.parse(readFileSync(pkgPath, "utf8"));
    violations.push(...inspectSubpackage(relDir, pkgJson, rootDevDeps));
  }
  return { subpackagesCount: subpackages.length, violations };
}

if (process.argv[1]?.endsWith("check-dep-hoisting.mjs")) {
  const { subpackagesCount, violations } = runInspection();
  if (violations.length > 0) {
    console.error(`❌ 发现 ${violations.length} 处子包依赖声明违规（AGENTS.md §3 统一依赖治理）：`);
    for (const v of violations) {
      console.error(`   ${v.pkg}: 依赖 "${v.dep}" ${v.reason}`);
    }
    process.exit(1);
  }
  console.log(`✔ 依赖提升与版本治理检查通过：${subpackagesCount} 个子包无违规重复依赖声明`);
}
