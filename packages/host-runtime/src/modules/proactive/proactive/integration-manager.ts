import type {
  IntelligenceConnectionSecret,
  SqliteProactiveIntelligenceRepository,
  SqliteProactiveProfileRepository,
  LocalContext,
} from "@aervox/repositories";
import type {
  DeviceSensorIntegrationProvider,
  ProactiveIntegrationContext,
  ProactiveIntegrationProvider,
} from "./integration-provider.js";
import { HomeAssistantIntegrationProvider } from "./providers/home-assistant-provider.js";
import { XiaomiHealthIntegrationProvider } from "./providers/xiaomi-health-provider.js";
import type { XiaomiHealthDailySample } from "./xiaomi-health-client.js";

export * from "./integration-provider.js";
export * from "./providers/home-assistant-provider.js";
export * from "./providers/xiaomi-health-provider.js";

const BACKGROUND_SYNC_MS = 15 * 60 * 1000;

export class ProactiveIntegrationManager {
  private readonly providers = new Map<string, ProactiveIntegrationProvider>();
  private readonly subscriptions = new Map<string, () => void>();
  private syncTimer?: ReturnType<typeof setInterval>;
  private syncRunning = false;

  constructor(
    private readonly intelligenceRepo: SqliteProactiveIntelligenceRepository,
    private readonly profileRepo: SqliteProactiveProfileRepository,
    initialProviders: ProactiveIntegrationProvider[] = [
      new HomeAssistantIntegrationProvider(),
      new XiaomiHealthIntegrationProvider(),
    ],
  ) {
    for (const provider of initialProviders) {
      this.registerProvider(provider);
    }
  }

  registerProvider(provider: ProactiveIntegrationProvider): void {
    this.providers.set(provider.providerId, provider);
  }

  getProvider<T extends ProactiveIntegrationProvider = ProactiveIntegrationProvider>(providerId: string): T | undefined {
    return this.providers.get(providerId) as T | undefined;
  }

  listProviders(): ProactiveIntegrationProvider[] {
    return [...this.providers.values()];
  }

  createContext(): ProactiveIntegrationContext {
    return {
      intelligenceRepo: this.intelligenceRepo,
      profileRepo: this.profileRepo,
      assertSourceActive: (tenant, sourceKey) => this.assertSourceActive(tenant, sourceKey),
      requiredConnection: (tenant, id, provider) => this.requiredConnection(tenant, id, provider),
    };
  }

  start(): void {
    void this.syncAll();
    this.syncTimer = setInterval(() => {
      void this.syncAll();
    }, BACKGROUND_SYNC_MS);
    this.syncTimer.unref?.();
  }

  stop(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = undefined;
    for (const close of this.subscriptions.values()) close();
    this.subscriptions.clear();
  }

  subscriptionActive(connectionId: string): boolean {
    return this.subscriptions.has(connectionId);
  }

  stopConnection(connectionId: string): void {
    this.subscriptions.get(connectionId)?.();
    this.subscriptions.delete(connectionId);
  }

  async assertSourceActive(tenant: LocalContext, sourceKey: "device.sensors" | "restricted.profile") {
    const status = await this.profileRepo.getEffectiveStatus(tenant);
    const grant = status.sources.find((item) => item.sourceKey === sourceKey);
    // 这两个来源没有 OS Provider，桌面 Host 永远无法上报 granted；外部连接
    // 本身就是用户对该来源的显式授权（连接需 active 模式 + 明文凭据，删除
    // 连接即撤权并清理缓存）。因此只要求主动智能整体处于 active，且用户未
    // 显式撤销/拒绝该来源；grant 行仍作为数据溯源引用返回。
    if (status.effectiveState !== "active" || !status.revision || !grant) {
      throw new Error(`proactive_source_not_active:${sourceKey}`);
    }
    if (grant.state === "revoked" || grant.state === "denied") {
      throw new Error(`proactive_source_not_active:${sourceKey}`);
    }
    return { revision: status.revision, grant };
  }

  async syncHomeAssistant(tenant: LocalContext, connectionId: string): Promise<{ synced: number }> {
    const provider = this.getProvider<HomeAssistantIntegrationProvider>("home_assistant");
    if (!provider) throw new Error("home_assistant_provider_not_found");
    const result = await provider.sync(tenant, connectionId, this.createContext());
    const connection = await this.requiredConnection(tenant, connectionId, "home_assistant");
    if (connection.settings.subscriptionEnabled !== false) {
      this.stopConnection(connectionId);
      await this.ensureHomeSubscription(tenant, connectionId);
    }
    return result;
  }

  async syncXiaomiHealth(
    tenant: LocalContext,
    connectionId: string,
    localDate = new Date().toISOString().slice(0, 10),
  ): Promise<{ synced: number; sample: XiaomiHealthDailySample }> {
    const provider = this.getProvider<XiaomiHealthIntegrationProvider>("xiaomi_health");
    if (!provider) throw new Error("xiaomi_health_provider_not_found");
    return provider.syncDaily(tenant, connectionId, this.createContext(), localDate);
  }

  async getHomeAssistantState(tenant: LocalContext, connectionId: string, entityId: string) {
    const provider = this.getProvider<DeviceSensorIntegrationProvider>("home_assistant");
    if (!provider) throw new Error("home_assistant_provider_not_found");
    return provider.getState(tenant, connectionId, entityId, this.createContext());
  }

  async callHomeAssistantService(
    tenant: LocalContext,
    connectionId: string,
    entityId: string,
    service: string,
    data: Record<string, unknown> = {},
  ): Promise<unknown> {
    const provider = this.getProvider<DeviceSensorIntegrationProvider>("home_assistant");
    if (!provider) throw new Error("home_assistant_provider_not_found");
    return provider.callService(tenant, connectionId, entityId, service, data, this.createContext());
  }

  async ensureHomeSubscription(tenant: LocalContext, connectionId: string): Promise<void> {
    await this.ensureSubscription(tenant, connectionId, "home_assistant");
  }

  async ensureSubscription(tenant: LocalContext, connectionId: string, providerId: string): Promise<void> {
    if (this.subscriptions.has(connectionId)) return;
    const provider = this.getProvider(providerId);
    if (!provider?.startSubscription) return;
    const close = await provider.startSubscription(tenant, connectionId, this.createContext());
    this.subscriptions.set(connectionId, close);
  }

  private async syncAll(): Promise<void> {
    if (this.syncRunning) return;
    this.syncRunning = true;
    try {
      const connections = await this.intelligenceRepo.listActiveConnectionSecrets(undefined, 500);
      const ctx = this.createContext();
      for (const connection of connections) {
        const tenant = { workspaceId: "local", subjectUserId: "local" };
        try {
          const provider = this.providers.get(connection.provider);
          if (provider) {
            await provider.sync(tenant, connection.id, ctx);
            if (provider.startSubscription && connection.settings.subscriptionEnabled !== false) {
              await this.ensureSubscription(tenant, connection.id, provider.providerId);
            }
          }
        } catch {
          // Per-connection state is persisted by the sync path. One failed integration must not block others.
        }
      }
    } finally {
      this.syncRunning = false;
    }
  }

  async requiredConnection(tenant: LocalContext, id: string, provider: string) {
    const connection = await this.intelligenceRepo.getConnectionSecret(tenant, id);
    if (!connection || connection.provider !== provider) throw new Error(`${provider}_connection_not_found`);
    if (connection.state === "revoked") throw new Error(`${provider}_connection_revoked`);
    return connection;
  }
}
