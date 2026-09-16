/**
 * CR-036 E1：把 CR-032 派生表归约为 situation_model_v1 影子投影。
 *
 * 该模块只读既有事实并生成可重建快照；不改变候选、裁决或派发行为。
 * legacy-shadow-v1 epoch 用于识别输入事实是否变化，避免 Worker 每个 tick 重复落快照。
 */
import { createHash } from "node:crypto";
import {
  SITUATION_MODEL_VERSION,
  situationModelV1Schema,
  type DslExpression,
  type ProfileSourceId,
  type SituationModelV1,
  type SituationProvenance,
} from "@aervox/contracts";
import type {
  LocalContext,
  SqliteProactiveSituationRepository,
} from "@aervox/repositories";
import { evaluateDslExpression, staticCheckDsl } from "./dsl-engine.js";

const LEGACY_SHADOW_EPOCH = "legacy-shadow-v1";

const digest = (value: unknown): string => createHash("sha256")
  .update(JSON.stringify(value))
  .digest("hex");

export interface LegacySituationProjectionInput {
  revisionId: string;
  now: Date;
  idleSamples: Array<{
    observedAt: string;
    idleSeconds: number;
    captureId?: string;
  }>;
  focus: {
    windowStart: string;
    windowEnd: string;
    focusScore: number;
    fatigueScore: number;
    recommendation?: string | null;
    updatedAt?: string;
  } | null;
  health: {
    sleepMinutes?: number;
    dailySteps?: number;
    localDate: string;
    observedAt?: string;
  };
  commitments: Array<{
    id: string;
    content: string;
    status: string;
    dueAt?: string | null;
    updatedAt?: string;
  }>;
  drifts: Array<{
    signalType: string;
    severity: number;
    detectedAt: string;
  }>;
  scenes: Array<{
    sceneType: string;
    applicationId?: string | null;
    capturedAt: string;
  }>;
  connections: Array<{
    id: string;
    provider: string;
    state: string;
    lastSyncAt?: string | null;
    updatedAt?: string;
  }>;
  /** E3 事件流切换后使用真实 ingestion sequence；缺省为 E1 legacy shadow 序列。 */
  eventWatermark?: {lastEventSequence: number; sourceEpochs: Record<string, string>};
}

export interface ShadowProjectionResult {
  snapshot: SituationModelV1;
  persisted: boolean;
  checksum: string;
  inputEpoch: string;
}

function classifyPresence(idleSeconds: number): SituationModelV1["presence"]["state"] {
  if (idleSeconds < 60) return "active";
  if (idleSeconds < 15 * 60) return "idle";
  return "away";
}

function derivePresence(
  samples: LegacySituationProjectionInput["idleSamples"],
  nowIso: string,
): SituationModelV1["presence"] {
  const ordered = [...samples].sort((left, right) => left.observedAt.localeCompare(right.observedAt));
  const latest = ordered.at(-1);
  if (!latest) return {state: "unknown", since: nowIso, lastHeartbeatAt: null};
  const state = classifyPresence(latest.idleSeconds);
  let since = latest.observedAt;
  for (let index = ordered.length - 2; index >= 0; index -= 1) {
    const sample = ordered[index]!;
    if (classifyPresence(sample.idleSeconds) !== state) break;
    since = sample.observedAt;
  }
  return {state, since, lastHeartbeatAt: latest.observedAt};
}

function provenance(
  sourceKey: ProfileSourceId,
  observedAt: string,
  derivation: string,
  captureId?: string,
): SituationProvenance {
  return {
    sourceKey,
    observedAt,
    ...(captureId ? {captureId} : {}),
    derivation,
  };
}

function latestTimestamp(values: Array<string | null | undefined>, fallback: string): string {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? fallback;
}

