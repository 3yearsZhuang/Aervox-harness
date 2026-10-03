/**
 * Aervox｜思隅 @aervox/contracts — 插件 API 贡献登记表（CR-060）
 *
 * 机器事实源：CR-060 与 AVX-PLUG-001 §0.3。
 *
 * 内核契约（事件类型枚举、投影白名单、OpenAPI 文档、插件专用 Zod 模式）不得出现
 * 任何具体插件的领域标识。插件需要扩展这些面向外部的 API 契约时，一律经本登记表
 * **显式声明**，由内核按其声明泛化处理：
 *
 * - `streamEventTypes`：内核枚举之外的插件自有流事件类型；
 * - `eventProjections`：插件事件负载的对外投影白名单（fail-closed，未登记即投影为空）；
 * - `toolResultProjections`：插件工具结果的对外投影白名单（同上，替代内核特判具体工具名）；
 * - `openApiRoutes`：插件自有端点的 OpenAPI 片段。
 *
 * 登记发生在插件模块加载时（宿主组合根以容错方式动态 import），故必须先于任何
 * 读取（API 请求、OpenAPI 文档生成）发生；文档按需惰性生成以反映登记结果。
 */
import { z } from "zod";
import { KERNEL_STREAM_EVENT_TYPES } from "./schemas.js";

/** 插件自有端点的 OpenAPI 片段（宿主统一补 scope 请求头与通用错误响应） */
export interface PluginOpenApiRoute {
  method: "get" | "post" | "put" | "patch" | "delete";
  /** 完整路径（含 `/v1` 前缀），支持 `{param}` 占位 */
  path: string;
  summary?: string;
  description?: string;
  tags?: string[];
  /** 路径参数模式（须为对象模式：OpenAPI 路径参数按字段展开） */
  params?: z.ZodObject;
  /** 查询参数模式（同上） */
  query?: z.ZodObject;
  /** 请求体模式 */
  body?: z.ZodType;
  responses: Record<number, { description: string; schema?: z.ZodType }>;
}

/** 插件对外部 API 契约的扩展声明 */
export interface PluginApiContribution {
  streamEventTypes?: readonly string[];
  eventProjections?: Readonly<Record<string, z.ZodType>>;
  openApiRoutes?: readonly PluginOpenApiRoute[];
}

/**
 * 工具结果投影校验口。
 *
 * 只要求结构兼容 Zod 的 `safeParse`，使宿主插件契约（`@aervox/host-plugin-api`）
 * 无需引入 zod 运行时依赖即可声明投影；内核侧同样只经本接口校验。
 */
export interface ToolResultProjectionSchema {
  safeParse(value: unknown): { success: boolean; data?: unknown };
}

/** 已登记的工具结果投影（含归属插件，用于冲突判定与诊断） */
interface ToolResultProjectionEntry {
  pluginId: string;
  schema: ToolResultProjectionSchema;
}

interface PluginApiRegistryState {
  streamEventTypes: Set<string>;
  eventProjections: Map<string, z.ZodType>;
  toolResultProjections: Map<string, ToolResultProjectionEntry>;
  openApiRoutes: PluginOpenApiRoute[];
}

const state: PluginApiRegistryState = {
  streamEventTypes: new Set<string>(),
  eventProjections: new Map<string, z.ZodType>(),
  toolResultProjections: new Map<string, ToolResultProjectionEntry>(),
  openApiRoutes: [],
};

/**
 * 插件端点路径合法性判据（唯一事实源，被内核文档登记与宿主路由挂载共同复用）。
 *
 * 只接受 `/v1/` 前缀的绝对路径，禁止协议、查询串、空白与路径穿越（`..`）。
 * 允许 Fastify 路径参数（`:param`）与 OpenAPI 占位（`{param}`）两种写法——
 * 同一端点被插件声明两次时分别使用这两种语法，二者都必须放行。
 * 该判据防止插件借 OpenAPI 片段覆盖内核端点描述或注入非法路径。
 */
