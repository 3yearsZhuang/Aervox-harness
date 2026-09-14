/**
 * Aervox｜思隅 @aervox/api — CR-034/CR-042 模型路由与降级阶梯服务测试
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@libsql/client";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteLLMConfigRepository,
  SqliteModelRoutingRepository,
  type AervoxDatabase,
} from "@aervox/repositories";
import { LlmDegradationService } from "../src/modules/llm/degradation-service.js";
import { LlmHealthProber, type ProbeParams, type ProbeResult } from "../src/modules/llm/health-prober.js";

const tenant = { workspaceId: "local", subjectUserId: "user_test" };

describe("LlmDegradationService (CR-034 / CR-042)", () => {
  let db: AervoxDatabase;
  let client: Client;
  let llmRepo: SqliteLLMConfigRepository;
  let routingRepo: SqliteModelRoutingRepository;
  let prober: LlmHealthProber;
  let service: LlmDegradationService;

  beforeEach(async () => {
    const database = await createInMemoryDatabase();
    db = database.db;
    client = database.client;
    await initDatabaseSchema(client);
    llmRepo = new SqliteLLMConfigRepository(db);
    routingRepo = new SqliteModelRoutingRepository(db);
    prober = new LlmHealthProber();
    service = new LlmDegradationService(llmRepo, routingRepo, {
      prober,
      policy: {
        probeIntervalMs: 0, // 测试期间不节流
        failureThreshold: 2,
        successThreshold: 2,
      },
    });
  });

  it("L0 云端模型正常健康时返回 L0 全能力快照", async () => {
    // 建立云端预设（激活）
    await llmRepo.createPreset(tenant, "Cloud DeepSeek", {
      enabled: true,
      providerType: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-test",
      modelId: "deepseek-chat",
      temperature: 0.7,
    });

    vi.spyOn(prober, "probe").mockResolvedValue({
      ok: true,
      status: "healthy",
      latencyMs: 80,
      errorCategory: null,
      errorMessage: null,
    });

    const snapshot = await service.getRoutingSnapshot({ tenant, sessionId: "sess_1" });
    expect(snapshot.tier).toBe("L0");
    expect(snapshot.capabilityTier).toBe("full");
    expect(snapshot.isLocal).toBe(false);
    expect(snapshot.modelId).toBe("deepseek-chat");
    expect(snapshot.reason).toBe("active_preset_healthy");
  });

  it("L0 连续失败达到阈值自动切至 L1 本地模型并保持会话粘滞", async () => {
    // 1. 创建云端预设与本地 Ollama 预设
    const cloud = await llmRepo.createPreset(tenant, "Cloud DeepSeek", {
      enabled: true,
      providerType: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-test",
      modelId: "deepseek-chat",
      temperature: 0.7,
    });
    const local = await llmRepo.createPreset(tenant, "Local Ollama", {
      enabled: true,
      providerType: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "llama3.2",
      temperature: 0.7,
    });
    await llmRepo.activatePreset(tenant, cloud.id);

    // Mock 探活：云端失败，本地成功
    vi.spyOn(prober, "probe").mockImplementation(async (params: ProbeParams): Promise<ProbeResult> => {
      if (params.baseUrl.includes("127.0.0.1")) {
        return { ok: true, status: "healthy", latencyMs: 15, errorCategory: null, errorMessage: null };
      }
      return { ok: false, status: "unavailable", latencyMs: 5000, errorCategory: "timeout", errorMessage: "timeout" };
    });

    // 第一次探测失败 (failureCount=1 < 2)
    const snap1 = await service.getRoutingSnapshot({ tenant, sessionId: "sess_sticky" });
    expect(snap1.tier).toBe("L0"); // 尚未达到 failureThreshold=2，仍为 L0

    // 第二次探测失败 (failureCount=2 >= 2)，触发切层到 L1
    const snap2 = await service.getRoutingSnapshot({ tenant, sessionId: "sess_sticky" });
    expect(snap2.tier).toBe("L1");
    expect(snap2.capabilityTier).toBe("restricted");
    expect(snap2.isLocal).toBe(true);
    expect(snap2.localAttestation).toBe(true);
    expect(snap2.modelId).toBe("llama3.2");

    // 验证会话粘滞：后续请求仍然处于 L1
    const snap3 = await service.getRoutingSnapshot({ tenant, sessionId: "sess_sticky" });
    expect(snap3.tier).toBe("L1");
    expect(snap3.stickySession).toBe(true);

    // 验证切层审计日志留痕
    const auditEvents = await routingRepo.listRoutingEvents();
    expect(auditEvents.length).toBeGreaterThanOrEqual(1);
    expect(auditEvents[0]?.fromTier).toBe("L0");
    expect(auditEvents[0]?.toTier).toBe("L1");
  });

  it("L0 恢复后且连续成功达到阈值在新回合完成恢复回切", async () => {
    const cloud = await llmRepo.createPreset(tenant, "Cloud DeepSeek", {
      enabled: true,
      providerType: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-test",
      modelId: "deepseek-chat",
      temperature: 0.7,
    });
    await llmRepo.createPreset(tenant, "Local Ollama", {
      enabled: true,
      providerType: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "llama3.2",
      temperature: 0.7,
    });
    await llmRepo.activatePreset(tenant, cloud.id);

    let cloudOk = false;
    vi.spyOn(prober, "probe").mockImplementation(async (params: ProbeParams): Promise<ProbeResult> => {
      if (params.baseUrl.includes("127.0.0.1")) {
        return { ok: true, status: "healthy", latencyMs: 15, errorCategory: null, errorMessage: null };
      }
      return cloudOk
        ? { ok: true, status: "healthy", latencyMs: 80, errorCategory: null, errorMessage: null }
        : { ok: false, status: "unavailable", latencyMs: 5000, errorCategory: "timeout", errorMessage: "timeout" };
    });

    // 连续两次失败，切入 L1
    await service.getRoutingSnapshot({ tenant, sessionId: "sess_recover" });
    const snapL1 = await service.getRoutingSnapshot({ tenant, sessionId: "sess_recover" });
    expect(snapL1.tier).toBe("L1");

    // 云端恢复，第一轮探测成功 (successCount=1 < successThreshold=2)，仍粘滞在 L1
    cloudOk = true;
    const snapStillL1 = await service.getRoutingSnapshot({ tenant, sessionId: "sess_recover" });
    expect(snapStillL1.tier).toBe("L1");

    // 第二轮探测成功 (successCount=2 >= successThreshold=2)，新回合回切到 L0
    const snapBackL0 = await service.getRoutingSnapshot({ tenant, sessionId: "sess_recover" });
    expect(snapBackL0.tier).toBe("L0");
    expect(snapBackL0.reason).toBe("l0_recovered_from_sticky_l1");
  });

  it("L0 与 L1 均不可用时安全降级到 L2 规则回应", async () => {
    await llmRepo.createPreset(tenant, "Cloud DeepSeek", {
      enabled: true,
      providerType: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      modelId: "deepseek-chat",
      temperature: 0.7,
    });
    await llmRepo.createPreset(tenant, "Local Ollama", {
      enabled: true,
      providerType: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "llama3.2",
      temperature: 0.7,
    });

    // 全部失败
    vi.spyOn(prober, "probe").mockResolvedValue({
      ok: false,
      status: "unavailable",
      latencyMs: 5000,
      errorCategory: "network_error",
      errorMessage: "Connection refused",
    });

    // 触发连续失败
    await service.getRoutingSnapshot({ tenant, sessionId: "sess_l2" });
    const snapshot = await service.getRoutingSnapshot({ tenant, sessionId: "sess_l2" });

    expect(snapshot.tier).toBe("L2");
    expect(snapshot.capabilityTier).toBe("minimal");
    expect(snapshot.presetId).toBeNull();
    expect(snapshot.reason).toContain("no_healthy_local_model");
  });

  it("requireLocalOnly 严格阻断出网，即使 L0 健康也仅走 L1 或 L2", async () => {
    await llmRepo.createPreset(tenant, "Cloud DeepSeek", {
      enabled: true,
      providerType: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      modelId: "deepseek-chat",
      temperature: 0.7,
    });
    await llmRepo.createPreset(tenant, "Local Ollama", {
      enabled: true,
      providerType: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "llama3.2",
      temperature: 0.7,
    });

    // 全部健康
    vi.spyOn(prober, "probe").mockResolvedValue({
      ok: true,
      status: "healthy",
      latencyMs: 50,
      errorCategory: null,
      errorMessage: null,
    });

    const snapshot = await service.getRoutingSnapshot({
      tenant,
      sessionId: "sess_local",
      requireLocalOnly: true,
    });

    expect(snapshot.tier).toBe("L1");
    expect(snapshot.isLocal).toBe(true);
    expect(snapshot.localAttestation).toBe(true);
    expect(snapshot.modelId).toBe("llama3.2");
  });

  it("用户手动锁定 manualLockTier 时直接锁定对应层级", async () => {
    await llmRepo.createPreset(tenant, "Cloud DeepSeek", {
      enabled: true,
      providerType: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      modelId: "deepseek-chat",
      temperature: 0.7,
    });

    service.updatePolicy({ manualLockTier: "L2" });
    const snapshot = await service.getRoutingSnapshot({ tenant, sessionId: "sess_lock" });
    expect(snapshot.tier).toBe("L2");
    expect(snapshot.capabilityTier).toBe("minimal");
    expect(snapshot.reason).toBe("manual_locked_l2");
  });

  it("Anthropic 协议预设自动拒绝并降级（fail-closed）", async () => {
    await llmRepo.createPreset(tenant, "Claude Anthropic", {
      enabled: true,
      providerType: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant",
      modelId: "claude-3-5-sonnet",
      temperature: 0.7,
    });

    const snapshot = await service.getRoutingSnapshot({ tenant, sessionId: "sess_anthropic" });
    // 由于无本地预设且 Anthropic 不支持，应触发连续失败降级至 L2
    await service.getRoutingSnapshot({ tenant, sessionId: "sess_anthropic" });
    const finalSnap = await service.getRoutingSnapshot({ tenant, sessionId: "sess_anthropic" });
    expect(finalSnap.tier).toBe("L2");
  });
});
