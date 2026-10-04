import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  REMOVABLE_TARGETS,
  auditTarget,
  runRemovabilityCheck,
} from "./check-removable-implementation.mjs";

const PLUGIN_TARGET_ID = "focus-mode-plugin";
const COMPOSITION_ROOTS = [
  "apps/api/src/plugin-assembly.ts",
  "apps/web/src/App.vue",
  "apps/desktop/src/renderer/src/App.vue",
];
const PLUGIN_PACKAGE_MANIFESTS = [
  "apps/api/package.json",
  "apps/web/package.json",
  "apps/desktop/package.json",
];

test("check-removable-implementation: targets 声明完整性", () => {
  assert.ok(REMOVABLE_TARGETS.length >= 2, "应至少包含 Memory 与模型驱动 2 个试点");
  for (const target of REMOVABLE_TARGETS) {
    assert.ok(target.id, "必须包含 id");
    assert.ok(target.name, "必须包含 name");
    assert.ok(target.pilot, "必须包含 pilot 编号 (BTD-*)");
    assert.ok(Array.isArray(target.implementationFiles) && target.implementationFiles.length > 0, "必须包含实现文件列表");
    assert.ok(Array.isArray(target.allowedAssemblyFiles) && target.allowedAssemblyFiles.length > 0, "必须包含装配入口列表");
    assert.ok(target.dataRetentionRule, "必须显式声明数据保留责任");
  }
});

test("check-removable-implementation: 全仓扫描 0 处非法私有引用", () => {
  const result = runRemovabilityCheck();
  assert.equal(result.valid, true, `违规列表应为空，实际发现: ${JSON.stringify(result.violations, null, 2)}`);
  assert.equal(result.violations.length, 0);
  assert.ok(result.targetsAudited >= 2);
});

test("check-removable-implementation: Worker 静态、动态、类型及显式扩展引用均被拒绝", () => {
  const dir = mkdtempSync("apps/worker/src/removability-fixture-");
  const file = `${dir}/consumer.ts`;
  const specifier = "../../../api/src/modules/companion/memory/tool-contribution";
  try {
    for (const statement of [
      `import { contributeMemoryTool } from "${specifier}.js";`,
      `export * from "${specifier}.ts";`,
      `const mod = import("${specifier}.js");`,
      `const mod = import(\`${specifier}.js\`);`,
      `type Mod = import("${specifier}.js");`,
    ]) {
      writeFileSync(file, statement);
      assert.equal(auditTarget(REMOVABLE_TARGETS[0], [file]).length, 1, statement);
    }
    writeFileSync(file, 'const broken = ;');
    assert.match(auditTarget(REMOVABLE_TARGETS[0], [file])[0].message, /无法解析/);
    writeFileSync(file, 'import { registerMemoryModule } from "../../../api/src/modules/companion/memory/index.js";');
    assert.deepEqual(auditTarget(REMOVABLE_TARGETS[0], [file]), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("check-removable-implementation: 第一方插件可移除目标（BTD-11）声明完整", () => {
  const target = REMOVABLE_TARGETS.find((t) => t.id === PLUGIN_TARGET_ID);
  assert.ok(target, `必须声明 ${PLUGIN_TARGET_ID} 移除目标（CR-060 / BTD-11）`);
  assert.equal(target.pilot, "BTD-11");
  assert.ok(
    target.implementationFiles.some((f) => f.endsWith("src/server/index.ts")),
    "实现文件必须包含插件服务端注册单元",
  );
  assert.ok(
    target.implementationFiles.every((f) => !f.includes("/dist/") && !f.includes("/node_modules/")),
    "实现文件清单不得包含构建产物或依赖目录",
  );
  for (const root of COMPOSITION_ROOTS) {
    assert.ok(target.allowedAssemblyFiles.includes(root), `装配白名单缺少组合根 ${root}`);
  }
});

test("check-removable-implementation: 移除计划（删除整包 + 剥离组合根与包清单）不得退化", () => {
  const target = REMOVABLE_TARGETS.find((t) => t.id === PLUGIN_TARGET_ID);
  assert.ok(target?.removalPlan, "必须声明 removalPlan");
  assert.deepEqual(target.removalPlan.removeDirectories, ["plugins/focus-mode"]);

  const stripped = target.removalPlan.strips.map((s) => s.file);
  for (const file of [...COMPOSITION_ROOTS, ...PLUGIN_PACKAGE_MANIFESTS]) {
    assert.ok(stripped.includes(file), `移除计划未剥离 ${file}`);
  }
});

test("check-removable-implementation: 剥离正则必须在当前源码命中（防空跑通过）", () => {
  const target = REMOVABLE_TARGETS.find((t) => t.id === PLUGIN_TARGET_ID);
  for (const strip of target.removalPlan.strips) {
    const before = readFileSync(strip.file, "utf8");
    const after = before.replace(new RegExp(strip.pattern, strip.flags), "");
    assert.notEqual(after, before, `剥离正则未命中 ${strip.file}，移除演练会退化为空跑`);
  }
});

test("check-removable-implementation: 插件实现文件清单与实际源码逐一对齐（不漏检新增文件）", () => {
  const target = REMOVABLE_TARGETS.find((t) => t.id === PLUGIN_TARGET_ID);
  const declared = new Set(target.implementationFiles);
  const onDisk = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else onDisk.push(full);
    }
  };
  walk("plugins/focus-mode/src");

  const missing = onDisk.filter((f) => !declared.has(f));
  assert.deepEqual(missing, [], `以下插件源文件未登记进 implementationFiles：${missing.join(", ")}`);
  for (const f of declared) {
    assert.ok(existsSync(f), `implementationFiles 声明的文件不存在：${f}`);
  }
});
