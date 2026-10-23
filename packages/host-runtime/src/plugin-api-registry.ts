/** Mutable plugin API registration belongs to one product host, never Contracts. */
import {
  KERNEL_STREAM_EVENT_TYPES, isValidPluginRoutePath,
  type PluginApiRegistry, type PluginApiContribution, type PluginOpenApiRoute, type ToolResultProjectionSchema,
} from "@aervox/contracts";

/** 已登记的工具结果投影（含归属插件，用于冲突判定与诊断） */
interface ToolResultProjectionEntry {
  pluginId: string;
  schema: ToolResultProjectionSchema;
}

interface PluginApiRegistryState {
  contributions: PluginApiContribution[];
  toolResultProjections: Map<string, ToolResultProjectionEntry[]>;
}

/** Copy mutable route metadata while retaining the declared, context-free schema ports. */
function copyRoute(route: PluginOpenApiRoute): PluginOpenApiRoute {
  return { ...route, tags: route.tags ? [...route.tags] : undefined,
    responses: Object.fromEntries(Object.entries(route.responses).map(([status, response]) => [status, { ...response }])) };
}

/** Each host owns its registry. Contracts never keep process-global plugin state. */
export function createPluginApiRegistry(): PluginApiRegistry {
  const state: PluginApiRegistryState = { contributions: [], toolResultProjections: new Map() };
  let revision = 0;
  function getPluginApiRevision(): number { return revision; }
/**
 * 登记插件对 API 契约的扩展。
 *
 * 同一 eventType / toolName 重复登记时**后登记者生效**（热重载语义）；
 * `streamEventTypes` 与 `eventProjections` 可分别声明（有负载模式的类型必须同时登记投影）。
 * 非法路径的 OpenAPI 片段被忽略并告警，避免污染对外文档契约。
 */
function registerPluginApiContribution(contribution: PluginApiContribution): () => void {
  const routes: PluginOpenApiRoute[] = [];
  for (const route of contribution.openApiRoutes ?? []) {
    if (!isValidPluginRoutePath(route.path)) {
      console.warn(`[plugin-api] 插件 OpenAPI 路由路径非法，已忽略：${route.path}`);
      continue;
    }
    routes.push(copyRoute(route));
  }
  // 每次登记有独立身份；多个宿主实例或重载共享相同键时，注销不会删掉后来者。
  const entry: PluginApiContribution = {
    streamEventTypes: [...(contribution.streamEventTypes ?? [])],
    eventProjections: Object.assign(Object.create(null), contribution.eventProjections),
    openApiRoutes: routes,
  };
  state.contributions.push(entry);
  revision++;
  return () => {
    const index = state.contributions.indexOf(entry);
    if (index >= 0) {
      state.contributions.splice(index, 1);
      revision++;
    }
  };
}

/**
 * 登记某插件**自有工具**的结果对外投影（CR-060 §B7 归属重构）。
 *
 * 由**宿主**在装配插件工具贡献时代登记：投影随工具贡献声明，宿主只为该插件实际
 * 贡献的工具调用本函数，因此插件无法为内核工具或他人工具登记投影。
 * 同一工具被不同插件重复登记属归属冲突 —— 保留先登记者并告警（fail-closed）。
 */
function registerToolResultProjections(
  pluginId: string,
  projections: readonly { name: string; schema: ToolResultProjectionSchema }[],
): (() => void) | false {
  const names = new Set<string>();
  for (const { name } of projections) {
    if (names.has(name)) throw new Error(`duplicate_tool_projection: ${name}`);
    names.add(name);
    const existing = state.toolResultProjections.get(name)?.at(-1);
    if (existing && existing.pluginId !== pluginId) {
      console.warn(`[plugin-api] 工具 ${name} 的投影已归属插件 ${existing.pluginId}，拒绝 ${pluginId} 的重复登记`);
      return false;
    }
  }
  const entries = projections.map(({ name, schema }) => ({ name, entry: { pluginId, schema } }));
  if (!entries.length) return () => {};
  for (const { name, entry } of entries) {
    const stack = state.toolResultProjections.get(name) ?? [];
    stack.push(entry);
    state.toolResultProjections.set(name, stack);
  }
  revision++;
  return () => {
    let removed = false;
    for (const { name, entry } of entries) {
      const current = state.toolResultProjections.get(name);
      const index = current?.indexOf(entry) ?? -1;
      if (current && index >= 0) {
        current.splice(index, 1);
        if (!current.length) state.toolResultProjections.delete(name);
        removed = true;
      }
    }
    if (removed) revision++;
  };
}

/** 插件登记的流事件类型（不含内核枚举） */
function getPluginStreamEventTypes(): readonly string[] {
  return [...new Set(state.contributions.flatMap((entry) => [
    ...(entry.streamEventTypes ?? []),
    ...Object.keys(entry.eventProjections ?? {}),
  ]))];
}

/** 插件登记的事件负载投影模式 */
function getPluginEventProjection(eventType: string): ReturnType<PluginApiRegistry["getPluginEventProjection"]> {
  for (let i = state.contributions.length - 1; i >= 0; i--) {
    const schema = state.contributions[i]!.eventProjections?.[eventType];
    if (schema) return schema;
  }
  return undefined;
}

/** 插件登记的工具结果投影模式（仅对该工具的实际贡献方可见） */
function getPluginToolResultProjection(toolName: string): ToolResultProjectionSchema | undefined {
  return state.toolResultProjections.get(toolName)?.at(-1)?.schema;
}

/** 工具结果投影的归属插件 id（诊断用） */
function getToolResultProjectionOwner(toolName: string): string | undefined {
  return state.toolResultProjections.get(toolName)?.at(-1)?.pluginId;
}

/**
 * 流事件类型是否为已知类型：内核自有事件（`KERNEL_STREAM_EVENT_TYPES`），
 * 或已由插件经 `registerPluginApiContribution` 声明的事件类型。
 *
 * 供宿主在**插件写入回合流**时校验：登记表不是装饰，未声明即拒绝（fail-closed）。
 * 内核自身的写入路径不经过本判据。
 */
function isKnownStreamEventType(eventType: string): boolean {
  return (
    (KERNEL_STREAM_EVENT_TYPES as readonly string[]).includes(eventType) ||
    state.contributions.some((entry) =>
      entry.streamEventTypes?.includes(eventType) || Object.hasOwn(entry.eventProjections ?? {}, eventType))
  );
}

/** 插件登记的 OpenAPI 路由片段（按登记顺序） */
function getPluginOpenApiRoutes(): readonly PluginOpenApiRoute[] {
  const routes = new Map<string, PluginOpenApiRoute>();
  for (const entry of state.contributions) {
    for (const route of entry.openApiRoutes ?? []) routes.set(`${route.method}:${route.path}`, route);
  }
  return [...routes.values()].map(copyRoute);
}

/**
 * 清空登记表。仅供测试隔离使用；生产路径不得调用。
 */
function resetPluginApiContributions(): void {
  state.contributions.length = 0;
  state.toolResultProjections.clear();
  revision++;
}

  return {
    getPluginApiRevision, registerPluginApiContribution, registerToolResultProjections,
    getPluginStreamEventTypes, getPluginEventProjection, getPluginToolResultProjection,
    getToolResultProjectionOwner, isKnownStreamEventType, getPluginOpenApiRoutes,
    resetPluginApiContributions,
  };
}