/** 纯函数：相同输入事实与 watermark 必须得到字节等价投影。 */
export function buildLegacySituationModel(
  input: LegacySituationProjectionInput,
  lastEventSequence: number,
): SituationModelV1 {
  const nowIso = input.now.toISOString();
  const latestIdle = [...input.idleSamples].sort((left, right) => left.observedAt.localeCompare(right.observedAt)).at(-1);
  const observedAt = latestTimestamp([
    latestIdle?.observedAt,
    input.focus?.updatedAt ?? input.focus?.windowEnd,
    input.health.observedAt,
    ...input.commitments.map((item) => item.updatedAt ?? item.dueAt),
    ...input.drifts.map((item) => item.detectedAt),
    ...input.scenes.map((item) => item.capturedAt),
    ...input.connections.map((item) => item.lastSyncAt ?? item.updatedAt),
  ], nowIso);
  const observedMs = Date.parse(observedAt);
  const freshnessMs = Number.isFinite(observedMs) ? Math.max(0, input.now.getTime() - observedMs) : 0;
  const sourceEpoch = legacyInputEpoch(input);
  const projectionProvenance: Record<string, SituationProvenance> = {};
  if (latestIdle) {
    projectionProvenance.presence = provenance(
      "system.idle_state",
      latestIdle.observedAt,
      "edge-classification-v1",
      latestIdle.captureId,
    );
  }
  if (input.focus) {
    projectionProvenance.focus = provenance(
      "aervox.activity",
      input.focus.updatedAt ?? input.focus.windowEnd,
      "attention-window-v1",
    );
  }
  if (input.health.observedAt) {
    projectionProvenance.health = provenance(
      "device.sensors",
      input.health.observedAt,
      "daily-health-summary-v1",
    );
  }
  if (input.commitments.length > 0) {
    projectionProvenance.commitments = provenance(
      "aervox.activity",
      latestTimestamp(input.commitments.map((item) => item.updatedAt ?? item.dueAt), nowIso),
      "near-term-commitments-v1",
    );
  }
  if (input.drifts.length > 0) {
    projectionProvenance.drifts = provenance(
      "aervox.activity",
      latestTimestamp(input.drifts.map((item) => item.detectedAt), nowIso),
      "project-drift-v1",
    );
  }
  if (input.scenes.length > 0) {
    projectionProvenance.scenes = provenance(
      "device.app_activity",
      latestTimestamp(input.scenes.map((item) => item.capturedAt), nowIso),
      "scene-summary-v1",
    );
  }
  if (input.connections.length > 0) {
    projectionProvenance.connections = provenance(
      "aervox.activity",
      latestTimestamp(input.connections.map((item) => item.lastSyncAt ?? item.updatedAt), nowIso),
      "connection-state-v1",
    );
  }

  return situationModelV1Schema.parse({
    version: SITUATION_MODEL_VERSION,
    revisionId: input.revisionId,
    localOnly: true,
    watermark: {
      lastEventSequence,
      sourceEpochs: input.eventWatermark?.sourceEpochs ?? {[LEGACY_SHADOW_EPOCH]: sourceEpoch},
      rebuiltAt: nowIso,
    },
    presence: derivePresence(input.idleSamples, nowIso),
    focus: input.focus ? {
      windowStart: input.focus.windowStart,
      windowEnd: input.focus.windowEnd,
      focusScore: input.focus.focusScore,
      fatigueScore: input.focus.fatigueScore,
      recommendation: input.focus.recommendation ?? null,
    } : null,
    health: {
      sleepMinutes: input.health.sleepMinutes ?? null,
      dailySteps: input.health.dailySteps ?? null,
      localDate: input.health.localDate,
    },
    commitments: input.commitments.slice(0, 64).map(({id, content, status, dueAt}) => ({
      id, content, status, dueAt: dueAt ?? null,
    })),
    drifts: input.drifts.slice(0, 32).map(({signalType, severity, detectedAt}) => ({
      signalType, severity, detectedAt,
    })),
    scenes: input.scenes.slice(0, 8).map(({sceneType, applicationId, capturedAt}) => ({
      sceneType, applicationId: applicationId ?? null, capturedAt,
    })),
    connections: input.connections.slice(0, 16).map(({id, provider, state, lastSyncAt}) => ({
      id, provider, state, lastSyncAt: lastSyncAt ?? null,
    })),
    provenance: projectionProvenance,
    redaction: {level: "redacted", policyVersion: "situation-redaction-v1"},
    freshnessMs,
    rebuiltAt: nowIso,
  });
}

