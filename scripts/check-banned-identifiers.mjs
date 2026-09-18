/**
 * Aervox｜思隅 禁用标识符守卫（CR-030 去租户化不变量）
 *
 * 机器事实源：CR-030 全面去租户化决议与 AGENTS.md §3 硬性约束。
 * 严禁在代码或契约中引入 `TenantContext`、`tenantId` 等多租户隔离概念。
 *
 * 用法：
 *   node scripts/check-banned-identifiers.mjs            # 全量检查，违规退出码 1
 *   node scripts/check-banned-identifiers.mjs --list     # 打印规则清单
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parse } from "@babel/parser";

export const RULES = [
  {
    name: "ban-tenant-context-global",
    description: "全局禁止使用 TenantContext（一律使用 LocalContext 替代）",
    bannedNames: new Set(["TenantContext"]),
    filePattern: /^(apps|packages)\//,
    excludePattern: null,
  },
  {
    name: "ban-tenant-id-code",
    description: "源码中禁止使用 tenantId（历史 DDL/迁移除外）",
    bannedNames: new Set(["tenantId"]),
    filePattern: /^(apps|packages)\//,
    excludePattern: /(^|\/)(migrations?|ddl|fixtures?)\//,
  },
  {
    name: "ban-tenant-core-packages",
    description: "契约、模式、底座及主动循环中禁止使用 tenant 标识符",
    bannedNames: new Set(["tenant"]),
    filePattern: /^(packages\/(contracts|schema|agent-loop|host-agent)|apps\/worker\/src\/proactive)\//,
    excludePattern: null,
  },
];

export const SOURCE_EXT_RE = /\.(ts|tsx|js|mjs|cjs|vue)$/;
export const IGNORE_DIR_RE = /(^|\/)(node_modules|dist|out|reference|\.git)(\/|$)/;
const SCRIPT_BLOCK_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/g;

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

export function extractIdentifiers(source, fileName) {
  const identifiers = [];
  const collect = (code) => {
    let ast;
    try {
      ast = parse(code, { sourceType: "module", plugins: ["typescript", "jsx"] });
    } catch {
      return;
    }
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (node.type === "Identifier" && typeof node.name === "string") {
        identifiers.push({
          name: node.name,
          line: node.loc?.start?.line ?? 0,
          column: node.loc?.start?.column ?? 0,
        });
      }
      for (const key of Object.keys(node)) {
        if (key === "loc" || key === "comments") continue;
        const child = node[key];
        if (Array.isArray(child)) {
          for (const item of child) visit(item);
        } else {
          visit(child);
        }
      }
    };
    visit(ast);
  };

  if (fileName.endsWith(".vue")) {
    for (const match of source.matchAll(SCRIPT_BLOCK_RE)) {
      collect(match[1]);
    }
  } else {
    collect(source);
  }
  return identifiers;
}

export function inspectFile(relFile, source) {
  const violations = [];
  const applicableRules = RULES.filter(
    (rule) =>
      rule.filePattern.test(relFile) &&
      (!rule.excludePattern || !rule.excludePattern.test(relFile)),
  );
  if (applicableRules.length === 0) return violations;

  const identifiers = extractIdentifiers(source, relFile);
  for (const id of identifiers) {
    for (const rule of applicableRules) {
      if (rule.bannedNames.has(id.name)) {
        violations.push({
          file: relFile,
          rule: rule.name,
          description: rule.description,
          identifier: id.name,
          line: id.line,
          column: id.column,
        });
      }
    }
  }
  return violations;
}

export function runInspection(rootDirs = ["apps", "packages"]) {
  const violations = [];
  for (const rel of collectSourceFiles(rootDirs)) {
    const source = readFileSync(rel, "utf8");
    violations.push(...inspectFile(rel, source));
  }
  return violations;
}

if (process.argv[1]?.endsWith("check-banned-identifiers.mjs")) {
  if (process.argv.includes("--list")) {
    console.log("CR-030 禁用标识符规则清单：");
    for (const rule of RULES) {
      console.log(`  [${rule.name}] ${rule.description}`);
    }
    process.exit(0);
  }
  const violations = runInspection();
  if (violations.length > 0) {
    console.error(`❌ 发现 ${violations.length} 处 CR-030 禁用标识符违规：`);
    for (const v of violations) {
      console.error(`   ${v.file}:${v.line}:${v.column} [${v.rule}] 禁用标识符 "${v.identifier}"（${v.description}）`);
    }
    process.exit(1);
  }
  console.log(`✔ CR-030 禁用标识符检查通过：无违规（规则 ${RULES.length} 条）`);
}
