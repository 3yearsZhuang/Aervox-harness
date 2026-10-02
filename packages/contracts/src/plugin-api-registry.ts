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
  toolResultProjections?: Readonly<Record<string, z.ZodType>>;
  openApiRoutes?: readonly PluginOpenApiRoute[];
}

interface PluginApiRegistryState {
  streamEventTypes: Set<string>;
  eventProjections: Map<string, z.ZodType>;
  toolResultProjections: Map<string, z.ZodType>;
  openApiRoutes: PluginOpenApiRoute[];
}

const state: PluginApiRegistryState = {
  streamEventTypes: new Set<string>(),
  eventProjections: new Map<string, z.ZodType>(),
  toolResultProjections: new Map<string, z.ZodType>(),
  openApiRoutes: [],
};

/**
 * 登记插件对 API 契约的扩展。
 *
 * 同一 eventType / toolName 重复登记时**后登记者生效**（热重载语义）；
 * `streamEventTypes` 与 `eventProjections` 可分别声明（有负载模式的类型必须同时登记投影）。
 */
export function registerPluginApiContribution(contribution: PluginApiContribution): void {
  for (const eventType of contribution.streamEventTypes ?? []) {
    state.streamEventTypes.add(eventType);
  }
  for (const [eventType, schema] of Object.entries(contribution.eventProjections ?? {})) {
    state.eventProjections.set(eventType, schema);
    state.streamEventTypes.add(eventType);
  }
  for (const [toolName, schema] of Object.entries(contribution.toolResultProjections ?? {})) {
    state.toolResultProjections.set(toolName, schema);
  }
  for (const route of contribution.openApiRoutes ?? []) {
    const index = state.openApiRoutes.findIndex(
      (existing) => existing.method === route.method && existing.path === route.path,
    );
    if (index >= 0) state.openApiRoutes[index] = route;
    else state.openApiRoutes.push(route);
  }
}

/** 插件登记的流事件类型（不含内核枚举） */
export function getPluginStreamEventTypes(): readonly string[] {
  return [...state.streamEventTypes];
}

/** 插件登记的事件负载投影模式 */
export function getPluginEventProjection(eventType: string): z.ZodType | undefined {
  return state.eventProjections.get(eventType);
}

/** 插件登记的工具结果投影模式 */
export function getPluginToolResultProjection(toolName: string): z.ZodType | undefined {
  return state.toolResultProjections.get(toolName);
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
