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
 * 登记发生在插件装配时，由宿主持有注销函数，故必须先于任何
 * 读取（API 请求、OpenAPI 文档生成）发生；文档按需惰性生成以反映登记结果。
 */
import type { z } from "zod";

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
  /** Additional operation headers; authentication remains owned by the host. */
  headers?: z.ZodObject;
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
 * 投影是无回合上下文的纯声明，不得捕获 services、仓储或一次执行的凭据。
 * 宿主保留安全投影用于回放；执行 handler 的生命周期独立结束。
 */
export interface ToolResultProjectionSchema {
  safeParse(value: unknown): { success: boolean; data?: unknown };
}

/** Pure host port; mutable registration state belongs to the host instance. */
export interface PluginApiRegistry {
  getPluginApiRevision(): number;
  registerPluginApiContribution(contribution: PluginApiContribution): () => void;
  /** Preflight and publish a complete owner batch, or leave all state and its revision unchanged. */
  registerToolResultProjections(pluginId: string, projections: readonly { name: string; schema: ToolResultProjectionSchema }[]): (() => void) | false;
  getPluginStreamEventTypes(): readonly string[];
  getPluginEventProjection(eventType: string): z.ZodType | undefined;
  getPluginToolResultProjection(toolName: string): ToolResultProjectionSchema | undefined;
  getToolResultProjectionOwner(toolName: string): string | undefined;
  isKnownStreamEventType(eventType: string): boolean;
  getPluginOpenApiRoutes(): readonly PluginOpenApiRoute[];
  /** Test isolation only; production lifecycle uses the registration disposer. */
  resetPluginApiContributions(): void;
}

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
