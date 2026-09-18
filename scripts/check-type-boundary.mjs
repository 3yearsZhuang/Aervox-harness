/**
 * Aervox｜思隅 类型边界守卫（Contracts DTO 单一真源）
 *
 * 机器事实源：ADR-016「底座边界冻结」与 @aervox/contracts（唯一 DTO 事实源）。
 * 规则：
 * 禁止下游包（apps/*、packages/api-client/*、packages/ui/*）在本地手写重复声明
 * 已由 @aervox/contracts 导出的类型/接口，强制使用 `import from "@aervox/contracts"`。
 *
 * 用法：
 *   node scripts/check-type-boundary.mjs
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parse } from "@babel/parser";

const CONTRACTS_SRC_DIR = "packages/contracts/src";
const TARGET_DIRS = [
  "packages/api-client/src",
  "packages/ui/src",
  "apps/web/src",
  "apps/desktop/src",
  "apps/api/src",
  "apps/worker/src",
];

const SOURCE_EXT_RE = /\.(ts|tsx|vue)$/;
const SCRIPT_BLOCK_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/g;

export function collectContractExports(contractsDir = CONTRACTS_SRC_DIR) {
  const exportedNames = new Set();
  if (!existsSync(contractsDir)) return exportedNames;

  for (const entry of readdirSync(contractsDir)) {
    if (!entry.endsWith(".ts")) continue;
    const full = join(contractsDir, entry);
    const content = readFileSync(full, "utf8");
    let ast;
    try {
      ast = parse(content, { sourceType: "module", plugins: ["typescript"] });
    } catch {
      continue;
    }
    for (const node of ast.program.body) {
      if (node.type === "ExportNamedDeclaration") {
        if (node.declaration) {
          if (node.declaration.id?.name) {
            exportedNames.add(node.declaration.id.name);
          }
          if (node.declaration.declarations) {
            for (const d of node.declaration.declarations) {
              if (d.id?.name) exportedNames.add(d.id.name);
            }
          }
        }
        if (node.specifiers) {
          for (const s of node.specifiers) {
            if (s.exported?.name) {
              exportedNames.add(s.exported.name);
            }
          }
        }
      }
    }
  }
  return exportedNames;
}

export function inspectFileForDuplicateTypes(filePath, content, exportedNames) {
  const duplicates = [];
  const inspectCode = (code) => {
    let ast;
    try {
      ast = parse(code, { sourceType: "module", plugins: ["typescript", "jsx"] });
    } catch {
      return;
    }
    for (const node of ast.program.body) {
      let decl = node;
      if (node.type === "ExportNamedDeclaration" && node.declaration) {
        decl = node.declaration;
      }
      if (decl.type === "TSInterfaceDeclaration" || decl.type === "TSTypeAliasDeclaration") {
        const name = decl.id?.name;
        if (name && exportedNames.has(name)) {
          duplicates.push({
            file: filePath,
            name,
            line: decl.loc?.start?.line ?? 0,
            column: decl.loc?.start?.column ?? 0,
          });
        }
      }
    }
  };

  if (filePath.endsWith(".vue")) {
    for (const match of content.matchAll(SCRIPT_BLOCK_RE)) {
      inspectCode(match[1]);
    }
  } else {
    inspectCode(content);
  }

  return duplicates;
}

export function runInspection(targetDirs = TARGET_DIRS, contractsDir = CONTRACTS_SRC_DIR) {
  const exportedNames = collectContractExports(contractsDir);
  const duplicates = [];

  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isDirectory()) {
        walk(full);
      } else if (SOURCE_EXT_RE.test(entry)) {
        const content = readFileSync(full, "utf8");
        const rel = relative(process.cwd(), full).split(sep).join("/");
        duplicates.push(...inspectFileForDuplicateTypes(rel, content, exportedNames));
      }
    }
  };

  for (const d of targetDirs) {
    walk(d);
  }

  return duplicates;
}

if (process.argv[1]?.endsWith("check-type-boundary.mjs")) {
  const duplicates = runInspection();
  if (duplicates.length > 0) {
    console.error(`❌ 发现 ${duplicates.length} 处违规本地重复类型声明（已在 @aervox/contracts 中导出）：`);
    for (const d of duplicates) {
      console.error(`   ${d.file}:${d.line}:${d.column} 本地声明了 "${d.name}"，请直接 import from "@aervox/contracts"`);
    }
    process.exit(1);
  }
  console.log("✔ 类型边界检查通过：下游包中无与 @aervox/contracts 冲突的本地重复类型声明");
}
