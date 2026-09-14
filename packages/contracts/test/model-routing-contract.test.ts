/**
 * CR-034/CR-042 模型路由契约 fail-closed 单元测试。
 *
 * 规则依据：docs/reference/changes/CR-034-local-model-fallback-ladder.md
 * - 降级阶梯：L0 (full) -> L1 (restricted) -> L2 (minimal)
 * - 健康探测：unknown / healthy / degraded / unavailable
 * - 本地回环证明：isLiteralLoopbackUrl 严格防 SSRF / 出网漂移
 */
import { describe, expect, it } from "vitest";
import {
  capabilityTierSchema,
  healthSnapshotSchema,
  healthStatusSchema,
  isLiteralLoopbackUrl,
  mapTierToCapability,
  modelRoutingEventSchema,
  modelRoutingPolicySchema,
  modelRoutingSnapshotSchema,
  modelRoutingTierSchema,
  type HealthSnapshot,
  type ModelRoutingSnapshot,
} from "../src/index.js";

describe("CR-034 模型路由契约", () => {
  it("层级枚举 fail-closed 校验", () => {
    expect(modelRoutingTierSchema.parse("L0")).toBe("L0");
    expect(modelRoutingTierSchema.parse("L1")).toBe("L1");
    expect(modelRoutingTierSchema.parse("L2")).toBe("L2");
    expect(() => modelRoutingTierSchema.parse("L3")).toThrow();
    expect(() => modelRoutingTierSchema.parse("cloud")).toThrow();

    expect(capabilityTierSchema.parse("full")).toBe("full");
    expect(capabilityTierSchema.parse("restricted")).toBe("restricted");
    expect(capabilityTierSchema.parse("minimal")).toBe("minimal");
    expect(() => capabilityTierSchema.parse("partial")).toThrow();

    expect(healthStatusSchema.parse("healthy")).toBe("healthy");
    expect(healthStatusSchema.parse("degraded")).toBe("degraded");
    expect(healthStatusSchema.parse("unavailable")).toBe("unavailable");
    expect(healthStatusSchema.parse("unknown")).toBe("unknown");
    expect(() => healthStatusSchema.parse("offline")).toThrow();
  });

  it("mapTierToCapability 正确映射层级与能力等级", () => {
    expect(mapTierToCapability("L0")).toBe("full");
    expect(mapTierToCapability("L1")).toBe("restricted");
    expect(mapTierToCapability("L2")).toBe("minimal");
  });

  it("isLiteralLoopbackUrl 严格校验本机回环地址", () => {
    expect(isLiteralLoopbackUrl("http://localhost:11434/v1")).toBe(true);
    expect(isLiteralLoopbackUrl("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLiteralLoopbackUrl("http://[::1]:11434/v1")).toBe(true);

    // 非回环地址全部拒绝（fail-closed）
    expect(isLiteralLoopbackUrl("https://api.openai.com/v1")).toBe(false);
    expect(isLiteralLoopbackUrl("http://192.168.1.100:11434/v1")).toBe(false);
    expect(isLiteralLoopbackUrl("http://10.0.0.1:8000/v1")).toBe(false);
    expect(isLiteralLoopbackUrl("not-a-valid-url")).toBe(false);
  });

  it("HealthSnapshot 合法数据解析与非法校验", () => {
    const valid: HealthSnapshot = {
      presetId: "preset_ollama_1",
      providerType: "ollama",
      endpointIdentity: "127.0.0.1:11434",
      status: "healthy",
      consecutiveSuccesses: 3,
      consecutiveFailures: 0,
      latencyMs: 42,
      lastProbeAt: "2026-09-14T12:00:00.000Z",
      lastSuccessAt: "2026-09-14T12:00:00.000Z",
      lastFailureAt: null,
      errorCategory: null,
      errorMessage: null,
      cooldownUntil: null,
    };

    const parsed = healthSnapshotSchema.parse(valid);
    expect(parsed.status).toBe("healthy");
    expect(parsed.consecutiveSuccesses).toBe(3);

    // 负数延迟应失败
    expect(() => healthSnapshotSchema.parse({ ...valid, latencyMs: -1 })).toThrow();
    // 非法错误分类应失败
    expect(() => healthSnapshotSchema.parse({ ...valid, errorCategory: "random_error" })).toThrow();
  });

  it("ModelRoutingSnapshot 合法数据解析（L0/L1/L2）", () => {
    const l0Snapshot: ModelRoutingSnapshot = {
      tier: "L0",
      capabilityTier: "full",
      presetId: "preset_cloud_1",
      presetName: "DeepSeek 官方",
      providerType: "deepseek",
      modelId: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1",
      isLocal: false,
      localAttestation: false,
      reason: "active_preset_healthy",
      configRevision: "rev_1",
      healthRevision: "hrev_1",
      stickySession: false,
      evaluatedAt: "2026-09-14T12:00:00.000Z",
    };
    expect(modelRoutingSnapshotSchema.parse(l0Snapshot).tier).toBe("L0");

    const l2Snapshot: ModelRoutingSnapshot = {
      tier: "L2",
      capabilityTier: "minimal",
      presetId: null,
      presetName: null,
      providerType: null,
      modelId: null,
      baseUrl: null,
      isLocal: true,
      localAttestation: true,
      reason: "no_healthy_model_available",
      configRevision: "rev_1",
      healthRevision: "hrev_2",
      stickySession: true,
      evaluatedAt: "2026-09-14T12:00:05.000Z",
    };
    expect(modelRoutingSnapshotSchema.parse(l2Snapshot).capabilityTier).toBe("minimal");
  });

  it("ModelRoutingEvent 切层审计事件契约校验", () => {
    const event = {
      id: "ev_route_1",
      sessionId: "session_abc",
      turnId: "turn_xyz",
      fromTier: "L0",
      toTier: "L1",
      fromPresetId: "preset_cloud_1",
      toPresetId: "preset_ollama_1",
      reason: "l0_failure_consecutive_3",
      occurredAt: "2026-09-14T12:00:10.000Z",
    };
    expect(modelRoutingEventSchema.parse(event).fromTier).toBe("L0");
    expect(modelRoutingEventSchema.parse(event).toTier).toBe("L1");
  });

  it("ModelRoutingPolicy 默认值校验", () => {
    const policy = modelRoutingPolicySchema.parse({});
    expect(policy.probeIntervalMs).toBe(30_000);
    expect(policy.failureThreshold).toBe(3);
    expect(policy.successThreshold).toBe(2);
    expect(policy.probeTimeoutMs).toBe(5_000);
    expect(policy.manualLockTier).toBeNull();
    expect(policy.autoFallbackEnabled).toBe(true);
  });
});
