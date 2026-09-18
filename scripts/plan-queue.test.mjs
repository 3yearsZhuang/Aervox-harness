#!/usr/bin/env node
/**
 * Aervox｜思隅 — 计划队列真源、渲染与校验的回归测试。
 *
 * 覆盖三类风险：
 * 1. 真源结构与纪律（状态枚举、依赖悬空/成环、在制并发、证据要求）；
 * 2. 渲染幂等与写回（plan.md §2 是派生视图，重复渲染不得抖动）；
 * 3. 渲染即校验（手改生成区必须被发现）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  PLAN_PATH,
  QUEUE_PATH,
  applyQueueRegion,
  checkQueueSync,
  extractQueueRegion,
  loadQueue,
  renderItemRow,
  renderQueueRegion,
  validateQueue,
} from "./plan-queue.mjs";

function syntheticQueue(overrides = {}) {
  return {
    statuses: ["建议", "执行中", "已移交", "暂停"],
    batches: [{ id: "first", title: "2.1 第一批" }],
    items: [
      {
        id: "ITER-001",
        batch: "first",
        status: "建议",
        delivery: "交付 A",
        gate: "门槛 A",
        acceptance: ["判定 A"],
        owner: "platform",
        dependsOn: [],
      },
    ],
    ...overrides,
  };
}

function planWith(inner) {
  return ["# 计划", "", "## 2. 当前建议工作", "", inner, "", "## 3. 下一节", ""].join("\n");
}

function planWithPlaceholder(inner) {
  return planWith(["<!-- plan-queue:begin -->", inner, "<!-- plan-queue:end -->"].join("\n"));
}

function messages(findings) {
  return findings.map((finding) => `${finding.rule} ${finding.message}`);
}

test("真源覆盖全部迭代条目，且每条都有完成判定", () => {
  const queue = loadQueue();
  const ids = queue.items.map((item) => item.id);

  assert.equal(ids.length, 19, "队列条目数应与迁移前一致");
  assert.deepEqual(
    [...ids].sort(),
    Array.from({ length: 19 }, (_, index) => `ITER-${String(index + 1).padStart(3, "0")}`),
    "编号应为 ITER-001～ITER-019 且不重复",
  );
  for (const item of queue.items) {
    assert.ok(item.acceptance.length > 0, `${item.id} 缺少完成判定`);
    assert.ok(item.delivery.trim().length > 0, `${item.id} 缺少最小交付`);
    assert.ok(item.gate.trim().length > 0, `${item.id} 缺少依赖与 CR 门槛`);
  }
  assert.equal(validateQueue(queue, { enforcement: "warning" }).filter((f) => f.severity === "error").length, 0);
});

test("状态与批次必须在枚举内，观察期只报提示", () => {
  const queue = syntheticQueue();
  queue.items[0].status = "做完了";
  queue.items[0].batch = "third";

  const findings = validateQueue(queue, { enforcement: "warning" });
  assert.deepEqual(findings.map((f) => f.rule).sort(), ["H2", "H2"]);
  assert.ok(findings.every((finding) => finding.severity === "warning"), "观察期不得阻断");

  const strict = validateQueue(queue, { enforcement: "error" });
  assert.ok(strict.every((finding) => finding.severity === "error"), "升级后结构性违规应为错误");
});

test("依赖必须存在、不得自指或成环", () => {
  const queue = syntheticQueue();
  queue.items[0].dependsOn = ["ITER-999"];
  assert.match(messages(validateQueue(queue))[0], /H3 ITER-001: 依赖的 ITER-999 不存在/);

  const selfDependent = syntheticQueue();
  selfDependent.items[0].dependsOn = ["ITER-001"];
  assert.match(messages(validateQueue(selfDependent))[0], /H3 ITER-001: 依赖自身/);

  const cyclic = syntheticQueue({
    items: [
      { id: "ITER-001", batch: "first", status: "建议", delivery: "d", gate: "g", acceptance: ["a"], owner: "o", dependsOn: ["ITER-002"] },
      { id: "ITER-002", batch: "first", status: "建议", delivery: "d", gate: "g", acceptance: ["a"], owner: "o", dependsOn: ["ITER-001"] },
    ],
  });
  assert.ok(validateQueue(cyclic).some((finding) => finding.rule === "H4"), "成环必须被发现");
});

test("计划纪律：在制并发、分支、证据、阻碍与依赖次序", () => {
  const queue = syntheticQueue({
    items: [
      { id: "ITER-001", batch: "first", status: "执行中", delivery: "d", gate: "g", acceptance: ["a"], owner: "o", dependsOn: [] },
      { id: "ITER-002", batch: "first", status: "执行中", delivery: "d", gate: "g", acceptance: ["a"], owner: "o", dependsOn: [] },
      { id: "ITER-003", batch: "first", status: "已移交", delivery: "d", gate: "g", acceptance: ["a"], owner: "o", dependsOn: [] },
      { id: "ITER-004", batch: "first", status: "暂停", delivery: "d", gate: "g", acceptance: ["a"], owner: "o", dependsOn: [] },
      { id: "ITER-005", batch: "first", status: "执行中", delivery: "d", gate: "g", acceptance: ["a"], owner: "o", branch: "fix/x", dependsOn: ["ITER-001"] },
    ],
  });

  const rules = validateQueue(queue, { wipLimit: 1 }).map((finding) => finding.rule);
  for (const expected of ["S1", "S2", "S3", "S4", "S5"]) {
    assert.ok(rules.includes(expected), `应报告 ${expected}`);
  }
  assert.ok(
    validateQueue(queue, { wipLimit: 1 }).every((finding) => finding.severity === "warning"),
    "观察期一律提示",
  );
});

test("升级为 error 后纪律规则同样阻断，仅依赖次序保持提示", () => {
  const queue = syntheticQueue({
    items: [
      { id: "ITER-001", batch: "first", status: "执行中", delivery: "d", gate: "g", acceptance: ["a"], owner: "o", dependsOn: [] },
      { id: "ITER-002", batch: "first", status: "已移交", delivery: "d", gate: "g", acceptance: ["a"], owner: "o", dependsOn: [] },
      { id: "ITER-003", batch: "first", status: "暂停", delivery: "d", gate: "g", acceptance: ["a"], owner: "o", dependsOn: [] },
      { id: "ITER-004", batch: "first", status: "执行中", delivery: "d", gate: "g", acceptance: ["a"], owner: "o", branch: "fix/x", dependsOn: ["ITER-001"] },
    ],
  });

  const findings = validateQueue(queue, { wipLimit: 3, enforcement: "error" });
  const severityByRule = new Map(findings.map((finding) => [finding.rule, finding.severity]));
  assert.equal(severityByRule.get("S2"), "error", "执行中缺分支应阻断");
  assert.equal(severityByRule.get("S3"), "error", "已移交缺证据应阻断");
  assert.equal(severityByRule.get("S4"), "error", "暂停缺阻碍应阻断");
  assert.equal(severityByRule.get("S5"), "warning", "依赖次序需人工判断，保持提示");
});

test("渲染幂等：重复渲染字节一致，行内含全部列与锚点", () => {
  const queue = loadQueue();
  const first = renderQueueRegion(queue);
  assert.equal(first, renderQueueRegion(queue), "渲染必须幂等");

  const row = renderItemRow(queue.items[0]);
  const firstStatus = queue.items[0].status;
  assert.match(row, new RegExp(`^\\| <a id="iter-001"></a>ITER-001 · ${firstStatus} \\|`));
  assert.equal(row.split(" | ").length, 5, "渲染行必须保持五列");
  assert.match(row, /校验：/, "有校验路径的条目应在完成判定中带出校验");
  assert.match(first, /### 2\.1 第一批：正确性、验证入口与方向决策/);
});

test("写回只替换生成区，手写内容原样保留", () => {
  const queue = loadQueue();
  const plan = planWithPlaceholder("旧内容");
  const updated = applyQueueRegion(plan, renderQueueRegion(queue));

  assert.ok(updated.startsWith("# 计划\n\n## 2. 当前建议工作\n\n<!-- plan-queue:begin"), "生成区之前的内容不得变动");
  assert.ok(updated.endsWith("\n\n## 3. 下一节\n"), "生成区之后的内容不得变动");
  assert.equal(extractQueueRegion(updated).text, renderQueueRegion(queue));
});

test("渲染即校验：生成区被手改或缺失标记都要被发现", () => {
  const queue = loadQueue();
  const inSync = planWith(renderQueueRegion(queue).trimEnd());
  assert.deepEqual(checkQueueSync(queue, inSync), [], "同步时应无提示");

  // 与当前状态无关的篡改：换成枚举里的另一个状态，避免测试随条目状态演进而失配。
  const currentStatus = queue.items[0].status;
  const otherStatus = queue.statuses.find((status) => status !== currentStatus);
  const tampered = inSync.replace(`ITER-001 · ${currentStatus}`, `ITER-001 · ${otherStatus}`);
  assert.notEqual(tampered, inSync, "篡改必须真的改变了内容");

  const findings = checkQueueSync(queue, tampered);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /不一致/);
  assert.equal(findings[0].severity, "warning", "观察期不得阻断");

  const missing = checkQueueSync(queue, "# 只有正文\n");
  assert.match(missing[0].message, /缺少 plan-queue 生成区标记/);
});

test("真实 plan.md 与真源保持同步", () => {
  const queue = loadQueue();
  const plan = fs.readFileSync(PLAN_PATH, "utf8");
  assert.deepEqual(checkQueueSync(queue, plan), [], "plan.md §2 必须由 plan-render 生成");
  assert.equal(path.resolve(PLAN_PATH), path.join(path.dirname(QUEUE_PATH), "..", "..", "plan.md"));
});
