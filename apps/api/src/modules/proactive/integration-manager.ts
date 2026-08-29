import { createHash } from "node:crypto";
import type {
  IntelligenceConnectionSecret,
  SqliteProactiveIntelligenceRepository,
  SqliteProactiveProfileRepository,
  TenantContext,
} from "@aervox/database";
import { HomeAssistantClient, type HomeAssistantEntityState } from "./home-assistant-client.js";
import { XiaomiHealthClient, type XiaomiHealthDailySample } from "./xiaomi-health-client.js";

const BACKGROUND_SYNC_MS = 15 * 60 * 1000;
const SENSITIVE_HOME_DOMAINS = new Set(["alarm_control_panel", "camera", "device_tracker", "lock", "person"]);

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function homeCredential(connection: IntelligenceConnectionSecret): string {
  const token = stringValue(connection.credential.accessToken);
  if (!token) throw new Error("home_assistant_access_token_missing");
  return token;
}

function xiaomiClient(connection: IntelligenceConnectionSecret): XiaomiHealthClient {
  const accessToken = stringValue(connection.credential.accessToken);
  if (!connection.endpoint || !accessToken) throw new Error("xiaomi_health_credentials_incomplete");
  return new XiaomiHealthClient({
    apiBaseUrl: connection.endpoint,
    accessToken,
    refreshToken: stringValue(connection.credential.refreshToken),
    tokenEndpoint: stringValue(connection.settings.tokenEndpoint),
    clientId: stringValue(connection.credential.clientId),
    clientSecret: stringValue(connection.credential.clientSecret),
    dailyPath: stringValue(connection.settings.dailyPath),
  });
}

function safeHomeState(state: HomeAssistantEntityState): Record<string, unknown> {
  const attributes = state.attributes ?? {};
  const safeAttributes = Object.fromEntries([
    "friendly_name",
    "device_class",
    "unit_of_measurement",
    "icon",
  ].flatMap((key) => attributes[key] === undefined ? [] : [[key, attributes[key]]]));
  return {
    state: state.state,
    attributes: safeAttributes,
    lastChanged: state.last_changed ?? null,
    lastUpdated: state.last_updated ?? null,
  };
}

function homeDomain(entityId: string): string {
  const [domain] = entityId.split(".", 1);
  if (!domain || !/^[a-z0-9_]+$/.test(domain)) throw new Error("invalid_home_assistant_entity_id");
  return domain;
}

export class ProactiveIntegrationManager {
  private readonly subscriptions = new Map<string, () => void>();
  private syncTimer?: ReturnType<typeof setInterval>;
  private syncRunning = false;

  constructor(
    private readonly intelligenceRepo: SqliteProactiveIntelligenceRepository,
    private readonly profileRepo: SqliteProactiveProfileRepository,
  ) {}

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

  async assertSourceActive(tenant: TenantContext, sourceKey: "device.sensors" | "restricted.profile") {
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
    return {revision: status.revision, grant};
  }

  async syncHomeAssistant(tenant: TenantContext, connectionId: string): Promise<{synced: number}> {
    await this.assertSourceActive(tenant, "device.sensors");
    const connection = await this.requiredConnection(tenant, connectionId, "home_assistant");
    if (!connection.endpoint) throw new Error("home_assistant_endpoint_missing");
    const client = new HomeAssistantClient({endpoint: connection.endpoint, accessToken: homeCredential(connection)});
    try {
      const states = await client.listStates();
      const existing = new Map((await this.intelligenceRepo.listHomeEntities(tenant, connectionId))
        .map((entity) => [entity.entityId, entity]));
      for (const state of states) {
        const domain = homeDomain(state.entity_id);
        const previous = existing.get(state.entity_id);
        await this.intelligenceRepo.upsertHomeEntity(tenant, {
          id: stableId("ha_entity", `${connectionId}:${state.entity_id}`),
          connectionId,
          entityId: state.entity_id,
          domain,
          displayName: stringValue(state.attributes?.friendly_name) ?? state.entity_id,
          deviceClass: stringValue(state.attributes?.device_class) ?? null,
          allowedOps: previous?.allowedOps ?? [],
          enabled: previous?.enabled ?? false,
          sensitive: previous?.sensitive ?? SENSITIVE_HOME_DOMAINS.has(domain),
          state: safeHomeState(state),
          lastSeenAt: state.last_updated ?? new Date().toISOString(),
        });
      }
      const now = new Date().toISOString();
      await this.intelligenceRepo.updateConnectionState(tenant, connectionId, "active", {lastSyncAt: now, lastError: null});
      if (booleanValue(connection.settings.subscriptionEnabled, true)) {
        this.stopConnection(connectionId);
        await this.ensureHomeSubscription(tenant, connectionId);
      }
      return {synced: states.length};
    } catch (error) {
      await this.intelligenceRepo.updateConnectionState(tenant, connectionId, "error", {
        lastError: error instanceof Error ? error.message : "home_assistant_sync_failed",
      });
      throw error;
    }
  }

