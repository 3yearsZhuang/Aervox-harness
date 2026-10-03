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
  {
    id: "focus-mode-plugin",
    name: "专注模式第一方插件实现（服务端 + UI + 专属样式）",
    pilot: "BTD-11",
    implementationFiles: [
      "plugins/focus-mode/src/server/index.ts",
      "plugins/focus-mode/src/server/contracts.ts",
      "plugins/focus-mode/src/server/focus-tools.ts",
      "plugins/focus-mode/src/server/practice-reports-routes.ts",
      "plugins/focus-mode/src/server/prompt.ts",
      "plugins/focus-mode/src/server/terms-extractor.ts",
      "plugins/focus-mode/src/server/terms-routes.ts",
      "plugins/focus-mode/src/server/turn-plugin.ts",
      "plugins/focus-mode/src/ui/index.ts",
      "plugins/focus-mode/src/ui/plugin-events.ts",
      "plugins/focus-mode/src/ui/plugin-state.ts",
      "plugins/focus-mode/src/ui/useFocusLearning.ts",
      "plugins/focus-mode/src/ui/daily-problem.ts",
      "plugins/focus-mode/src/ui/FocusModeIndicator.vue",
      "plugins/focus-mode/src/ui/FocusModeSwitch.vue",
      "plugins/focus-mode/src/ui/FocusNavMenuItem.vue",
      "plugins/focus-mode/src/ui/FocusSettingsRow.vue",
      "plugins/focus-mode/src/ui/FocusStudyCardActions.vue",
      "plugins/focus-mode/src/ui/FocusTaskCenterCard.vue",
      "plugins/focus-mode/src/ui/FocusTermsBar.vue",
      "plugins/focus-mode/src/ui/LearningDrawer.vue",
      "plugins/focus-mode/src/ui/TermExploreDialog.vue",
      "plugins/focus-mode/src/ui/styles.css",
    ],
    // CR-060：宿主中唯一允许接入插件实现的位置（AVX-PLUG-001 §4.1 组合根）；
    // 插件自带测试直接引用其私有文件属合法（测试随实现内聚）。
    allowedAssemblyFiles: [
      "apps/api/src/plugin-assembly.ts",
      "apps/web/src/App.vue",
      "apps/desktop/src/renderer/src/App.vue",
      "plugins/focus-mode/test/focus-tools.test.ts",
      "plugins/focus-mode/test/prompt.test.ts",
      "plugins/focus-mode/test/terms-extractor.test.ts",
      "plugins/focus-mode/test/plugin-registration.test.ts",
      "plugins/focus-mode/test/ui-components.test.ts",
      "plugins/focus-mode/test/focus-learning.test.ts",
    ],
    /**
     * 物理移除计划（`run-removability-drill.mjs` 依此演练"代码缺席"）：
     * 删除整个插件包目录，并从三个组合根与其包清单中剥离引用——
     * 这正是发布一个不含该插件的宿主版本所做的事。
     */
    removalPlan: {
      removeDirectories: ["plugins/focus-mode"],
      strips: [
        { file: "apps/api/src/plugin-assembly.ts", pattern: "^.*@aervox/plugin-[^\\n]*\\n", flags: "gm" },
        { file: "apps/web/src/App.vue", pattern: "^.*(@aervox/plugin-|firstPartyPlugin|firstPartyPlugins)[^\\n]*\\n", flags: "gm" },
        { file: "apps/desktop/src/renderer/src/App.vue", pattern: "^.*(@aervox/plugin-|firstPartyPlugin|firstPartyPlugins)[^\\n]*\\n", flags: "gm" },
        { file: "apps/api/package.json", pattern: "^\\s*\"@aervox/plugin-[^\"]*\": \"[^\"]*\",?\\n", flags: "gm" },
        { file: "apps/web/package.json", pattern: "^\\s*\"@aervox/plugin-[^\"]*\": \"[^\"]*\",?\\n", flags: "gm" },
        { file: "apps/desktop/package.json", pattern: "^\\s*\"@aervox/plugin-[^\"]*\": \"[^\"]*\",?\\n", flags: "gm" },
      ],
    },
    dataRetentionRule:
      "移除插件实现不删除任何数据：安装记录、配置、授权与数据管理入口保留（CR-056 代码缺席语义）；" +
      "学习事实（questions/question_attempts/practice_reports）真源由宿主持有，不随插件删除",
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
