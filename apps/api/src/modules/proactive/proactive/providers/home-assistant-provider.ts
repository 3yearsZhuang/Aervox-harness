import { createHash } from "node:crypto";
import type {
  IntelligenceConnectionSecret,
  LocalContext,
} from "@aervox/repositories";
import { HomeAssistantClient, type HomeAssistantEntityState } from "../home-assistant-client.js";
import type {
  DeviceSensorIntegrationProvider,
  ProactiveIntegrationContext,
} from "../integration-provider.js";

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

export class HomeAssistantIntegrationProvider implements DeviceSensorIntegrationProvider {
  readonly providerId = "home_assistant";
  readonly displayName = "Home Assistant";
  readonly requiredSourceKey = "device.sensors" as const;

  async sync(
    tenant: LocalContext,
    connectionId: string,
    ctx: ProactiveIntegrationContext,
  ): Promise<{ synced: number }> {
    await ctx.assertSourceActive(tenant, "device.sensors");
    const connection = await ctx.requiredConnection(tenant, connectionId, this.providerId);
    if (!connection.endpoint) throw new Error("home_assistant_endpoint_missing");
    const client = new HomeAssistantClient({ endpoint: connection.endpoint, accessToken: homeCredential(connection) });
    try {
      const states = await client.listStates();
      const existing = new Map((await ctx.intelligenceRepo.listHomeEntities(tenant, connectionId, undefined, 500))
        .map((entity) => [entity.entityId, entity]));
      for (const state of states) {
        const domain = homeDomain(state.entity_id);
        const previous = existing.get(state.entity_id);
        await ctx.intelligenceRepo.upsertHomeEntity(tenant, {
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
      await ctx.intelligenceRepo.updateConnectionState(tenant, connectionId, "active", { lastSyncAt: now, lastError: null });
      return { synced: states.length };
    } catch (error) {
      await ctx.intelligenceRepo.updateConnectionState(tenant, connectionId, "error", {
        lastError: error instanceof Error ? error.message : "home_assistant_sync_failed",
      });
      throw error;
    }
  }

  async getState(
    tenant: LocalContext,
    connectionId: string,
    entityId: string,
    ctx: ProactiveIntegrationContext,
  ): Promise<Record<string, unknown>> {
    await ctx.assertSourceActive(tenant, "device.sensors");
    const entity = await ctx.intelligenceRepo.getHomeEntity(tenant, connectionId, entityId);
    if (!entity?.enabled) throw new Error("home_assistant_entity_not_authorized");
    const connection = await ctx.requiredConnection(tenant, connectionId, this.providerId);
    if (!connection.endpoint) throw new Error("home_assistant_endpoint_missing");
    const client = new HomeAssistantClient({ endpoint: connection.endpoint, accessToken: homeCredential(connection) });
    const state = await client.getState(entityId);
    const safeState = safeHomeState(state);
    await ctx.intelligenceRepo.upsertHomeEntity(tenant, {
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
    return { entityId, domain: entity.domain, ...safeState };
  }

  async callService(
    tenant: LocalContext,
    connectionId: string,
    entityId: string,
    service: string,
    data: Record<string, unknown> = {},
    ctx: ProactiveIntegrationContext,
  ): Promise<unknown> {
    await ctx.assertSourceActive(tenant, "device.sensors");
    if (!/^[a-z0-9_]+$/.test(service)) throw new Error("invalid_home_assistant_service");
    const entity = await ctx.intelligenceRepo.getHomeEntity(tenant, connectionId, entityId);
    if (!entity?.enabled) throw new Error("home_assistant_entity_not_authorized");
    if (!entity.allowedOps.includes(service) && !entity.allowedOps.includes(`${entity.domain}.${service}`)) {
      throw new Error("home_assistant_service_not_authorized");
    }
    const connection = await ctx.requiredConnection(tenant, connectionId, this.providerId);
    if (!connection.endpoint) throw new Error("home_assistant_endpoint_missing");
    const client = new HomeAssistantClient({ endpoint: connection.endpoint, accessToken: homeCredential(connection) });
    return client.callService(entity.domain, service, { ...data, entity_id: entityId });
  }

  async startSubscription(
    tenant: LocalContext,
    connectionId: string,
    ctx: ProactiveIntegrationContext,
  ): Promise<() => void> {
    await ctx.assertSourceActive(tenant, "device.sensors");
    const connection = await ctx.requiredConnection(tenant, connectionId, this.providerId);
    if (!connection.endpoint || !booleanValue(connection.settings.subscriptionEnabled, true)) {
      return () => undefined;
    }
    const client = new HomeAssistantClient({ endpoint: connection.endpoint, accessToken: homeCredential(connection) });
    const close = await client.subscribeStateChanges((event) => {
      void this.consumeHomeEvent(tenant, connection, event, ctx).catch(() => undefined);
    });
    return close;
  }

  private async consumeHomeEvent(
    tenant: LocalContext,
    connection: IntelligenceConnectionSecret,
    event: unknown,
    ctx: ProactiveIntegrationContext,
  ): Promise<void> {
    if (!event || typeof event !== "object") return;
    const eventRecord = event as Record<string, unknown>;
    if (eventRecord.event_type !== "state_changed" || !eventRecord.data || typeof eventRecord.data !== "object") return;
    const data = eventRecord.data as Record<string, unknown>;
    const entityId = stringValue(data.entity_id);
    const newState = data.new_state;
    if (!entityId || !newState || typeof newState !== "object") return;
    const entity = await ctx.intelligenceRepo.getHomeEntity(tenant, connection.id, entityId);
    if (!entity?.enabled) return;
    const source = await ctx.assertSourceActive(tenant, "device.sensors");
    const state = newState as HomeAssistantEntityState;
    const safeState = safeHomeState(state);
    await ctx.intelligenceRepo.upsertHomeEntity(tenant, {
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
    await ctx.intelligenceRepo.createTimelineEvent(tenant, {
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
}
