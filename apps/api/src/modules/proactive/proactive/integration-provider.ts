/**
 * Aervox｜思隅 @aervox/api — 主动智能外部集成 Provider SPI (CAP-034/035)
 *
 * 将具体硬件/外部云服务商（Home Assistant, 小米健康等）与核心调度器解耦。
 */
import type {
  IntelligenceConnectionSecret,
  LocalContext,
  SqliteProactiveIntelligenceRepository,
  SqliteProactiveProfileRepository,
} from "@aervox/repositories";

export interface ProactiveIntegrationContext {
  readonly intelligenceRepo: SqliteProactiveIntelligenceRepository;
  readonly profileRepo: SqliteProactiveProfileRepository;
  assertSourceActive(
    tenant: LocalContext,
    sourceKey: "device.sensors" | "restricted.profile",
  ): Promise<{
    revision: { id: string };
    grant: { id: string };
  }>;
  requiredConnection(
    tenant: LocalContext,
    id: string,
    provider: string,
  ): Promise<IntelligenceConnectionSecret>;
}

export interface ProactiveIntegrationProvider {
  /** 唯一提供商标识，如 'home_assistant', 'xiaomi_health' */
  readonly providerId: string;
  /** 人类可读显示名 */
  readonly displayName: string;
  /** 该提供商所需的基准权限来源类别 */
  readonly requiredSourceKey: "device.sensors" | "restricted.profile";

  /** 执行数据同步 */
  sync(
    tenant: LocalContext,
    connectionId: string,
    ctx: ProactiveIntegrationContext,
    options?: Record<string, unknown>,
  ): Promise<{ synced: number; [key: string]: unknown }>;

  /** 订阅实时事件（如 WebSocket / SSE），返回注销/断开函数 */
  startSubscription?(
    tenant: LocalContext,
    connectionId: string,
    ctx: ProactiveIntegrationContext,
  ): Promise<() => void>;
}

/** 智能家居 / 设备传感器类 Provider 专用扩展接口 */
export interface DeviceSensorIntegrationProvider extends ProactiveIntegrationProvider {
  readonly requiredSourceKey: "device.sensors";

  getState(
    tenant: LocalContext,
    connectionId: string,
    entityId: string,
    ctx: ProactiveIntegrationContext,
  ): Promise<Record<string, unknown>>;

  callService(
    tenant: LocalContext,
    connectionId: string,
    entityId: string,
    service: string,
    data: Record<string, unknown>,
    ctx: ProactiveIntegrationContext,
  ): Promise<unknown>;
}

/** 运动健康类 Provider 专用扩展接口 */
export interface HealthMetricIntegrationProvider extends ProactiveIntegrationProvider {
  readonly requiredSourceKey: "restricted.profile";

  syncDaily(
    tenant: LocalContext,
    connectionId: string,
    ctx: ProactiveIntegrationContext,
    localDate?: string,
  ): Promise<{ synced: number; sample: unknown }>;
}
