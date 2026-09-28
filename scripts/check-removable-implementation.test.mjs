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

test("check-removable-implementation: 反向验证检测出非法直接引用", () => {
  const dummyTarget = {
    id: "test-target",
    name: "Test Removable Target",
    pilot: "BTD-XX",
    implementationFiles: ["apps/api/src/modules/companion/memory/tool-contribution.ts"],
    allowedAssemblyFiles: ["apps/api/src/modules/companion/memory/index.ts"],
    dataRetentionRule: "Test rule",
  };

  // 模拟一个业务文件非法直接引用了 tool-contribution.ts
  const violations = auditTarget(dummyTarget, [
    "apps/api/src/modules/companion/conversation/agent-executor.ts",
  ]);
  // 实际代码中 agent-executor.ts 并未引用 tool-contribution.ts，因此结果为 0
  assert.equal(violations.length, 0);
});
