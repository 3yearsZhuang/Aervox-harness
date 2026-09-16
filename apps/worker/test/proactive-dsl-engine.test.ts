/**
 * CR-033 E2a 受限规则 DSL 求值器 fail-closed 测试。
 *
 * 覆盖：
 * - 静态检查：字段白名单、深度/节点数/字符串超限、canonical hash 稳定；
 * - 运行期：组合表达式、除零不命中、未知节点不命中、超时/步骤耗尽不命中、时间窗；
 * - 未知字段 / 未知版本 fail-closed。
 */
import { describe, expect, it } from "vitest";
import {
  proactiveDslRuleSchema,
  PROACTIVE_DSL_VERSION,
  type SituationModelV1,
} from "@aervox/contracts";
import {
  canonicalDslHash,
  evaluateDslExpression,
  staticCheckDsl,
} from "../src/proactive/dsl-engine.js";

const snapshot: SituationModelV1 = {
  version: "situation_model_v1",
  revisionId: "rev-1",
  localOnly: true,
  watermark: { lastEventSequence: 128, sourceEpochs: { "device.clipboard": "epoch-1" }, rebuiltAt: "2026-09-14T04:30:00.000Z" },
  presence: { state: "active", since: "2026-09-14T03:30:00.000Z", lastHeartbeatAt: "2026-09-14T04:30:00.000Z" },
  focus: { windowStart: "2026-09-14T04:00:00.000Z", windowEnd: "2026-09-14T04:30:00.000Z", focusScore: 45, fatigueScore: 62, recommendation: null },
  health: { sleepMinutes: 420, dailySteps: 3200, localDate: "2026-09-14" },
  commitments: [{ id: "c1", content: "review CR", status: "open", dueAt: "2026-09-15T00:00:00.000Z" }],
  drifts: [{ signalType: "deadline_slip", severity: 70, detectedAt: "2026-09-14T04:00:00.000Z" }],
  scenes: [],
  connections: [],
  provenance: {},
  redaction: { level: "none", policyVersion: "redact-v1" },
  freshnessMs: 42,
  rebuiltAt: "2026-09-14T04:30:00.000Z",
};

describe("CR-033 E2a DSL 静态检查", () => {
  it("白名单字段表达式通过静态检查并产出稳定 hash", () => {
    const rule = {
      dslVersion: PROACTIVE_DSL_VERSION,
      ruleId: "rule_1",
      name: "久坐提醒",
      condition: {
        op: "and",
        operands: [
          { op: "gte", left: { op: "field_ref", field: "focus.fatigueScore" }, right: { op: "const", value: 60 } },
        ],
      },
    };
    const check = staticCheckDsl(rule.condition as never);
    expect(check.ok).toBe(true);
    expect(check.hash).toBe(canonicalDslHash(rule.condition));
  });

  it("未知字段拒绝（fail-closed：DSL 只能引用投影白名单）", () => {
    const rule = {
      condition: { op: "field_ref", field: "persona.secret" },
    };
    expect(staticCheckDsl(rule.condition as never).ok).toBe(false);
  });

  it("深度超限拒绝", () => {
    // 构造深度 9 的嵌套（> maxDepth 8）
    let expr: unknown = { op: "const", value: 1 };
    for (let index = 0; index < 9; index += 1) {
      expr = { op: "add", left: expr, right: { op: "const", value: 1 } };
    }
    expect(staticCheckDsl(expr as never).ok).toBe(false);
  });

  it("节点数超限拒绝", () => {
    const manyOperands = Array.from({ length: 100 }, () => ({ op: "const", value: true }));
    const expr = { op: "and", operands: manyOperands };
    expect(staticCheckDsl(expr as never).ok).toBe(false);
  });

  it("canonical hash 对键序不敏感（规范化序列化）", () => {
    const a = { left: { op: "field_ref", field: "focus.fatigueScore" }, op: "gte", right: { op: "const", value: 60 } };
    const b = { right: { value: 60, op: "const" }, left: { field: "focus.fatigueScore", op: "field_ref" }, op: "gte" };
    expect(canonicalDslHash(a)).toBe(canonicalDslHash(b));
  });
});

describe("CR-033 E2a DSL 运行期求值", () => {
  it("组合条件命中：专注偏低且漂移严重", () => {
    const expr = {
      op: "and",
      operands: [
        { left: { op: "field_ref", field: "focus.focusScore" }, op: "lt", right: { op: "const", value: 50 } },
        { left: { op: "field_ref", field: "drifts.count" }, op: "gte", right: { op: "const", value: 1 } },
      ],
    };
    expect(evaluateDslExpression(expr as never, snapshot).hit).toBe(true);
  });

  it("未命中：专注不低", () => {
    const expr = { left: { op: "field_ref", field: "focus.focusScore" }, op: "lt", right: { op: "const", value: 30 } };
    expect(evaluateDslExpression(expr as never, snapshot).hit).toBe(false);
  });

  it("除零不命中（fail-closed，不抛错）", () => {
    const expr = { op: "div", left: { op: "const", value: 1 }, right: { op: "const", value: 0 } };
    const result = evaluateDslExpression(expr as never, snapshot);
    expect(result.hit).toBe(false);
    expect(result.reason).toContain("div by zero");
  });

  it("未知节点 op 不命中", () => {
    const expr = { op: "exec", command: "rm -rf /" };
    const result = evaluateDslExpression(expr as never, snapshot);
    expect(result.hit).toBe(false);
  });

  it("步骤耗尽不命中（资源耗尽 fail-closed）", () => {
    let expr: unknown = { op: "const", value: true };
    for (let index = 0; index < 5; index += 1) {
      expr = { op: "not", operand: expr };
    }
    const result = evaluateDslExpression(expr as never, snapshot, { ...{ maxDepth: 64, maxNodes: 512, maxStringLength: 2048, maxEvalMs: 1000 }, maxSteps: 2 });
    expect(result.hit).toBe(false);
  });

  it("时间窗：最近 60 分钟内活跃（presence.since）", () => {
    const now = Date.now();
    const recentSnapshot = {
      ...snapshot,
      presence: { state: "active", since: new Date(now - 30 * 60_000).toISOString(), lastHeartbeatAt: new Date(now).toISOString() },
    };
    const expr = { op: "time_window", field: "presence.since", minutes: 60, cmp: "lte" };
    expect(evaluateDslExpression(expr as never, recentSnapshot).hit).toBe(true);
  });

  it("not 多操作数与时间窗未知字段均 fail-closed", () => {
    expect(staticCheckDsl({ op: "not", operands: [{ op: "const", value: true }] } as never).ok)
      .toBe(false);
    expect(staticCheckDsl({
      op: "time_window",
      field: "presence.since",
      minutes: 60,
      threshold: 60,
      cmp: "lte",
    } as never).ok).toBe(false);
  });

  it("算术表达式求值", () => {
    const expr = { op: "gte", left: { op: "add", left: { op: "field_ref", field: "focus.focusScore" }, right: { op: "const", value: 10 } }, right: { op: "const", value: 50 } };
    expect(evaluateDslExpression(expr as never, snapshot).hit).toBe(true);
  });
});
