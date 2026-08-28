/**
 * Aervox｜思隅 依赖边界校验（AST 解析，依赖 @babel/parser，不承担编译）
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
 * 能力覆盖（AST 解析，2026-08-28 从正则升级；落地点修正见 ADR-016 决策记录）：
 *   - 静态 import / export ... from / 动态 import()（字符串字面量与纯模板字符串）
 *   - .vue 的 <script> 块内导入（含 lang="ts"）
 *   - 相对路径跨包引用（./ ../ → 解析到仓库相对路径后按包归属判定）
 * 解析器：@babel/parser（纯 JS）。原"复用根 typescript"方案因 typescript@7
 *           主入口不再暴露运行时 API（仅版本号，API 迁至 ./unstable/ast 原生绑定）而放弃。
 * 已知限制（由代码评审兜底）：
 *   - 动态 import() 为带表达式的模板字符串（目标无法静态确定）
 *   - CommonJS require()（仓库为 ESM-only，不做判定）
 *   - 解析不到实际文件的相对引用（按忽略处理）
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, sep, dirname, resolve } from "node:path";
import { parse } from "@babel/parser";

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
    ],
  },
];

/** 源码文件扩展（含 .vue：提取 <script> 块再解析） */
export const SOURCE_EXT_RE = /\.(ts|tsx|js|mjs|cjs|vue)$/;
export const IGNORE_DIR_RE = /(^|\/)(node_modules|dist|out|reference|\.git)(\/|$)/;

/** 从文本中提取 .vue 的 <script> 块（多 script 块全部提取） */
const SCRIPT_BLOCK_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/g;

/** 用 AST 提取模块说明符：import/export-from/动态 import()（字符串与纯模板字面量） */
function extractSpecifiers(source, fileName) {
  const specifiers = [];
  if (fileName.endsWith(".vue")) {
    for (const match of source.matchAll(SCRIPT_BLOCK_RE)) {
      collectFromTs(match[1], specifiers);
    }
    return specifiers;
  }
  collectFromTs(source, specifiers);
  return specifiers;
}

/** 解析单个 TS/JS/Vue-script 片段为 AST 并收集模块说明符（@babel/parser，不承担编译） */
function collectFromTs(text, out) {
  let ast;
  try {
    ast = parse(text, { sourceType: "module", plugins: ["typescript", "jsx"] });
  } catch {
    return; // 语法不完整/非 TS 方言 → 跳过，由评审兜底
  }
  const visit = (node) => {
    if (!node || typeof node !== "object" || typeof node.type !== "string") return;
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
        if (node.source?.value) out.push(node.source.value);
        break;
      case "ImportExpression": {
        // Babel 8 动态 import()：Source 与 options（ESM pragma）
        const arg = node.source;
        if (!arg) break;
        if (arg.type === "StringLiteral") out.push(arg.value);
        else if (arg.type === "TemplateLiteral" && arg.expressions.length === 0) {
          out.push(arg.quasis[0].value.cooked);
        }
        break;
      }
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) visit(item);
      } else {
        visit(child);
      }
    }
  };
  visit(ast);
}

const CANDIDATE_EXTS = ["", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".vue", "/index.ts"];
/** NodeNext 以 .js 引用 .ts 源：对 JS 扩展名做 TS 源回退 */
const JS_TO_TS = [
  [".js", [".ts", ".tsx"]],
  [".mjs", [".mts", ".ts"]],
  [".cjs", [".cts", ".ts"]],
];

/** 相对导入（./ ../）解析为仓库相对路径；解析不到返回 null */
function resolveRepoRelative(fromRelFile, specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const baseDir = dirname(join(process.cwd(), fromRelFile));
  const absTarget = resolve(baseDir, specifier);
  for (const ext of CANDIDATE_EXTS) {
    const candidate = absTarget + ext;
    if (existsSync(candidate)) {
      return relative(process.cwd(), candidate).split(sep).join("/");
    }
  }
  const jsMap = JS_TO_TS.find(([js]) => absTarget.endsWith(js));
  if (jsMap) {
    const stem = absTarget.slice(0, -jsMap[0].length);
    for (const tsExt of jsMap[1]) {
      const candidate = stem + tsExt;
      if (existsSync(candidate)) {
        return relative(process.cwd(), candidate).split(sep).join("/");
      }
    }
  }
  return null;
}

/** 仓库相对路径 → 所属 workspace 包键（packages/x 或 apps/x）；非包内返回 null */
function ownPackage(repoRel) {
  const m = repoRel.match(/^(packages|apps)\/([^/]+)\//);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** 仓库相对路径 → 伪包名（packages/x → @aervox/x；apps/x → @aervox/x）用于规则匹配 */
function toPseudoSpecifier(repoRel) {
  const m = repoRel.match(/^(packages|apps)\/([^/]+)\//);
  if (!m) return null;
  return `@aervox/${m[2]}`;
}

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
  const rawSpecifiers = extractSpecifiers(source, relFile);
  const owner = ownPackage(relFile);
  const normalized = rawSpecifiers.map((s) => {
    const resolved = resolveRepoRelative(relFile, s);
    if (resolved === null) return s; // 相对引用解析失败 → 保持原样（忽略判定）
    if (ownPackage(resolved) === owner) return s; // 同包内相对引用合法，不做跨层判定
    return toPseudoSpecifier(resolved) ?? s;
  });
  for (const rule of RULES) {
    if (!rule.fromDir.test(relFile)) continue;
    for (const specifier of normalized) {
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
  console.log(`✔ 依赖边界检查通过：无违规（规则 ${RULES.length} 条，TS AST 解析，详见 ADR-016）`);
}