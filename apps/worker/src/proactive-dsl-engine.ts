/**
 * CR-033 E2a 受限 DSL 求值器。
 *
 * 规则依据：docs/reference/changes/CR-033-proactive-endgame-situation-core-and-budgeted-intervention.md
 * - 表达式只引用 situation_model_v1 白名单字段；纯函数；无 IO、无循环、无任意函数、无模型执行；
 * - 安装期静态检查：字段白名单、类型、深度、节点数、字符串长度、canonical hash；
 * - 运行期：超时、未知节点、除零、资源耗尽一律不命中（fail-closed）；
 * - 旧五类 triggerType 保留读取兼容层（evaluateTriggerRule 仍可用）。
 */
import { createHash } from "node:crypto";
import {
  isSituationDslField,
  normalizeDslAst,
  DSL_DEFAULT_QUOTAS,
  type DslExpression,
  type DslQuotas,
  type SituationModelV1,
} from "@aervox/contracts";

export interface DslStaticCheckResult {
  ok: boolean;
  reason?: string;
  nodeCount: number;
  depth: number;
  hash?: string;
}

export interface DslEvalResult {
  hit: boolean;
  reason?: string;
}

const MAX_NODES = DSL_DEFAULT_QUOTAS.maxNodes;
const MAX_DEPTH = DSL_DEFAULT_QUOTAS.maxDepth;
const MAX_EVAL_MS = DSL_DEFAULT_QUOTAS.maxEvalMs;
const MAX_STEPS = DSL_DEFAULT_QUOTAS.maxSteps;

/** 计算 canonical hash：规范化 AST → JSON → sha256。 */
export function canonicalDslHash(node: unknown): string {
  return createHash("sha256").update(JSON.stringify(normalizeDslAst(node))).digest("hex");
}

/** 递归统计节点数与深度。 */
function countAst(node: unknown, depth = 0): {nodes: number; depth: number} {
  if (node === null || typeof node !== "object") return {nodes: 1, depth};
  const children = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
  let nodes = 1;
  let maxDepth = depth;
  for (const child of children) {
    const sub = countAst(child, depth + 1);
    nodes += sub.nodes;
    maxDepth = Math.max(maxDepth, sub.depth);
  }
  return {nodes, depth: maxDepth};
}

/**
 * 安装期静态检查：字段白名单、类型（由 Zod 保证）、深度、节点数、字符串长度。
 * 返回 ok + canonical hash；任一超限即 fail-closed。
 */
export function staticCheckDsl(
  expression: DslExpression,
  quotas: DslQuotas = DSL_DEFAULT_QUOTAS,
): DslStaticCheckResult {
  const {nodes, depth} = countAst(expression);
  if (nodes > quotas.maxNodes || nodes > MAX_NODES) {
    return {ok: false, reason: `node count ${nodes} exceeds quota ${quotas.maxNodes}`, nodeCount: nodes, depth};
  }
  if (depth > quotas.maxDepth || depth > MAX_DEPTH) {
    return {ok: false, reason: `depth ${depth} exceeds quota ${quotas.maxDepth}`, nodeCount: nodes, depth};
  }
  // 字段白名单遍历：所有 field_ref 必须是投影白名单字段
  const fieldViolation = findUnknownField(expression);
  if (fieldViolation) {
    return {ok: false, reason: `unknown field: ${fieldViolation}`, nodeCount: nodes, depth};
  }
  const strViolation = findOversizedString(expression, quotas.maxStringLength);
  if (strViolation) {
    return {ok: false, reason: `string exceeds max length ${quotas.maxStringLength}`, nodeCount: nodes, depth};
  }
  return {ok: true, nodeCount: nodes, depth, hash: canonicalDslHash(expression)};
}

function findUnknownField(node: unknown): string | null {
  if (node === null || typeof node !== "object") return null;
  const record = node as Record<string, unknown>;
  if (record.op === "field_ref") {
    const field = record.field as string;
    if (!isSituationDslField(field)) return field;
    return null;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const result = findUnknownField(child);
      if (result) return result;
    }
    return null;
  }
  for (const value of Object.values(record)) {
    const result = findUnknownField(value);
    if (result) return result;
  }
  return null;
}

function findOversizedString(node: unknown, maxLen: number): boolean {
  if (typeof node === "string") return node.length > maxLen;
  if (node === null || typeof node !== "object") return false;
  const record = node as Record<string, unknown>;
  if (Array.isArray(node)) {
    return node.some((child) => findOversizedString(child, maxLen));
  }
  return Object.values(record).some((value) => findOversizedString(value, maxLen));
}

/** 从 situation_model_v1 投影解析白名单字段值。 */
function resolveField(snapshot: SituationModelV1, field: string): unknown {
  switch (field) {
    case "presence.state": return snapshot.presence?.state;
    case "presence.since": return snapshot.presence?.since;
    case "focus.focusScore": return snapshot.focus?.focusScore;
    case "focus.fatigueScore": return snapshot.focus?.fatigueScore;
    case "focus.windowEnd": return snapshot.focus?.windowEnd;
    case "commitments.count": return snapshot.commitments?.length ?? 0;
    case "drifts.count": return snapshot.drifts?.length ?? 0;
    case "scenes.count": return snapshot.scenes?.length ?? 0;
    case "connections.count": return snapshot.connections?.length ?? 0;
    case "freshnessMs": return snapshot.freshnessMs;
    default: return undefined; // fail-closed：未知字段未命中
  }
}