  async syncXiaomiHealth(
    tenant: TenantContext,
    connectionId: string,
    localDate = new Date().toISOString().slice(0, 10),
  ): Promise<{synced: number; sample: XiaomiHealthDailySample}> {
    try {
      return await this.syncXiaomiHealthUnchecked(tenant, connectionId, localDate);
    } catch (error) {
      await this.intelligenceRepo.updateConnectionState(tenant, connectionId, "error", {
        lastError: error instanceof Error ? error.message : "xiaomi_health_sync_failed",
      });
      throw error;
    }
  }

  private async syncXiaomiHealthUnchecked(
    tenant: TenantContext,
    connectionId: string,
    localDate: string,
  ): Promise<{synced: number; sample: XiaomiHealthDailySample}> {
    const source = await this.assertSourceActive(tenant, "restricted.profile");
    let connection = await this.requiredConnection(tenant, connectionId, "xiaomi_health");
    let client = xiaomiClient(connection);
    let sample: XiaomiHealthDailySample;
    try {
      sample = await client.fetchDaily(localDate);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "xiaomi_health_http_401") throw error;
      const refreshed = await client.refreshAccessToken();
      await this.intelligenceRepo.upsertConnection(tenant, {
        id: connection.id,
        revisionId: connection.revisionId,
        provider: connection.provider,
        displayName: connection.displayName,
        endpoint: connection.endpoint,
        authType: connection.authType,
        scopes: connection.scopes,
        settings: connection.settings,
        state: "active",
        credential: {
          ...connection.credential,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? connection.credential.refreshToken,
        },
      });
      connection = await this.requiredConnection(tenant, connectionId, "xiaomi_health");
      client = xiaomiClient(connection);
      sample = await client.fetchDaily(localDate);
    }

