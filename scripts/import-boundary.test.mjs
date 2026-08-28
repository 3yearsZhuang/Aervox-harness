/**
 * Aervox｜思隅 import-boundary 门禁自测（node --test，零依赖）
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

test("import 提取：type import / 副作用导入 / 动态 import() 均覆盖", () => {
  const typeOnly = `import type { X } from "@aervox/database";`;
  assert.deepEqual(v("packages/agent-loop/src/index.ts", typeOnly), ["agent-loop-no-db"]);
  const sideEffect = `import "@aervox/database";`;
  assert.deepEqual(v("packages/agent-loop/src/index.ts", sideEffect), ["agent-loop-no-db"]);
  const dynamic = `const mod = await import("@aervox/database");`;
  assert.deepEqual(v("packages/agent-loop/src/index.ts", dynamic), ["agent-loop-no-db"]);
});

test("相对路径导入不做跨层判定（含 apps 相对引用，已知限制由评审兜底）", () => {
  const rel = `import { x } from "../../apps/api/src/index.js";`;
  assert.deepEqual(v("packages/api-client/src/transport.ts", rel), []);
});

test("collectSourceFiles：只收源码扩展、排除 reference/dist/node_modules", () => {
  const files = collectSourceFiles();
  assert.ok(Array.isArray(files));
  assert.ok(files.length > 10, "应扫描出全部源码文件");
  assert.ok(files.some((f) => f.startsWith("packages/contracts/")), "应包含 contracts");
  assert.ok(!files.some((f) => f.includes("reference/") || f.includes("node_modules/") || f.includes("/dist/")));
});