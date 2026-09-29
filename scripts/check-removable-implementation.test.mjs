import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  REMOVABLE_TARGETS,
  auditTarget,
  runRemovabilityCheck,
} from "./check-removable-implementation.mjs";

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