    const metrics = [
      ["steps", sample.steps, "count", "low"],
      ["sleep_minutes", sample.sleepMinutes, "minute", "high"],
      ["resting_heart_rate", sample.restingHeartRate, "bpm", "high"],
    ] as const;
    let synced = 0;
    for (const [metric, value, unit, sensitivity] of metrics) {
      if (value === undefined) continue;
      await this.intelligenceRepo.upsertHealthSample(tenant, {
        id: stableId("health", `${connectionId}:${metric}:${sample.localDate}`),
        connectionId,
        metric,
        localDate: sample.localDate,
        value,
        unit,
        sensitivity,
        source: "xiaomi_health",
        metadata: sample.metadata,
      });
      synced += 1;
    }
    if (synced > 0) {
      const checksum = createHash("sha256")
        .update(`${connectionId}:${sample.localDate}:${sample.steps ?? ""}:${sample.sleepMinutes ?? ""}:${sample.restingHeartRate ?? ""}`)
        .digest("hex");
      await this.intelligenceRepo.createTimelineEvent(tenant, {
        id: stableId("timeline_health", checksum),
        revisionId: source.revision.id,
        sourceGrantId: source.grant.id,
        sourceKey: "restricted.profile",
        eventType: "health.daily_summary",
        subjectKey: sample.localDate,
        title: "Daily health summary",
        summary: null,
        payload: {
          steps: sample.steps ?? null,
          sleepMinutes: sample.sleepMinutes ?? null,
          restingHeartRate: sample.restingHeartRate ?? null,
        },
        privacyClass: "restricted",
        projectId: null,
        relationshipId: null,
        checksum,
        occurredAt: new Date().toISOString(),
      });
    }
    await this.intelligenceRepo.updateConnectionState(tenant, connectionId, "active", {
      lastSyncAt: new Date().toISOString(),
      lastError: null,
    });
    return {synced, sample};
  }

  async getHomeAssistantState(tenant: TenantContext, connectionId: string, entityId: string) {
    await this.assertSourceActive(tenant, "device.sensors");
    const entity = await this.intelligenceRepo.getHomeEntity(tenant, connectionId, entityId);
    if (!entity?.enabled) throw new Error("home_assistant_entity_not_authorized");
    const connection = await this.requiredConnection(tenant, connectionId, "home_assistant");
    if (!connection.endpoint) throw new Error("home_assistant_endpoint_missing");
    const client = new HomeAssistantClient({endpoint: connection.endpoint, accessToken: homeCredential(connection)});
    const state = await client.getState(entityId);
    const safeState = safeHomeState(state);
    await this.intelligenceRepo.upsertHomeEntity(tenant, {
      id: entity.id,
      connectionId,
      entityId,
      domain: entity.domain,
      displayName: entity.displayName,
      deviceClass: entity.deviceClass,
      allowedOps: entity.allowedOps,
      enabled: true,
      sensitive: entity.sensitive,
      state: safeState,
      lastSeenAt: state.last_updated ?? new Date().toISOString(),
    });
    return {entityId, domain: entity.domain, ...safeState};
  }

  async callHomeAssistantService(
    tenant: TenantContext,
    connectionId: string,
    entityId: string,
    service: string,
    data: Record<string, unknown> = {},
  ): Promise<unknown> {
    await this.assertSourceActive(tenant, "device.sensors");
    if (!/^[a-z0-9_]+$/.test(service)) throw new Error("invalid_home_assistant_service");
    const entity = await this.intelligenceRepo.getHomeEntity(tenant, connectionId, entityId);
    if (!entity?.enabled) throw new Error("home_assistant_entity_not_authorized");
    if (!entity.allowedOps.includes(service) && !entity.allowedOps.includes(`${entity.domain}.${service}`)) {
      throw new Error("home_assistant_service_not_authorized");
    }
    const connection = await this.requiredConnection(tenant, connectionId, "home_assistant");
    if (!connection.endpoint) throw new Error("home_assistant_endpoint_missing");
    const client = new HomeAssistantClient({endpoint: connection.endpoint, accessToken: homeCredential(connection)});
    return client.callService(entity.domain, service, {...data, entity_id: entityId});
  }

  async ensureHomeSubscription(tenant: TenantContext, connectionId: string): Promise<void> {
    if (this.subscriptions.has(connectionId)) return;
    await this.assertSourceActive(tenant, "device.sensors");
    const connection = await this.requiredConnection(tenant, connectionId, "home_assistant");
    if (!connection.endpoint || !booleanValue(connection.settings.subscriptionEnabled, true)) return;
    const client = new HomeAssistantClient({endpoint: connection.endpoint, accessToken: homeCredential(connection)});
    const close = await client.subscribeStateChanges((event) => {
      void this.consumeHomeEvent(tenant, connection, event).catch(() => undefined);
    });
    this.subscriptions.set(connectionId, close);
  }

  private async consumeHomeEvent(
    tenant: TenantContext,
    connection: IntelligenceConnectionSecret,
    event: unknown,
  ): Promise<void> {
    if (!event || typeof event !== "object") return;
    const eventRecord = event as Record<string, unknown>;
    if (eventRecord.event_type !== "state_changed" || !eventRecord.data || typeof eventRecord.data !== "object") return;
    const data = eventRecord.data as Record<string, unknown>;
    const entityId = stringValue(data.entity_id);
    const newState = data.new_state;
    if (!entityId || !newState || typeof newState !== "object") return;
    const entity = await this.intelligenceRepo.getHomeEntity(tenant, connection.id, entityId);
    if (!entity?.enabled) return;
    const source = await this.assertSourceActive(tenant, "device.sensors");
    const state = newState as HomeAssistantEntityState;
    const safeState = safeHomeState(state);
    await this.intelligenceRepo.upsertHomeEntity(tenant, {
      id: entity.id,
      connectionId: connection.id,
      entityId,
      domain: entity.domain,
      displayName: entity.displayName,
      deviceClass: entity.deviceClass,
      allowedOps: entity.allowedOps,
      enabled: true,
      sensitive: entity.sensitive,
      state: safeState,
      lastSeenAt: state.last_updated ?? stringValue(eventRecord.time_fired) ?? new Date().toISOString(),
    });
    const occurredAt = stringValue(eventRecord.time_fired) ?? state.last_updated ?? new Date().toISOString();
    const checksum = createHash("sha256").update(`${connection.id}:${entityId}:${state.state}:${occurredAt}`).digest("hex");
    await this.intelligenceRepo.createTimelineEvent(tenant, {
      id: stableId("timeline_ha", checksum),
      revisionId: source.revision.id,
      sourceGrantId: source.grant.id,
      sourceKey: "device.sensors",
      eventType: "home.state_changed",
      subjectKey: entityId,
      title: entity.displayName ?? entityId,
      summary: `State changed to ${state.state}`,
      payload: safeState,
      privacyClass: entity.sensitive ? "restricted" : "private",
      projectId: null,
      relationshipId: null,
      checksum,
      occurredAt,
    });
  }

  private async syncAll(): Promise<void> {
    if (this.syncRunning) return;
    this.syncRunning = true;
    try {
      const connections = await this.intelligenceRepo.listActiveConnectionSecrets();
      for (const connection of connections) {
        const tenant = {workspaceId: connection.workspaceId, subjectUserId: connection.subjectUserId};
        try {
          if (connection.provider === "home_assistant") {
            await this.syncHomeAssistant(tenant, connection.id);
          } else if (connection.provider === "xiaomi_health") {
            await this.syncXiaomiHealth(tenant, connection.id);
          }
        } catch {
          // Per-connection state is persisted by the sync path. One failed integration must not block others.
        }
      }
    } finally {
      this.syncRunning = false;
    }
  }

  private async requiredConnection(tenant: TenantContext, id: string, provider: string) {
    const connection = await this.intelligenceRepo.getConnectionSecret(tenant, id);
    if (!connection || connection.provider !== provider) throw new Error(`${provider}_connection_not_found`);
    if (connection.state === "revoked") throw new Error(`${provider}_connection_revoked`);
    return connection;
  }
}
