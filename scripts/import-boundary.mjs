/**
 * Aervox｜思隅 依赖边界校验（零依赖，node 原生直跑）
 *
 * 机器事实源：ADR-016「底座边界冻结」的健身函数。任何底座边界的增删，
 * 必须同时更新本文与对应 ADR/文档；违反任一规则 ci-code 即失败。
 *
 * 用法：
 *   node scripts/import-boundary.mjs            # 全量检查，违规退出码 1
 *   node scripts/import-boundary.mjs --list     # 打印规则清单
 *
 * 底座分层（自底向上）：
 *   L0  packages/contracts    —— 纯契约，最底层
 *   L1  packages/database     —— 数据真源 + Outbox/Audit（允许依赖 contracts）
 *   L1  packages/agent-loop   —— Agent 执行底座（Port/执行器，禁触数据库）
 *   L2  packages/api-client / packages/ui —— 传输与表现底座（禁触数据库）
 *   L3  apps/*                —— 宿主 Shell（单向消费上述底座）
 *   预留 capabilities/ providers/ adapters/ modules/ —— 能力层（禁触库、禁依赖宿主）
 * 参考规则：AVX-HAR-001 §16.2（agent-loop 不导入 SQLite/Drizzle）；
 *           AVX-CAP-001 交付载体与自选机制（Kernel Substrate 边界、能力层接口边界）。
 *
 * 已知限制：只覆盖静态 import（from "…" / import "…"，含 type import 与动态 import()），
 * 不解析 .vue 的 <script> 内导入与字符串常量别名；此类导入由代码评审兜底。
 * 相对路径导入（./ ../）只发生在包内，不跨越包边界，不做跨层判定。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** 每条规则即 ADR-016 的一条健身函数 */
export const RULES = [
  {
    name: "contracts-must-be-leaf",
    docRef: "ADR-016 · AVX-CAP-001 L0",
    fromDir: /^packages\/contracts\//,
    forbid: [{ pattern: /^@aervox\//, label: "任何 @aervox 工作区包" }],
  },
  {
    name: "agent-loop-no-db",
    docRef: "AVX-HAR-001 §16.2",
    fromDir: /^packages\/agent-loop\//,
    forbid: [
      { pattern: /^@aervox\/database($|\/)/, label: "database（schema/仓储）" },
      { pattern: /^@libsql\//, label: "@libsql/client" },
      { pattern: /^drizzle-orm($|\/)/, label: "drizzle-orm" },
    ],
  },
  {
    name: "packages-no-host-imports",
    docRef: "ADR-016",
    fromDir: /^packages\/[^/]+\/(src|test)\//,
    forbid: [
      { pattern: /^@aervox\/(api|worker|web|desktop|mobile)$/, label: "宿主 Shell 包" },
      { pattern: /^apps\//, label: "apps/ 宿主 Shell" },
    ],
  },
  {
    name: "ui-client-no-db",
    docRef: "ADR-016 · AVX-CAP-001",
    fromDir: /^packages\/(ui|api-client)\//,
    forbid: [
      { pattern: /^@aervox\/database($|\/)/, label: "database（schema/仓储）" },
      { pattern: /^@libsql\//, label: "@libsql/client" },
      { pattern: /^drizzle-orm($|\/)/, label: "drizzle-orm" },
    ],
  },
  {
    name: "capability-layer-no-db-no-host",
    docRef: "AVX-CAP-001 · ADR-016",
    fromDir: /^(capabilities|providers|adapters|modules)\//,
    forbid: [
      { pattern: /^@aervox\/database($|\/)/, label: "database（schema/仓储）" },
      { pattern: /^@libsql\//, label: "@libsql/client" },
      { pattern: /^drizzle-orm($|\/)/, label: "drizzle-orm" },
      { pattern: /^@aervox\/(api|worker|web|desktop|mobile)$/, label: "宿主 Shell 包" },
      { pattern: /^apps\//, label: "apps/ 宿主 Shell" },
    ],
  },
];

/** 提取源码中的模块说明符（静态 import 的 from 目标 / 副作用导入 / 动态 import()） */
export const IMPORT_SPECIFIERS_RE =
  /(?:import\s*\(\s*|\bfrom\s+|\bimport\s+)["']([^"']+)["']/;
export const newImportsMatcher = () => new RegExp(IMPORT_SPECIFIERS_RE.source, "g");

/** 源码路径是否为允许扫描的源码文件 */
export const SOURCE_EXT_RE = /\.(ts|tsx|js|mjs|cjs)$/;
export const IGNORE_DIR_RE = /(^|\/)(node_modules|dist|out|reference|\.git)(\/|$)/;

/** 全量遍历目录（repo 根相对），返回源码文件相对路径列表 */
export function collectSourceFiles(rootDirs = ["apps", "packages"]) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      const rel = relative(process.cwd(), full).split(sep).join("/");
      if (stat.isDirectory()) {
        if (!IGNORE_DIR_RE.test(rel)) walk(full);
      } else if (SOURCE_EXT_RE.test(rel)) {
        out.push(rel);
      }
    }
  };
  for (const dir of rootDirs) {
    if (statSync(dir, { throwIfNoEntry: false })) walk(dir);
  }
  return out;
}

/** 对单个文件执行全部规则，返回违规列表 [{ file, rule, module, label }] */
export function inspectSource(relFile, source) {
  const violations = [];
  for (const rule of RULES) {
    if (!rule.fromDir.test(relFile)) continue;
    const matches = source.matchAll(newImportsMatcher());
    for (const match of matches) {
      const specifier = match[1];
      const forbidden = rule.forbid.find((f) => f.pattern.test(specifier));
      if (forbidden) {
        violations.push({
          file: relFile,
          rule: rule.name,
          docRef: rule.docRef,
          module: specifier,
          label: forbidden.label,
        });
      }
    }
  }
  return violations;
}

/** 门禁入口：返回违规列表 */
export function runInspection() {
  const violations = [];
  for (const rel of collectSourceFiles()) {
    const source = readFileSync(rel, "utf8");
    violations.push(...inspectSource(rel, source));
  }
  return violations;
}

if (process.argv[1]?.endsWith("import-boundary.mjs")) {
  if (process.argv.includes("--list")) {
    for (const rule of RULES) {
      console.log(
        `[${rule.name}] from ${rule.fromDir} → 禁止 ${rule.forbid.map((f) => f.label).join(" / ")}（${rule.docRef}）`,
      );
    }
    process.exit(0);
  }
  const violations = runInspection();
  if (violations.length > 0) {
    console.error(`❌ 依赖边界违规 ${violations.length} 处（ADR-016 底座边界）：`);
    for (const v of violations) {
      console.error(`   ${v.file}: [${v.rule}] 禁止导入 ${v.module}（${v.label}）· ${v.docRef}`);
    }
    process.exit(1);
  }
  console.log(`✔ 依赖边界检查通过：无违规（规则 ${RULES.length} 条，详见 ADR-016）`);
}