export function isValidPluginRoutePath(path: string): boolean {
  if (typeof path !== "string" || !path.startsWith("/v1/")) return false;
  if (path.includes("..") || /[?#\s\\]/.test(path)) return false;
  return /^\/v1\/[A-Za-z0-9._~\-/{}:]*$/.test(path);
}

/**
 * 登记插件对 API 契约的扩展。
 *
 * 同一 eventType / toolName 重复登记时**后登记者生效**（热重载语义）；
 * `streamEventTypes` 与 `eventProjections` 可分别声明（有负载模式的类型必须同时登记投影）。
 * 非法路径的 OpenAPI 片段被忽略并告警，避免污染对外文档契约。
 */
export function registerPluginApiContribution(contribution: PluginApiContribution): void {
  for (const eventType of contribution.streamEventTypes ?? []) {
    state.streamEventTypes.add(eventType);
  }
  for (const [eventType, schema] of Object.entries(contribution.eventProjections ?? {})) {
    state.eventProjections.set(eventType, schema);
    state.streamEventTypes.add(eventType);
  }
  for (const route of contribution.openApiRoutes ?? []) {
    if (!isValidPluginRoutePath(route.path)) {
      console.warn(`[contracts] 插件 OpenAPI 路由路径非法，已忽略：${route.path}`);
      continue;
    }
    const index = state.openApiRoutes.findIndex(
      (existing) => existing.method === route.method && existing.path === route.path,
    );
    if (index >= 0) state.openApiRoutes[index] = route;
    else state.openApiRoutes.push(route);
  }
}

/**
 * 登记某插件**自有工具**的结果对外投影（CR-060 §B7 归属重构）。
 *
 * 由**宿主**在装配插件工具贡献时代登记：投影随工具贡献声明，宿主只为该插件实际
 * 贡献的工具调用本函数，因此插件无法为内核工具或他人工具登记投影。
 * 同一工具被不同插件重复登记属归属冲突 —— 保留先登记者并告警（fail-closed）。
 */
export function registerToolResultProjection(
  pluginId: string,
  toolName: string,
  schema: ToolResultProjectionSchema,
): boolean {
  const existing = state.toolResultProjections.get(toolName);
  if (existing) {
    if (existing.pluginId !== pluginId) {
      console.warn(
        `[contracts] 工具 ${toolName} 的投影已归属插件 ${existing.pluginId}，忽略来自 ${pluginId} 的重复登记`,
      );
      return false;
    }
    state.toolResultProjections.set(toolName, { pluginId, schema });
    return true;
  }
  state.toolResultProjections.set(toolName, { pluginId, schema });
  return true;
}

/** 插件登记的流事件类型（不含内核枚举） */
export function getPluginStreamEventTypes(): readonly string[] {
  return [...state.streamEventTypes];
}

/** 插件登记的事件负载投影模式 */
export function getPluginEventProjection(eventType: string): z.ZodType | undefined {
  return state.eventProjections.get(eventType);
}

/** 插件登记的工具结果投影模式（仅对该工具的实际贡献方可见） */
export function getPluginToolResultProjection(toolName: string): ToolResultProjectionSchema | undefined {
  return state.toolResultProjections.get(toolName)?.schema;
}

/** 工具结果投影的归属插件 id（诊断用） */
export function getToolResultProjectionOwner(toolName: string): string | undefined {
  return state.toolResultProjections.get(toolName)?.pluginId;
}

/**
 * 流事件类型是否为已知类型：内核自有事件（`KERNEL_STREAM_EVENT_TYPES`），
 * 或已由插件经 `registerPluginApiContribution` 声明的事件类型。
 *
 * 供宿主在**插件写入回合流**时校验：登记表不是装饰，未声明即拒绝（fail-closed）。
 * 内核自身的写入路径不经过本判据。
 */
export function isKnownStreamEventType(eventType: string): boolean {
  return (
    (KERNEL_STREAM_EVENT_TYPES as readonly string[]).includes(eventType) ||
    state.streamEventTypes.has(eventType)
  );
}

/** 插件登记的 OpenAPI 路由片段（按登记顺序） */
export function getPluginOpenApiRoutes(): readonly PluginOpenApiRoute[] {
  return [...state.openApiRoutes];
}

/**
 * 清空登记表。仅供测试隔离使用；生产路径不得调用。
 */
export function resetPluginApiContributions(): void {
  state.streamEventTypes.clear();
  state.eventProjections.clear();
  state.toolResultProjections.clear();
  state.openApiRoutes.length = 0;
}
