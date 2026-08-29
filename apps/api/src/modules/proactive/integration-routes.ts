import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  SqliteProactiveIntelligenceRepository,
  SqliteProactiveProfileRepository,
} from "@aervox/database";
import { resolveTenant } from "../../shared/tenant.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../shared/errors.js";
import { ProactiveActionAuthorizer } from "./action-authorizer.js";
import { HomeAssistantClient } from "./home-assistant-client.js";
import { ProactiveIntegrationManager } from "./integration-manager.js";
import { XiaomiHealthClient } from "./xiaomi-health-client.js";

let sequence = 0;
const nextId = (prefix: string): string => `${prefix}_${Date.now().toString(36)}_${(++sequence).toString(36)}`;

function bodyOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ValidationError(`${name} is required`);
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))]
    : [];
}

function inputRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mapIntegrationError(error: unknown): never {
  const message = error instanceof Error ? error.message : "integration_request_failed";
  if (message.includes("not_authorized") || message.includes("not_active") || message.includes("_revoked")) {
    throw new ForbiddenError(message);
  }
  if (message.includes("not_found")) throw new NotFoundError(message);
  throw new ValidationError(message);
}

export interface ProactiveIntegrationRouteDeps {
  intelligenceRepo: SqliteProactiveIntelligenceRepository;
  profileRepo: SqliteProactiveProfileRepository;
  actionAuthorizer: ProactiveActionAuthorizer;
  manager: ProactiveIntegrationManager;
}

async function authorizeHomeWrite(
  req: FastifyRequest,
  authorizer: ProactiveActionAuthorizer,
  args: unknown,
) {
  const authorization = await authorizer.authorize(resolveTenant(req), {
    turnId: `http:${req.id}`,
    attemptId: `http:${req.id}`,
    invocationId: `http:${req.id}`,
    toolId: "ha_call_service",
    toolName: "ha_call_service",
    category: "external",
    safetyLevel: "write_with_approval",
    requiredPermissions: ["action.external"],
    arguments: args,
  });
  if (!authorization.authorized) throw new ForbiddenError(authorization.reason);
  return authorization.action;
}

