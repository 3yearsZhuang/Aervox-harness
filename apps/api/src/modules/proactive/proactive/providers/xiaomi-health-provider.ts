import { createHash } from "node:crypto";
import type {
  IntelligenceConnectionSecret,
  LocalContext,
} from "@aervox/repositories";
import { XiaomiHealthClient, type XiaomiHealthDailySample } from "../xiaomi-health-client.js";
import type {
  HealthMetricIntegrationProvider,
  ProactiveIntegrationContext,
} from "../integration-provider.js";

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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

export class XiaomiHealthIntegrationProvider implements HealthMetricIntegrationProvider {
  readonly providerId = "xiaomi_health";
  readonly displayName = "Xiaomi Health";
  readonly requiredSourceKey = "restricted.profile" as const;

  async sync(
    tenant: LocalContext,
    connectionId: string,
    ctx: ProactiveIntegrationContext,
    options?: { localDate?: string },
  ): Promise<{ synced: number; sample: XiaomiHealthDailySample }> {
    return this.syncDaily(tenant, connectionId, ctx, options?.localDate);
  }

  async syncDaily(
    tenant: LocalContext,
    connectionId: string,
    ctx: ProactiveIntegrationContext,
    localDate = new Date().toISOString().slice(0, 10),
  ): Promise<{ synced: number; sample: XiaomiHealthDailySample }> {
    try {
      return await this.syncXiaomiHealthUnchecked(tenant, connectionId, ctx, localDate);
    } catch (error) {
      await ctx.intelligenceRepo.updateConnectionState(tenant, connectionId, "error", {
        lastError: error instanceof Error ? error.message : "xiaomi_health_sync_failed",
      });
      throw error;
    }
  }

  private async syncXiaomiHealthUnchecked(
    tenant: LocalContext,
    connectionId: string,
    ctx: ProactiveIntegrationContext,
    localDate: string,
  ): Promise<{ synced: number; sample: XiaomiHealthDailySample }> {
    const source = await ctx.assertSourceActive(tenant, "restricted.profile");
    let connection = await ctx.requiredConnection(tenant, connectionId, this.providerId);
    let client = xiaomiClient(connection);
    let sample: XiaomiHealthDailySample;
    try {
      sample = await client.fetchDaily(localDate);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "xiaomi_health_http_401") throw error;
      const refreshed = await client.refreshAccessToken();
      await ctx.intelligenceRepo.upsertConnection(tenant, {
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
      connection = await ctx.requiredConnection(tenant, connectionId, this.providerId);
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
      await ctx.intelligenceRepo.upsertHealthSample(tenant, {
        id: stableId("health", `${connectionId}:${metric}:${sample.localDate}`),
        connectionId,
        metric,
        localDate: sample.localDate,
        value,
        unit,
        sensitivity,
        source: this.providerId,
        metadata: sample.metadata,
      });
      synced += 1;
    }
    if (synced > 0) {
      const checksum = createHash("sha256")
        .update(`${connectionId}:${sample.localDate}:${sample.steps ?? ""}:${sample.sleepMinutes ?? ""}:${sample.restingHeartRate ?? ""}`)
        .digest("hex");
      await ctx.intelligenceRepo.createTimelineEvent(tenant, {
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
    await ctx.intelligenceRepo.updateConnectionState(tenant, connectionId, "active", {
      lastSyncAt: new Date().toISOString(),
      lastError: null,
    });
    return { synced, sample };
  }
}