/**
 * 运行期求值：递归解释 AST，带步骤计数与超时。
 * 未知节点、未知字段、除零、超时、资源耗尽一律不命中（fail-closed）。
 */
export function evaluateDslExpression(
  expression: DslExpression,
  snapshot: SituationModelV1,
  quotas: DslQuotas = DSL_DEFAULT_QUOTAS,
): DslEvalResult {
  const startedAt = Date.now();
  let steps = 0;
  const deadline = quotas.maxEvalMs ?? MAX_EVAL_MS;
  const stepLimit = quotas.maxSteps ?? MAX_STEPS;

  const interpret = (node: unknown): unknown => {
    if (++steps > stepLimit) throw new DslFailClosed("step limit exceeded");
    if (Date.now() - startedAt > deadline) throw new DslFailClosed("eval timeout");
    if (node === null || typeof node !== "object") return node;
    const record = node as Record<string, unknown>;
    const op = record.op as string;
    switch (op) {
      case "const": return record.value;
      case "field_ref": {
        const value = resolveField(snapshot, record.field as string);
        if (value === undefined) throw new DslFailClosed(`unknown field: ${record.field}`);
        return value;
      }
      case "and": return (record.operands as unknown[]).every((child) => interpret(child) === true);
      case "or": return (record.operands as unknown[]).some((child) => interpret(child) === true);
      case "not": return interpret((record.operands as unknown[])[0]) !== true;
      case "eq": return interpret(record.left) === interpret(record.right);
      case "ne": return interpret(record.left) !== interpret(record.right);
      case "gt": return compare(record, (a, b) => a > b, interpret);
      case "gte": return compare(record, (a, b) => a >= b, interpret);
      case "lt": return compare(record, (a, b) => a < b, interpret);
      case "lte": return compare(record, (a, b) => a <= b, interpret);
      case "add": return arith(record, (a, b) => a + b, interpret);
      case "sub": return arith(record, (a, b) => a - b, interpret);
      case "mul": return arith(record, (a, b) => a * b, interpret);
      case "div": {
        const left = interpret(record.left) as number;
        const right = interpret(record.right) as number;
        if (typeof left !== "number" || typeof right !== "number" || right === 0) {
          throw new DslFailClosed("div by zero or non-number");
        }
        return left / right;
      }
      case "time_window": return evalTimeWindow(record, snapshot, startedAt);
      default: throw new DslFailClosed(`unknown node op: ${String(op)}`);
    }
  };

  try {
    return {hit: interpret(expression) === true, reason: undefined};
  } catch (error) {
    return {hit: false, reason: error instanceof DslFailClosed ? error.message : "eval failed closed"};
  }
}

class DslFailClosed extends Error {}

function compare(
  record: Record<string, unknown>,
  predicate: (a: number, b: number) => boolean,
  interpret: (node: unknown) => unknown,
): boolean {
  const left = interpret(record.left);
  const right = interpret(record.right);
  if (typeof left === "number" && typeof right === "number") {
    return predicate(left, right);
  }
  throw new DslFailClosed("compare requires numbers");
}

function arith(
  record: Record<string, unknown>,
  fn: (a: number, b: number) => number,
  interpret: (node: unknown) => unknown,
): number {
  const left = interpret(record.left);
  const right = interpret(record.right);
  if (typeof left !== "number" || typeof right !== "number") {
    throw new DslFailClosed("arithmetic requires numbers");
  }
  const result = fn(left, right);
  if (!Number.isFinite(result)) throw new DslFailClosed("non-finite result");
  return result;
}

function evalTimeWindow(
  record: Record<string, unknown>,
  snapshot: SituationModelV1,
  nowMs: number,
): boolean {
  const field = record.field as string;
  const threshold = record.threshold as number;
  const cmp = record.cmp as string;
  const raw = resolveField(snapshot, field);
  if (raw === undefined) throw new DslFailClosed(`unknown field in time_window: ${field}`);
  // 时间窗：解析 occurredAt/since 为分钟差，再与阈值比较
  const timestamp = rawToTimestampMs(raw, nowMs);
  if (timestamp === null) throw new DslFailClosed(`time_window field not a timestamp: ${field}`);
  const diffMinutes = (nowMs - timestamp) / 60_000;
  switch (cmp) {
    case "lt": return diffMinutes < threshold;
    case "lte": return diffMinutes <= threshold;
    case "gt": return diffMinutes > threshold;
    case "gte": return diffMinutes >= threshold;
    default: throw new DslFailClosed(`time_window unsupported cmp: ${cmp}`);
  }
}

function rawToTimestampMs(raw: unknown, nowMs: number): number | null {
  if (typeof raw === "number") return nowMs - raw * 60_000; // 分钟数
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}