/**
 * CR-033 F1 共享契约 fail-closed 测试。
 *
 * 规则依据：docs/reference/changes/CR-033-proactive-endgame-situation-core-and-budgeted-intervention.md
 * - P2 统一态势投影：白名单 schema、纯派生物可重建、规则与 LLM 的唯一视野；
 * - P1 感知事件化：envelope 幂等键/序列/digest/因果信息；
 * - 契约生成 JSON/OpenAPI schema，未知字段、未知版本与超限输入一律 fail-closed。
 */
import { describe, it, expect } from "vitest";
import {
  SITUATION_MODEL_VERSION,
  SITUATION_MODEL_MAX_BYTES,
  PERCEPTION_EVENT_VERSION,
  situationModelV1Schema,
  perceptionEventEnvelopeSchema,
  proactiveTurnContextSchema,
  assertSituationModelSize,
} from "../src/index.js";

const validPresence = {
  state: "active",
  since: "2026-09-14T04:00:00.000Z",
  lastHeartbeatAt: "2026-09-14T04:30:00.000Z",
};

const validWatermark = {
  lastEventSequence: 128,
  sourceEpochs: { "device.clipboard": "epoch-1" },
  rebuiltAt: "2026-09-14T04:30:00.000Z",
};

const validSituation = {
  version: SITUATION_MODEL_VERSION,
  revisionId: "rev-1",
  localOnly: true,
  watermark: validWatermark,
  presence: validPresence,
  focus: null,
  health: { sleepMinutes: 420, dailySteps: 3200, localDate: "2026-09-14" },
  commitments: [],
  drifts: [],
  scenes: [],
  connections: [],
  provenance: {
    presence: {
      sourceKey: "device.app_activity",
      observedAt: "2026-09-14T04:29:00.000Z",
    },
  },
  redaction: { level: "none", policyVersion: "redact-v1" },
  freshnessMs: 42,
  rebuiltAt: "2026-09-14T04:30:00.000Z",
};

describe("situation_model_v1 契约（CR-033 F1 / P2）", () => {
  it("合法投影通过解析", () => {
    const parsed = situationModelV1Schema.parse(validSituation);
    expect(parsed.version).toBe(SITUATION_MODEL_VERSION);
    expect(parsed.localOnly).toBe(true);
  });

  it("未知字段一律拒绝（fail-closed：白名单 schema 单点治权）", () => {
    expect(() =>
      situationModelV1Schema.parse({ ...validSituation, extraField: "unknown" }),
    ).toThrow();
  });

  it("版本不符拒绝（未知版本 fail-closed）", () => {
    expect(() => situationModelV1Schema.parse({ ...validSituation, version: "situation_model_v2" })).toThrow();
  });

  it("localOnly 语义：非 true 拒绝（感知与态势数据不出本机）", () => {
    expect(() => situationModelV1Schema.parse({ ...validSituation, localOnly: false })).toThrow();
  });

  it("投影序列化大小不得超过 SITUATION_MODEL_MAX_BYTES", () => {
    expect(() => assertSituationModelSize(validSituation)).not.toThrow();
    expect(() =>
      assertSituationModelSize({
        ...validSituation,
        commitments: [{ id: "x", content: "a".repeat(SITUATION_MODEL_MAX_BYTES), status: "open", dueAt: null }],
      }),
    ).toThrow();
  });
});

describe("感知事件 envelope 契约（CR-033 F1 / P1）", () => {
  const validEnvelope = {
    version: PERCEPTION_EVENT_VERSION,
    eventId: "evt-1",
    idempotencyKey: "idem-1",
    source: "device.clipboard",
    deviceId: "dev-1",
    activationEpoch: "epoch-1",
    sourceGrantId: "grant-1",
    occurredAt: "2026-09-14T04:29:30.000Z",
    ingestedAt: "2026-09-14T04:29:31.000Z",
    sequence: 7,
    payloadDigest: "sha256:abc",
    schemaVersion: PERCEPTION_EVENT_VERSION,
    payload: { text: "clip" },
  };

  it("合法 envelope 通过解析", () => {
    const parsed = perceptionEventEnvelopeSchema.parse(validEnvelope);
    expect(parsed.idempotencyKey).toBe("idem-1");
  });

  it("未知字段拒绝（envelope 也是白名单契约）", () => {
    expect(() => perceptionEventEnvelopeSchema.parse({ ...validEnvelope, extra: 1 })).toThrow();
  });

  it("schemaVersion 不符拒绝（未知版本 fail-closed）", () => {
    expect(() =>
      perceptionEventEnvelopeSchema.parse({ ...validEnvelope, schemaVersion: "perception_event_v9" }),
    ).toThrow();
  });

  it("source 不在 PROFILE_SOURCE_IDS 白名单拒绝", () => {
    expect(() => perceptionEventEnvelopeSchema.parse({ ...validEnvelope, source: "unknown.source" })).toThrow();
  });

  it("sequence 超限输入（负数）拒绝", () => {
    expect(() => perceptionEventEnvelopeSchema.parse({ ...validEnvelope, sequence: -1 })).toThrow();
  });
});

describe("ProactiveTurnContextPort 契约（CR-033 F1 / P5）", () => {
  const validContext = {
    version: "proactive_turn_context_v1",
    personaRevisionId: "persona-rev-1",
    personaId: "persona-1",
    personaSystemPrompt: "你是思隅，保持亲切、克制和安全。",
    allowedSkills: ["health-guard"],
    memoryReferences: [{ memoryId: "mem-1", scope: "context", policyVersion: "mem-v1" }],
    safety: { policyVersion: "safety-v1", classificationLevel: "normal" },
    untrustedPluginLayer: {
      pluginId: "health-guard",
      skillOverlayJson: "{}",
      personaOverlayEnabled: false,
    },
    localOnly: true,
  };

  it("合法上下文通过解析", () => {
    const parsed = proactiveTurnContextSchema.parse(validContext);
    expect(parsed.personaRevisionId).toBe("persona-rev-1");
  });

  it("未知字段拒绝（fail-closed）", () => {
    expect(() => proactiveTurnContextSchema.parse({ ...validContext, extra: 1 })).toThrow();
  });

  it("插件叠加层不得携带未声明字段（不可信场景叠加层白名单）", () => {
    expect(() =>
      proactiveTurnContextSchema.parse({
        ...validContext,
        untrustedPluginLayer: { ...validContext.untrustedPluginLayer, systemPromptOverride: "EVIL" },
      }),
    ).toThrow();
  });
});
