import type {
  SqliteProactiveIntelligenceRepository,
  TenantContext,
} from "@aervox/database";
import type { ToolRuntime } from "../tools/runtime.js";
import { ProactiveActionAuthorizer } from "./action-authorizer.js";
import { ProactiveIntegrationManager } from "./integration-manager.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name}_required`);
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

let invocationSequence = 0;

async function executeHomeWrite(
  tenant: TenantContext,
  args: Record<string, unknown>,
  alreadyAuthorized: boolean,
  manager: ProactiveIntegrationManager,
  authorizer: ProactiveActionAuthorizer,
): Promise<unknown> {
  const connectionId = requiredText(args.connectionId, "connectionId");
  const entityId = requiredText(args.entityId, "entityId");
  const service = requiredText(args.service, "service");
  const data = record(args.data);
  if (alreadyAuthorized) {
    return manager.callHomeAssistantService(tenant, connectionId, entityId, service, data);
  }
  const invocationId = `runtime:${Date.now().toString(36)}:${(++invocationSequence).toString(36)}`;
  const authorization = await authorizer.authorize(tenant, {
    turnId: invocationId,
    attemptId: invocationId,
    invocationId,
    toolId: "ha_call_service",
    toolName: "ha_call_service",
    category: "external",
    safetyLevel: "write_with_approval",
    requiredPermissions: ["action.external"],
    arguments: args,
  });
  if (!authorization.authorized) throw new Error(authorization.reason);
  await authorizer.markRunning(tenant, authorization.action.id);
  try {
    const result = await manager.callHomeAssistantService(tenant, connectionId, entityId, service, data);
    await authorizer.markExecuted(tenant, authorization.action.id, {connectionId, entityId, service});
    return result;
  } catch (error) {
    await authorizer.markFailed(tenant, authorization.action.id, error instanceof Error ? error.message : "home_assistant_call_failed");
    throw error;
  }
}

export function registerProactiveIntegrationTools(input: {
  runtime: ToolRuntime;
  repo: SqliteProactiveIntelligenceRepository;
  manager: ProactiveIntegrationManager;
  authorizer: ProactiveActionAuthorizer;
}): void {
  const {runtime, repo, manager, authorizer} = input;

  runtime.registerHandler("ha_list_entities", {
    async call(tenant, rawArgs) {
      await manager.assertSourceActive(tenant, "device.sensors");
      const args = record(rawArgs);
      return {
        items: await repo.listHomeEntities(tenant, optionalText(args.connectionId), true),
      };
    },
  });
  runtime.registerHandler("ha_get_entity_state", {
    async call(tenant, rawArgs) {
      const args = record(rawArgs);
      return manager.getHomeAssistantState(
        tenant,
        requiredText(args.connectionId, "connectionId"),
        requiredText(args.entityId, "entityId"),
      );
    },
  });
  runtime.registerHandler("ha_call_service", {
    async call(tenant, rawArgs, context) {
      return executeHomeWrite(tenant, record(rawArgs), context.proactiveAuthorization, manager, authorizer);
    },
  });
  runtime.registerHandler("health_get_daily_steps", {
    async call(tenant, rawArgs) {
      await manager.assertSourceActive(tenant, "restricted.profile");
      const args = record(rawArgs);
      const date = optionalText(args.date) ?? new Date().toISOString().slice(0, 10);
      const items = await repo.listHealthSamples(tenant, {
        connectionId: optionalText(args.connectionId), metric: "steps", from: date, to: date, limit: 20,
      });
      return {date, total: items.reduce((sum, item) => sum + item.value, 0), unit: "count", items};
    },
  });
  runtime.registerHandler("health_get_sleep_summary", {
    async call(tenant, rawArgs) {
      await manager.assertSourceActive(tenant, "restricted.profile");
      const args = record(rawArgs);
      const date = optionalText(args.date) ?? new Date().toISOString().slice(0, 10);
      const items = await repo.listHealthSamples(tenant, {
        connectionId: optionalText(args.connectionId), metric: "sleep_minutes", from: date, to: date, limit: 20,
      });
      const minutes = items.reduce((sum, item) => sum + item.value, 0);
      return {date, minutes, hours: Math.round((minutes / 60) * 10) / 10, items};
    },
  });

  const commonConnection = {type: "string", description: "本地连接 ID"};
  void Promise.all([
    runtime.registerTool({
      id: "ha_list_entities", name: "ha_list_entities",
      description: "列出用户已授权给 Aervox 的 Home Assistant 实体及其本地缓存状态。",
      category: "external", safetyLevel: "read_only", requiredPermissions: ["device.sensors"],
      inputSchema: {type: "object", properties: {connectionId: commonConnection}}, builtin: true, priority: 80,
    }),
    runtime.registerTool({
      id: "ha_get_entity_state", name: "ha_get_entity_state",
      description: "实时读取一个已授权 Home Assistant 实体的状态。",
      category: "external", safetyLevel: "read_only", requiredPermissions: ["device.sensors"],
      inputSchema: {type: "object", properties: {connectionId: commonConnection, entityId: {type: "string"}}, required: ["connectionId", "entityId"]},
      builtin: true, priority: 80,
    }),
    runtime.registerTool({
      id: "ha_call_service", name: "ha_call_service",
      description: "对用户已授权的 Home Assistant 实体调用白名单服务。",
      category: "external", safetyLevel: "write_with_approval", requiredPermissions: ["action.external", "device.sensors"],
      inputSchema: {type: "object", properties: {connectionId: commonConnection, entityId: {type: "string"}, service: {type: "string"}, data: {type: "object"}}, required: ["connectionId", "entityId", "service"]},
      builtin: true, priority: 80,
    }),
    runtime.registerTool({
      id: "health_get_daily_steps", name: "health_get_daily_steps",
      description: "读取用户已授权的小米运动健康每日步数汇总。",
      category: "health", safetyLevel: "read_only", requiredPermissions: ["restricted.profile"],
      inputSchema: {type: "object", properties: {connectionId: commonConnection, date: {type: "string", format: "date"}}}, builtin: true, priority: 75,
    }),
    runtime.registerTool({
      id: "health_get_sleep_summary", name: "health_get_sleep_summary",
      description: "读取用户已授权的小米运动健康每日睡眠时长汇总。",
      category: "health", safetyLevel: "read_only", requiredPermissions: ["restricted.profile"],
      inputSchema: {type: "object", properties: {connectionId: commonConnection, date: {type: "string", format: "date"}}}, builtin: true, priority: 75,
    }),
  ]);
}