export function registerProactiveIntegrationRoutes(
  app: FastifyInstance,
  deps: ProactiveIntegrationRouteDeps,
): void {
  const repo = deps.intelligenceRepo;

  app.get("/v1/proactive/integrations", async (req) => {
    const items = await repo.listConnections(resolveTenant(req));
    return {items: items.map((item) => ({
      ...item,
      subscriptionActive: item.provider === "home_assistant" ? deps.manager.subscriptionActive(item.id) : undefined,
    }))};
  });

  app.post("/v1/proactive/integrations/home-assistant", async (req, reply) => {
    const body = bodyOf(req.body);
    const endpoint = requiredText(body.endpoint, "endpoint");
    const accessToken = requiredText(body.accessToken, "accessToken");
    const tenant = resolveTenant(req);
    const {revision} = await deps.manager.assertSourceActive(tenant, "device.sensors").catch(mapIntegrationError);
    const client = new HomeAssistantClient({endpoint, accessToken});
    const test = await client.testConnection().catch(mapIntegrationError);
    const id = optionalText(body.id) ?? nextId("conn_ha");
    await repo.upsertConnection(tenant, {
      id,
      revisionId: revision.id,
      provider: "home_assistant",
      displayName: optionalText(body.displayName) ?? "Home Assistant",
      endpoint,
      authType: "long_lived_access_token",
      credential: {accessToken},
      scopes: ["states.read", "services.call", "events.subscribe"],
      settings: {subscriptionEnabled: body.subscriptionEnabled !== false},
      state: "active",
      lastError: null,
    });
    const sync = await deps.manager.syncHomeAssistant(tenant, id).catch(mapIntegrationError);
    const requestedEntities = Array.isArray(body.entities) ? body.entities : [];
    for (const raw of requestedEntities) {
      const input = bodyOf(raw);
      const entityId = optionalText(input.entityId);
      if (!entityId) continue;
      const existing = await repo.getHomeEntity(tenant, id, entityId);
      if (!existing) continue;
      await repo.upsertHomeEntity(tenant, {
        ...existing,
        displayName: existing.displayName ?? entityId,
        connectionId: id,
        entityId,
        allowedOps: stringArray(input.allowedOps),
        enabled: input.enabled !== false,
        sensitive: typeof input.sensitive === "boolean" ? input.sensitive : existing.sensitive,
        lastSeenAt: existing.lastSeenAt ?? undefined,
      });
    }
    await deps.manager.ensureHomeSubscription(tenant, id).catch(mapIntegrationError);
    return reply.code(201).send({connection: (await repo.listConnections(tenant, "home_assistant")).find((item) => item.id === id), test, sync});
  });

  app.post("/v1/proactive/integrations/home-assistant/:id/test", async (req) => {
    const tenant = resolveTenant(req);
    await deps.manager.assertSourceActive(tenant, "device.sensors").catch(mapIntegrationError);
    const connection = await repo.getConnectionSecret(tenant, (req.params as {id: string}).id);
    if (!connection || connection.provider !== "home_assistant" || !connection.endpoint) throw new NotFoundError("home_assistant_connection_not_found");
    const accessToken = requiredText(connection.credential.accessToken, "accessToken");
    return new HomeAssistantClient({endpoint: connection.endpoint, accessToken}).testConnection().catch(mapIntegrationError);
  });

  app.post("/v1/proactive/integrations/home-assistant/:id/sync", async (req) => {
    return deps.manager.syncHomeAssistant(resolveTenant(req), (req.params as {id: string}).id).catch(mapIntegrationError);
  });

  app.get("/v1/proactive/integrations/home-assistant/:id/entities", async (req) => ({
    items: await repo.listHomeEntities(resolveTenant(req), (req.params as {id: string}).id),
  }));

  app.patch("/v1/proactive/integrations/home-assistant/:id/entities/:entityId", async (req) => {
    const {id, entityId} = req.params as {id: string; entityId: string};
    const tenant = resolveTenant(req);
    const body = bodyOf(req.body);
    const entity = await repo.getHomeEntity(tenant, id, entityId);
    if (!entity) throw new NotFoundError("home_assistant_entity_not_found");
    return repo.upsertHomeEntity(tenant, {
      ...entity,
      displayName: entity.displayName ?? entity.entityId,
      enabled: typeof body.enabled === "boolean" ? body.enabled : entity.enabled,
      sensitive: typeof body.sensitive === "boolean" ? body.sensitive : entity.sensitive,
      allowedOps: body.allowedOps === undefined ? entity.allowedOps : stringArray(body.allowedOps),
      lastSeenAt: entity.lastSeenAt ?? undefined,
    });
  });

  app.get("/v1/proactive/integrations/home-assistant/:id/entities/:entityId/state", async (req) => {
    const {id, entityId} = req.params as {id: string; entityId: string};
    return deps.manager.getHomeAssistantState(resolveTenant(req), id, entityId).catch(mapIntegrationError);
  });

  app.post("/v1/proactive/integrations/home-assistant/:id/call-service", async (req) => {
    const {id} = req.params as {id: string};
    const body = bodyOf(req.body);
    const entityId = requiredText(body.entityId, "entityId");
    const service = requiredText(body.service, "service");
    const data = inputRecord(body.data);
    const tenant = resolveTenant(req);
    const action = await authorizeHomeWrite(req, deps.actionAuthorizer, {connectionId: id, entityId, service, data});
    await deps.actionAuthorizer.markRunning(tenant, action.id);
    try {
      const result = await deps.manager.callHomeAssistantService(tenant, id, entityId, service, data);
      await deps.actionAuthorizer.markExecuted(tenant, action.id, {connectionId: id, entityId, service});
      return {ok: true, result};
    } catch (error) {
      await deps.actionAuthorizer.markFailed(tenant, action.id, error instanceof Error ? error.message : "home_assistant_call_failed");
      return mapIntegrationError(error);
    }
  });

  app.delete("/v1/proactive/integrations/home-assistant/:id", async (req, reply) => {
    const id = (req.params as {id: string}).id;
    deps.manager.stopConnection(id);
    const deleted = await repo.deleteConnection(resolveTenant(req), id);
    return deleted ? reply.code(204).send() : reply.code(404).send({error: "home_assistant_connection_not_found"});
  });

  app.post("/v1/proactive/integrations/xiaomi-health", async (req, reply) => {
    const body = bodyOf(req.body);
    const apiBaseUrl = requiredText(body.apiBaseUrl, "apiBaseUrl");
    const accessToken = requiredText(body.accessToken, "accessToken");
    const tenant = resolveTenant(req);
    const {revision} = await deps.manager.assertSourceActive(tenant, "restricted.profile").catch(mapIntegrationError);
    const client = new XiaomiHealthClient({
      apiBaseUrl,
      accessToken,
      refreshToken: optionalText(body.refreshToken),
      tokenEndpoint: optionalText(body.tokenEndpoint),
      clientId: optionalText(body.clientId),
      clientSecret: optionalText(body.clientSecret),
      dailyPath: optionalText(body.dailyPath),
    });
    const localDate = optionalText(body.localDate) ?? new Date().toISOString().slice(0, 10);
    const test = await client.testConnection(localDate).catch(mapIntegrationError);
    const id = optionalText(body.id) ?? nextId("conn_xiaomi");
    await repo.upsertConnection(tenant, {
      id,
      revisionId: revision.id,
      provider: "xiaomi_health",
      displayName: optionalText(body.displayName) ?? "小米运动健康",
      endpoint: apiBaseUrl,
      authType: "oauth2",
      credential: {
        accessToken,
        refreshToken: optionalText(body.refreshToken),
        clientId: optionalText(body.clientId),
        clientSecret: optionalText(body.clientSecret),
      },
      scopes: stringArray(body.scopes),
      settings: {tokenEndpoint: optionalText(body.tokenEndpoint), dailyPath: optionalText(body.dailyPath)},
      state: "active",
      lastError: null,
    });
    const sync = await deps.manager.syncXiaomiHealth(tenant, id, localDate).catch(mapIntegrationError);
    return reply.code(201).send({connection: (await repo.listConnections(tenant, "xiaomi_health")).find((item) => item.id === id), test, sync});
  });

  app.post("/v1/proactive/integrations/xiaomi-health/:id/test", async (req) => {
    const tenant = resolveTenant(req);
    await deps.manager.assertSourceActive(tenant, "restricted.profile").catch(mapIntegrationError);
    const connection = await repo.getConnectionSecret(tenant, (req.params as {id: string}).id);
    if (!connection || connection.provider !== "xiaomi_health" || !connection.endpoint) throw new NotFoundError("xiaomi_health_connection_not_found");
    const localDate = optionalText(bodyOf(req.body).localDate) ?? new Date().toISOString().slice(0, 10);
    return new XiaomiHealthClient({
      apiBaseUrl: connection.endpoint,
      accessToken: requiredText(connection.credential.accessToken, "accessToken"),
      refreshToken: optionalText(connection.credential.refreshToken),
      tokenEndpoint: optionalText(connection.settings.tokenEndpoint),
      clientId: optionalText(connection.credential.clientId),
      clientSecret: optionalText(connection.credential.clientSecret),
      dailyPath: optionalText(connection.settings.dailyPath),
    }).testConnection(localDate).catch(mapIntegrationError);
  });

  app.post("/v1/proactive/integrations/xiaomi-health/:id/sync", async (req) => {
    const localDate = optionalText(bodyOf(req.body).localDate) ?? new Date().toISOString().slice(0, 10);
    return deps.manager.syncXiaomiHealth(resolveTenant(req), (req.params as {id: string}).id, localDate).catch(mapIntegrationError);
  });

  app.get("/v1/proactive/integrations/xiaomi-health/:id/samples", async (req) => {
    const query = req.query as Record<string, unknown>;
    return {items: await repo.listHealthSamples(resolveTenant(req), {
      connectionId: (req.params as {id: string}).id,
      metric: optionalText(query.metric),
      from: optionalText(query.from),
      to: optionalText(query.to),
    })};
  });

  app.delete("/v1/proactive/integrations/xiaomi-health/:id", async (req, reply) => {
    const deleted = await repo.deleteConnection(resolveTenant(req), (req.params as {id: string}).id);
    return deleted ? reply.code(204).send() : reply.code(404).send({error: "xiaomi_health_connection_not_found"});
  });
}
