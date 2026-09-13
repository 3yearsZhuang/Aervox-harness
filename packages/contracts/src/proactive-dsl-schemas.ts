/**
 * CR-033 E2a 受限规则 DSL 契约。
 *
 * 规则依据：docs/reference/changes/CR-033-proactive-endgame-situation-core-and-budgeted-intervention.md
 * - P3 规则数据化：规则本体是一门极小的确定性表达式语言——只能引用态势投影白名单字段、
 *   纯函数、无 IO、无循环、无任意函数、无模型执行；
 * - 语言冻结在极小集合（比较、逻辑、算术、时间窗函数），刻意不提供图灵完备性；
 * - 安装期静态检查字段白名单、类型、语言版本、深度、节点数、字符串长度与规范化 hash；
 * - 运行期超时、未知节点和资源耗尽一律不命中（fail-closed）。
 */
import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

/** DSL 语言版本（受治演进锚点）。 */
export const PROACTIVE_DSL_VERSION = "proactive_dsl_v1" as const;

/** DSL 默认配额（安装期与运行期共用）。 */
export const DSL_DEFAULT_QUOTAS = {
  maxDepth: 8,
  maxNodes: 64,
  maxStringLength: 256,
  maxEvalMs: 50,
  maxSteps: 4096,
} as const;

/** 比较运算（确定性、纯函数）。 */
export const dslCompareOpSchema = z.enum(["eq", "ne", "gt", "gte", "lt", "lte"]);
/** 逻辑运算。 */
export const dslLogicOpSchema = z.enum(["and", "or", "not"]);
/** 算术运算（两元）。 */
export const dslArithmeticOpSchema = z.enum(["add", "sub", "mul", "div"]);

/** 时间窗函数：以分钟为单位的有界窗口判断（输入为投影字段值 + 窗口参数）。 */
export const dslTimeWindowSchema = z.object({
  op: z.literal("time_window"),
  field: z.string().min(1),
  /** 窗口分钟数（有界：1..10080 = 7 天） */
  minutes: z.number().int().min(1).max(10_080),
  /** 窗口内阈值比较 */
  threshold: z.number(),
  cmp: dslCompareOpSchema,
});

/** 算术节点（两元；除零在求值期不命中而非抛错）。 */
export const dslArithmeticNodeSchema = z.object({
  op: dslArithmeticOpSchema,
  left: z.lazy(() => dslExpressionSchema),
  right: z.lazy(() => dslExpressionSchema),
});

/** 逻辑节点（not 仅一元；and/or 为数组）。 */
export const dslLogicNodeSchema = z.object({
  op: dslLogicOpSchema,
  operands: z.array(z.lazy(() => dslExpressionSchema)).min(1).max(8),
});

/** 比较节点（两元）。 */
export const dslCompareNodeSchema = z.object({
  op: dslCompareOpSchema,
  left: z.lazy(() => dslExpressionSchema),
  right: z.lazy(() => dslExpressionSchema),
});

/** 字段引用：只允许引用 situation_model_v1 白名单字段（静态检查确保）。 */
export const dslFieldRefSchema = z.object({
  op: z.literal("field_ref"),
  field: z.string().regex(/^[a-z][a-zA-Z0-9_.]*$/),
});

/** 常量：数字/字符串/布尔。 */
export const dslConstSchema = z.object({
  op: z.literal("const"),
  value: z.union([z.number(), z.string().max(DSL_DEFAULT_QUOTAS.maxStringLength), z.boolean()]),
});

/** 表达式 AST（判别联合，递归）。 */
export const dslExpressionSchema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion("op", [
    dslFieldRefSchema,
    dslConstSchema,
    dslCompareNodeSchema,
    dslLogicNodeSchema,
    dslArithmeticNodeSchema,
    dslTimeWindowSchema,
  ]),
);

/** DSL 配额（安装期与运行期共用；超限 fail-closed）。 */
export const dslQuotasSchema = z.object({
  maxDepth: z.number().int().min(1).max(64).default(DSL_DEFAULT_QUOTAS.maxDepth),
  maxNodes: z.number().int().min(1).max(512).default(DSL_DEFAULT_QUOTAS.maxNodes),
  maxStringLength: z.number().int().min(1).max(2048).default(DSL_DEFAULT_QUOTAS.maxStringLength),
  maxEvalMs: z.number().int().min(1).max(1000).default(DSL_DEFAULT_QUOTAS.maxEvalMs),
  maxSteps: z.number().int().min(1).max(65_536).default(DSL_DEFAULT_QUOTAS.maxSteps),
});

/**
 * 数据化规则声明（CR-033 §6 内置/插件规则统一为数据）。
 *
 * - triggerType 保留旧五类读取兼容层（存量规则仍可读），DSL 规则以 condition 为准；
 * - hash = 规范化 AST 的 canonical hash（防篡改 + 可 diff）；
 * - action 描述只声明干预意图，执行权仍在内核。
 */
export const proactiveDslRuleSchema = z
  .object({
    dslVersion: z.literal(PROACTIVE_DSL_VERSION),
    ruleId: z.string().min(1),
    name: z.string().min(1).max(128),
    triggerType: z.enum(["system_state", "fatigue_high", "drift_high", "health_sleep_low", "commitment_due"]).optional(),
    condition: dslExpressionSchema,
    action: z.object({
      kind: z.enum(["plugin_dispatch", "internal"]),
      pluginId: z.string().min(1).optional(),
      presentation: z.string().min(1).optional(),
    }),
    quotas: dslQuotasSchema.optional(),
    hash: z.string().min(1).optional(),
  })
  .strict();

export type DslExpression = z.infer<typeof dslExpressionSchema>;
export type DslCompareOp = z.infer<typeof dslCompareOpSchema>;
export type DslLogicOp = z.infer<typeof dslLogicOpSchema>;
export type DslArithmeticOp = z.infer<typeof dslArithmeticOpSchema>;
export type DslQuotas = z.infer<typeof dslQuotasSchema>;
export type ProactiveDslRule = z.infer<typeof proactiveDslRuleSchema>;

/**
 * situation_model_v1 白名单字段（静态检查依据）。
 * 仅投影公开字段可被 DSL 引用；persona/safety/memory 走 ContextManifest 不在此列。
 */
export const SITUATION_DSL_FIELDS = [
  "presence.state",
  "presence.since",
  "focus.focusScore",
  "focus.fatigueScore",
  "focus.windowEnd",
  "commitments.count",
  "drifts.count",
  "scenes.count",
  "connections.count",
  "freshnessMs",
] as const;

export type SituationDslField = (typeof SITUATION_DSL_FIELDS)[number];

export function isSituationDslField(field: string): field is SituationDslField {
  return (SITUATION_DSL_FIELDS as readonly string[]).includes(field);
}

/** 规范化序列化：按节点 op 排序键，保证同一 AST 稳定 hash。 */
export function normalizeDslAst(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeDslAst);
  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => [key, normalizeDslAst(record[key])] as const);
    return Object.fromEntries(entries);
  }
  return node;
}