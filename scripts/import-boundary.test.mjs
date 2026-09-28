/**
 * Aervox｜思隅 import-boundary 门禁自测（node --test，TS AST 方案）
 * 运行：node --test scripts/import-boundary.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectSourceFiles, inspectSource, RULES } from "./import-boundary.mjs";

const v = (file, source) => inspectSource(file, source).map((x) => x.rule);

test("规则矩阵：5 条底座健身函数齐备", () => {
  assert.deepEqual(
    RULES.map((r) => r.name).sort(),
    [
      "agent-loop-no-db",
      "capability-layer-no-db-no-host",
      "contracts-must-be-leaf",
      "packages-no-host-imports",
      "ui-client-no-db",
    ].sort(),
  );
});

test("contracts 是最底层：import @aervox/* 违规", () => {
  const src = `import { AervoxDatabase } from "@aervox/database";`;
  assert.deepEqual(v("packages/contracts/src/openapi.ts", src), ["contracts-must-be-leaf"]);
});

test("agent-loop 禁触数据库：database/libsql/drizzle 均违规", () => {
  const db = `import type { AervoxDatabase } from "@aervox/database";`;
  const libsql = `import { createClient } from "@libsql/client";`;
  const drizzle = `import { drizzle } from "drizzle-orm/libsql";`;
  const ok = `import type { ToolSpec } from "./types.js";`;
  for (const src of [db, libsql, drizzle]) {
    assert.deepEqual(v("packages/agent-loop/src/ports.ts", src), ["agent-loop-no-db"]);
  }
  assert.deepEqual(v("packages/agent-loop/src/tool-provider.ts", ok), []);
});

test("共享包不得依赖宿主 Shell：@aervox/api（绝对包名）违规", () => {
  const pkg = `import { register } from "@aervox/api";`;
  assert.deepEqual(v("packages/api-client/src/transport.ts", pkg), ["packages-no-host-imports"]);
});

test("ui/api-client 禁触数据库", () => {
  const src = `import { AervoxDatabase } from "@aervox/database";`;
  assert.deepEqual(v("packages/ui/src/index.ts", src), ["ui-client-no-db"]);
  assert.deepEqual(v("packages/api-client/src/transport.ts", src), ["ui-client-no-db"]);
  // 允许正常跨包依赖
  assert.deepEqual(v("packages/ui/src/index.ts", `import { useAervoxApi } from "@aervox/api-client";`), []);
});

test("能力/适配/模块化候选层禁触库、禁依赖宿主（未来目录，fail-closed）", () => {
  const db = `import { repo } from "@aervox/database/repositories";`;
  const host = `import { app } from "@aervox/web";`;
  assert.deepEqual(v("capabilities/conversation/src/definition.ts", db), ["capability-layer-no-db-no-host"]);
  assert.deepEqual(v("modules/practice/src/activate.ts", host), ["capability-layer-no-db-no-host"]);
  assert.deepEqual(v("providers/llm/openai-openai/src/adapter.ts", `import { port } from "@aervox/contracts";`), []);
});

test("宿主 Shell 允许消费底座（不违规）", () => {
  const src = `import { AervoxDatabase } from "@aervox/database";\nimport { executeTurn } from "@aervox/agent-loop";`;
  assert.deepEqual(v("apps/api/src/modules/conversation/agent-executor.ts", src), []);
});

test("AST 提取：type import / 副作用导入 / 动态 import() 均覆盖", () => {
  const typeOnly = `import type { X } from "@aervox/database";`;
  assert.deepEqual(v("packages/agent-loop/src/index.ts", typeOnly), ["agent-loop-no-db"]);
  const sideEffect = `import "@aervox/database";`;
  assert.deepEqual(v("packages/agent-loop/src/index.ts", sideEffect), ["agent-loop-no-db"]);
  const dynamic = `const mod = await import("@aervox/database");`;
  assert.deepEqual(v("packages/agent-loop/src/index.ts", dynamic), ["agent-loop-no-db"]);
});

test(".vue <script> 块内导入参与边界判定", () => {
  const vueSrc = `<template><div/></template>\n<script setup lang="ts">\nimport { db } from "@aervox/database";\n</script>`;
  assert.deepEqual(v("packages/ui/src/components/X.vue", vueSrc), ["ui-client-no-db"]);
  const vueOk = `<script setup lang="ts">\nimport { useAervoxApi } from "@aervox/api-client";\n</script>`;
  assert.deepEqual(v("packages/ui/src/components/Y.vue", vueOk), []);
});

test("export ... from 与纯模板字符串 import() 均覆盖", () => {
  const exportFrom = `export { resolveX } from "@aervox/database";`;
  assert.deepEqual(v("packages/agent-loop/src/index.ts", exportFrom), ["agent-loop-no-db"]);
  const templateLit = "const m = await import(`@libsql/client`);";
  assert.deepEqual(v("packages/agent-loop/src/index.ts", templateLit), ["agent-loop-no-db"]);
});

test("相对路径跨包引用可解析并判定（agent-loop → ../repositories 落库违规）", () => {
  // packages/agent-loop/src/x.ts → ../../repositories/src/index.ts 解析为 packages/repositories → @aervox/repositories
  const src = `import { AervoxDatabase } from "../../repositories/src/index.js";`;
  assert.deepEqual(v("packages/agent-loop/src/executor.ts", src), ["agent-loop-no-db"]);
});

test("已知限制：带表达式的模板字符串 import() 不判定（评审兜底）", () => {
  const dynamicExpr = "const m = await import(`./mod-${name}.js`);";
  assert.deepEqual(v("packages/agent-loop/src/index.ts", dynamicExpr), []);
});

test("相对路径解析不到实际文件时保持忽略（不误报）", () => {
  const rel = `import { x } from "../../apps/api/src/does-not-exist.js";`;
  assert.deepEqual(v("packages/api-client/src/transport.ts", rel), []);
});

test("collectSourceFiles：收 .ts/.vue、排除 reference/dist/node_modules", () => {
  const files = collectSourceFiles();
  assert.ok(Array.isArray(files));
  assert.ok(files.length > 10, "应扫描出全部源码文件");
  assert.ok(files.some((f) => f.startsWith("packages/contracts/")), "应包含 contracts");
  assert.ok(files.some((f) => f.endsWith(".vue")), "应包含 .vue 组件");
  assert.ok(!files.some((f) => f.includes("reference/") || f.includes("node_modules/") || f.includes("/dist/")));
});
const consumer = "apps/api/src/modules/companion/conversation/_boundary-fixture.ts";
const checkModule = (source) => inspectSource(consumer, source, { exceptions: [] }).map((v) => v.rule);

test("模块公开入口可解析 .js、目录 index、相对绕行；同模块内部合法", () => {
  for (const target of ["../../ecosystem/tools/index.js", "../../ecosystem/tools", "../../ecosystem/tools/../tools/index.ts", "./memory-recall.js"]) {
    assert.deepEqual(checkModule(`import type { X } from "${target}";`), []);
  }
});

test("跨域和同域私有引用：类型、重导出、动态字面量和 TSImportType 全部阻断", () => {
  for (const target of ["../../ecosystem/tools/runtime.js", "../memory/routes.js"]) {
    for (const source of [
      `import type { X } from "${target}";`,
      `export * from "${target}";`,
      `const x = import("${target}");`,
      `const x = import(\`${target}\`);`,
      `type X = import("${target}").X;`,
    ]) assert.deepEqual(checkModule(source), ["module-public-entry"]);
  }
});

test("纳管源码解析错误、缺失目标、动态非字面量不能静默通过", () => {
  assert.deepEqual(checkModule("const = ;"), ["module-parse-error"]);
  assert.deepEqual(checkModule('import "./missing-target.js";'), ["module-unresolved-import"]);
  assert.deepEqual(checkModule('const x = import(path);'), ["module-parse-error"]);
});

test("组合根无目录豁免；过渡授权必须精确到边且具备责任与退出条件", () => {
  const source = 'import "./modules/ecosystem/tools/runtime.js";';
  const edge = { from: "apps/api/src/app.ts", to: "apps/api/src/modules/ecosystem/tools/runtime.ts", owner: "platform", removeWhen: "Port migration" };
  assert.equal(inspectSource(edge.from, source, { exceptions: [] }).length, 1);
  assert.equal(inspectSource(edge.from, source, { exceptions: [edge] }).length, 0);
  assert.equal(inspectSource(edge.from, source, { exceptions: [{ ...edge, owner: "" }] }).length, 1);
  assert.equal(inspectSource("apps/api/src/other.ts", source, { exceptions: [edge] }).length, 1);
});

test("TSImportType 也遵循原有包边界", () => {
  assert.deepEqual(v("packages/agent-loop/src/ports.ts", 'type X = import("@aervox/repositories").X'), ["agent-loop-no-db"]);
});