/** 输入 epoch 不含时钟与 watermark；只有事实变化才推进影子序列。 */
export function legacyInputEpoch(input: LegacySituationProjectionInput): string {
  return digest({
    revisionId: input.revisionId,
    idleSamples: input.idleSamples,
    focus: input.focus,
    health: input.health,
    commitments: input.commitments,
    drifts: input.drifts,
    scenes: input.scenes,
    connections: input.connections,
  });
}

/** 仅在事实 epoch 变化时追加影子快照；E3 切换前序列只属于 legacy-shadow-v1。 */
export async function projectLegacySituationShadow(
  repo: SqliteProactiveSituationRepository,
  ctx: LocalContext,
  input: LegacySituationProjectionInput,
): Promise<ShadowProjectionResult> {
  const latest = await repo.getLatestSnapshot(ctx, input.revisionId);
  const inputEpoch = legacyInputEpoch(input);
  const nextSequence = input.eventWatermark?.lastEventSequence ?? (latest?.lastEventSequence ?? -1) + 1;
  const sameEventWatermark = input.eventWatermark !== undefined
    && latest !== null
    && latest.lastEventSequence >= input.eventWatermark.lastEventSequence;
  const snapshot = buildLegacySituationModel(
    input,
    sameEventWatermark || latest?.sourceEpochs[LEGACY_SHADOW_EPOCH] === inputEpoch
      ? latest.lastEventSequence
      : nextSequence,
  );
  const checksum = digest(snapshot);
  if (sameEventWatermark || latest?.sourceEpochs[LEGACY_SHADOW_EPOCH] === inputEpoch) {
    return {snapshot, persisted: false, checksum, inputEpoch};
  }
  await repo.saveSnapshot(ctx, {
    id: `situation_${input.revisionId}_${inputEpoch.slice(0, 20)}`,
    revisionId: input.revisionId,
    schemaVersion: SITUATION_MODEL_VERSION,
    snapshot,
    checksum,
    origin: "backfill",
    lastEventSequence: nextSequence,
    sourceEpochs: snapshot.watermark.sourceEpochs,
    rebuiltAt: snapshot.rebuiltAt,
    localOnly: true,
  });
  return {snapshot, persisted: true, checksum, inputEpoch};
}

export const BUILTIN_SITUATION_RULES: Readonly<Record<string, DslExpression>> = {
  commitment_due: {
    op: "gt",
    left: {op: "field_ref", field: "commitments.count"},
    right: {op: "const", value: 0},
  },
  fatigue_high: {
    op: "gte",
    left: {op: "field_ref", field: "focus.fatigueScore"},
    right: {op: "const", value: 70},
  },
  drift_high: {
    op: "gt",
    left: {op: "field_ref", field: "drifts.count"},
    right: {op: "const", value: 0},
  },
  health_sleep_low: {
    op: "lt",
    left: {op: "field_ref", field: "health.sleepMinutes"},
    right: {op: "const", value: 360},
  },
};

for (const [ruleId, expression] of Object.entries(BUILTIN_SITUATION_RULES)) {
  const check = staticCheckDsl(expression);
  if (!check.ok) throw new Error(`invalid built-in situation rule ${ruleId}: ${check.reason}`);
}

/** E1 双跑对照：只报告差异，CR-032 旧结果仍是派发真源。 */
export function compareBuiltInRuleParity(
  legacyHits: Readonly<Record<string, boolean>>,
  snapshot: SituationModelV1,
): string[] {
  const mismatches: string[] = [];
  for (const [ruleId, expression] of Object.entries(BUILTIN_SITUATION_RULES)) {
    const dslHit = evaluateDslExpression(expression, snapshot).hit;
    if (dslHit !== Boolean(legacyHits[ruleId])) mismatches.push(ruleId);
  }
  return mismatches;
}
