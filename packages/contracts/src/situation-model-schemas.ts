/**
 * CR-033 F1 共享契约：态势投影（situation_model_v1）与感知事件 envelope。
 *
 * 规则依据：docs/reference/changes/CR-033-proactive-endgame-situation-core-and-budgeted-intervention.md
 * - P2 统一态势投影：版本化白名单 schema，规则与 LLM 的唯一视野，纯派生物可重建；
 * - P1 感知事件化：envelope 携带幂等键、来源授权、occurredAt/ingestedAt、SQLite ingestion
 *   sequence、schema version、payload digest 与因果信息；
 * - 契约生成 JSON/OpenAPI schema，未知字段、未知版本与超限输入一律 fail-closed。
 */
import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { PROFILE_SOURCE_IDS } from "./proactive.js";

extendZodWithOpenApi(z);

/** situation_model_v1 契约版本（白名单 schema 的受治演进锚点）。 */
export const SITUATION_MODEL_VERSION = "situation_model_v1" as const;
export const SITUATION_MODEL_MAX_BYTES = 65_536;
export const SITUATION_MODEL_MAX_RECORD_BYTES = 4096;

/** 投影可重建 watermark：消费到的感知事件 SQLite ingestion sequence 上限。 */
export const situationModelWatermarkSchema = z.object({
  lastEventSequence: z.number().int().nonnegative(),
  sourceEpochs: z.record(z.string(), z.string().min(1)),
  rebuiltAt: z.string().datetime(),
});

/** 在场状态：连续活跃事件边沿聚合后的区间事实（保留 start/end/heartbeat 语义）。 */
export const situationPresenceSchema = z.object({
  state: z.enum(["active", "idle", "away", "unknown"]),
  since: z.string().datetime(),
  lastHeartbeatAt: z.string().datetime().nullable(),
});

/** 专注/疲劳水位：与 proactive_attention_states 窗口语义同构的投影裁剪。 */
export const situationFocusSchema = z.object({
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  focusScore: z.number().int().min(0).max(100),
  fatigueScore: z.number().int().min(0).max(100),
  recommendation: z.string().max(SITUATION_MODEL_MAX_RECORD_BYTES).nullable(),
});

/** 近期承诺：仅投影获准字段，原始承诺内容仍以 vault 各表为真源。 */
export const situationCommitmentSchema = z.object({
  id: z.string().min(1),
  content: z.string().max(SITUATION_MODEL_MAX_RECORD_BYTES),
  status: z.string().min(1),
  dueAt: z.string().datetime().nullable(),
});

/** 漂移概况：只投影 severity 与信号类型，不携带完整 expected/actual 载荷。 */
export const situationDriftSchema = z.object({
  signalType: z.string().min(1),
  severity: z.number().int().min(0).max(100),
  detectedAt: z.string().datetime(),
});

/** 当前场景：投影窗口场景快照摘要（含应用标识，不含 payload 原文）。 */
export const situationSceneSchema = z.object({
  sceneType: z.string().min(1),
  applicationId: z.string().nullable(),
  capturedAt: z.string().datetime(),
});

/** 外部连接状态：只投影 state 与最近同步时间，凭据/设置永不入投影。 */
export const situationConnectionStateSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  state: z.string().min(1),
  lastSyncAt: z.string().datetime().nullable(),
});

/** 字段级 provenance：投影字段的来源源键与捕获时间。 */
export const situationProvenanceSchema = z.object({
  sourceKey: z.enum(PROFILE_SOURCE_IDS),
  observedAt: z.string().datetime(),
  captureId: z.string().min(1).optional(),
  derivation: z.string().min(1).optional(),
});

/** redaction 策略：敏感字段在投影中的呈现方式。 */
export const situationRedactionSchema = z.object({
  level: z.enum(["none", "redacted", "omitted"]),
  policyVersion: z.string().min(1),
  reason: z.string().optional(),
});

/**
 * situation_model_v1 只读态势投影。
 *
 * fail-closed 边界：白名单字段；未知字段拒绝（.strict()）；超限输入拒绝；
 * 敏感内容只投影获准摘要，原始数据以 vault 各表为真源。
 */
export const situationModelV1Schema = z
  .object({
    version: z.literal(SITUATION_MODEL_VERSION),
    revisionId: z.string().min(1),
    localOnly: z.literal(true),
    watermark: situationModelWatermarkSchema,
    presence: situationPresenceSchema,
    focus: situationFocusSchema.nullable(),
    commitments: z.array(situationCommitmentSchema).max(64),
    drifts: z.array(situationDriftSchema).max(32),
    scenes: z.array(situationSceneSchema).max(8),
    connections: z.array(situationConnectionStateSchema).max(16),
    provenance: z.record(z.string(), situationProvenanceSchema),
    redaction: situationRedactionSchema,
    freshnessMs: z.number().int().nonnegative(),
    rebuiltAt: z.string().datetime(),
  })
  .strict();

/** 最大大小校验：投影序列化后不得超过 SITUATION_MODEL_MAX_BYTES。 */
const utf8ByteLength = (value: string): number => {
  const encoder = new TextEncoder();
  return encoder.encode(value).byteLength;
};

export function assertSituationModelSize(value: unknown): void {
  const bytes = utf8ByteLength(JSON.stringify(value));
  if (bytes > SITUATION_MODEL_MAX_BYTES) {
    throw new Error(
      `situation_model_v1 exceeds max size ${SITUATION_MODEL_MAX_BYTES} bytes (got ${bytes})`,
    );
  }
}

/** 感知事件 schema 版本（envelope 的受治演进锚点）。 */
export const PERCEPTION_EVENT_VERSION = "perception_event_v1" as const;

/** 感知事件 envelope：跨进程真源的统一信封（P1 感知事件化）。 */
export const perceptionEventEnvelopeSchema = z
  .object({
    version: z.literal(PERCEPTION_EVENT_VERSION),
    eventId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    source: z.enum(PROFILE_SOURCE_IDS),
    deviceId: z.string().min(1),
    activationEpoch: z.string().min(1),
    sourceGrantId: z.string().min(1),
    occurredAt: z.string().datetime(),
    ingestedAt: z.string().datetime(),
    sequence: z.number().int().nonnegative(),
    payloadDigest: z.string().min(1),
    schemaVersion: z.literal(PERCEPTION_EVENT_VERSION),
    payload: z.unknown(),
    causal: z
      .object({
        parentEventIds: z.array(z.string().min(1)).max(16).default([]),
        causeType: z.enum(["edge", "interval", "derived", "external"]).optional(),
      })
      .optional(),
  })
  .strict();

export type SituationModelV1 = z.infer<typeof situationModelV1Schema>;
export type PerceptionEventEnvelope = z.infer<typeof perceptionEventEnvelopeSchema>;
export type SituationProvenance = z.infer<typeof situationProvenanceSchema>;
export type SituationRedaction = z.infer<typeof situationRedactionSchema>;