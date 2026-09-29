/**
 * Aervox｜思隅 可移除实现与退出演练守卫（Build to Delete）
 *
 * 机器事实源：CR-056 §5.8（BTD-07）与 ADR-016。
 * 规则：
 * 1. 试点可替换/可移除实现（如 MemoryStore 工具贡献、单个模型驱动 LlamaServerManager）
 *    仅允许在声明的装配入口（模块 index.ts / 组合根）和专用回归测试中被直接引用。
 * 2. 外部业务消费者严禁直接引用可移除实现的私有文件，确保物理移除实现后消费方无悬空导入。
 * 3. 记录数据保留与数据权利责任，确保退出时不丢失数据管理/导出/删除能力。
 *
 * 用法：
 *   node scripts/check-removable-implementation.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, relative, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { collectSourceFiles } from "./import-boundary.mjs";
import { parse } from "@babel/parser";

export const REMOVABLE_TARGETS = [
  {
    id: "memory-store-tool",
    name: "MemoryStore 工具贡献",
    pilot: "BTD-03",
    implementationFiles: [
      "apps/api/src/modules/companion/memory/tool-contribution.ts",
      "apps/api/src/modules/companion/memory/memory-store-tool.ts",
    ],
    allowedAssemblyFiles: [
      "apps/api/src/modules/companion/memory/index.ts",
      "apps/api/test/memory-tool-contribution.test.ts",
      "apps/api/test/tool-runtime-lifecycle.test.ts",
    ],
    dataRetentionRule: "退出工具贡献不删除记忆数据库节点，保留查询、导出与删除等数据权利",
  },
  {
    id: "llama-server-driver",
    name: "LlamaServerManager 模型驱动",
    pilot: "BTD-04",
    implementationFiles: [
      "apps/api/src/modules/ecosystem/model-runtime/llama-server.ts",
    ],
    allowedAssemblyFiles: [
      "apps/api/src/modules/ecosystem/model-runtime/index.ts",
      "apps/api/test/model-runtime-llama-server.test.ts",
      "apps/api/test/model-runtime-api.test.ts",
    ],
    dataRetentionRule: "移除驱动后模型文件与侧车完整保留，不静默走远程，通过 Fake/Unavailable 驱动维持服务契约",
  },
];

const CANDIDATE_EXTS = ["", ".ts", ".js", ".mjs", "/index.ts", "/index.js"];
const JS_TS_MAP = [
  [".js", [".ts", ".tsx", ".d.ts"]],
  [".mjs", [".mts"]],
];

function resolveSpecifier(fromRelFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const baseDir = dirname(resolve(process.cwd(), fromRelFile));
  const absTarget = resolve(baseDir, specifier);
  for (const ext of CANDIDATE_EXTS) {
    const candidate = absTarget + ext;
    if (existsSync(candidate)) {
      return relative(process.cwd(), candidate).split(sep).join("/");
    }
  }
  for (const jsMap of JS_TS_MAP) {
    if (!absTarget.endsWith(jsMap[0])) continue;
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

function extractImports(source, fileName) {
  if (fileName.endsWith(".vue")) {
    return [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
      .flatMap((match) => extractImports(match[1], "script.ts"));
  }
  const specifiers = [];
  const ast = parse(source, { sourceType: "module", plugins: fileName.endsWith(".tsx") || fileName.endsWith(".jsx") ? ["typescript", "jsx"] : ["typescript"], createImportExpressions: true });
  const visit = (node) => {
    if (!node || typeof node !== "object" || typeof node.type !== "string") return;
    switch (node.type) {
      case "TSImportType":
        if (node.argument?.value ?? node.source?.value) specifiers.push(node.argument?.value ?? node.source.value);
        break;
      case "ImportExpression":
        if (node.source?.value) specifiers.push(node.source.value);
        else if (node.source?.type === "TemplateLiteral" && node.source.expressions.length === 0) specifiers.push(node.source.quasis[0].value.cooked);
        break;
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
        if (node.source?.value) specifiers.push(node.source.value);
        break;
      case "CallExpression":
        if (node.callee?.type === "Import" && node.arguments?.[0]?.value) {
          specifiers.push(node.arguments[0].value);
        }
        break;
    }
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "loc" || key === "start" || key === "end") continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof item === "object") visit(item);
      } else if (child && typeof child === "object") {
        visit(child);
      }
    }
  };
  visit(ast.program);
  return specifiers;
}

export function auditTarget(target, fileList) {
  const violations = [];
  const implSet = new Set(target.implementationFiles);
  const allowedSet = new Set([...target.implementationFiles, ...target.allowedAssemblyFiles]);

  for (const relFile of fileList) {
    if (allowedSet.has(relFile)) continue;
    let source = "";
    try {
      source = readFileSync(relFile, "utf8");
    } catch {
      continue;
    }
    let specifiers;
    try { specifiers = extractImports(source, relFile); } catch (error) {
      violations.push({ targetId: target.id, file: relFile, message: `无法解析受审源码: ${error.message}` });
      continue;
    }
    for (const specifier of specifiers) {
      const resolved = resolveSpecifier(relFile, specifier);
      if (resolved && implSet.has(resolved)) {
        violations.push({
          targetId: target.id,
          targetName: target.name,
          pilot: target.pilot,
          file: relFile,
          imported: resolved,
          specifier,
          message: `非装配文件禁止直接引用可移除实现私有文件（应通过模块公开 Port 装配）`,
        });
      }
    }
  }
  return violations;
}

export function runRemovabilityCheck(targets = REMOVABLE_TARGETS, files = collectSourceFiles()) {
  const allViolations = [];
  for (const target of targets) {
    const v = auditTarget(target, files);
    allViolations.push(...v);
  }
  return {
    valid: allViolations.length === 0,
    targetsAudited: targets.length,
    violations: allViolations,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = runRemovabilityCheck();
  if (!result.valid) {
    console.error(`✖ 可移除实现守卫失败：发现 ${result.violations.length} 处非法直接私有引用！`);
    for (const v of result.violations) {
      console.error(`  - [${v.pilot}/${v.targetId}] ${v.file} -> ${v.imported} (${v.message})`);
    }
    process.exit(1);
  }
  console.log(`✔ 可移除实现守卫通过：${result.targetsAudited} 个试点实现隔离完好，无越权直接引用（CR-056 BTD-07）`);
}
