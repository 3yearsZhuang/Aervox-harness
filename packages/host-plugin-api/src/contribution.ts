/**
 * Aervox｜思隅 @aervox/host-plugin-api — 插件贡献契约 (Contribution Protocol)
 *
 * 机器事实源：CR-060 与 AVX-PLUG-001 §0.3。
 *
 * 插件通过本契约向宿主声明三类贡献；宿主在**插件启用时**才装配它们，
 * 停用或缺包时不得残留：
 * 1. 回合切面（`turnPlugins`）—— 提示词注入与回合后处理；
 * 2. 工具贡献（`toolContributions`）—— 模型可见工具及其使用指南；
 * 3. HTTP 端点（`httpEndpoints`）—— 插件自有 API，经宿主适配为框架路由。
 */
import type { ReplayStep, ToolGuidance, ToolProviderPort } from "@aervox/core";
import type { PluginHostServices } from "./host-services.js";
import type { ServerTurnPlugin } from "./turn-plugin.js";

/** HTTP 方法子集：插件端点仅暴露这些语义 */
export type PluginHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** 插件端点入参；宿主负责解析与鉴权，插件只处理业务 */
export interface PluginHttpRequest {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

/** 插件端点出参；`status` 缺省为 200 */
export interface PluginHttpResponse {
  status?: number;
  payload: unknown;
}

/**
 * 插件自有 HTTP 端点。
 *
 * 插件不得依赖具体 Web 框架：宿主把本结构适配为真实路由（见 `apps/api` 装配层）。
 * 鉴权、限流与本地上下文解析由宿主统一负责，插件不得自行放宽。
 */
export interface PluginHttpEndpoint {
  method: PluginHttpMethod;
  /** 完整路径（含 `/v1` 前缀），如 `/v1/terms/explore` */
  path: string;
  /** 宿主在解析本地上下文后注入 `services`，插件从中取得窄端口 */
  handler(
    request: PluginHttpRequest,
    services: PluginHostServices,
  ): Promise<PluginHttpResponse> | PluginHttpResponse;
}

/**
 * 工具贡献。
 *
 * `guidance` 是面向模型的工具使用指南；宿主经既有 `customGuidance` 注入位合入
 * 基础提示词，插件**不得**修改内核的基础提示词常量。
 */
export interface PluginToolContribution {
  /** 贡献标识（同一插件内唯一），用于装配诊断 */
  id: string;
  provider: ToolProviderPort;
  guidance?: ToolGuidance[];
}

/**
 * 插件服务端注册单元：`plugins/<id>/src/server` 的默认导出形状。
 *
 * 宿主组合根以容错方式加载该对象（缺包/加载失败不得中断宿主启动），
 * 并在插件启用时装配其全部贡献。
 */
export interface ServerPluginRegistration {
  /** 提供该注册单元的插件 id（与 Manifest `metadata.id` 一致） */
  pluginId: string;
  /** 回合切面：与本地上下文无关，装配期一次性注册，启用门控由 Runner 负责 */
  turnPlugins?: ServerTurnPlugin[];
  /**
   * 工具贡献工厂：宿主在**回合运行时**按当前本地上下文调用（端口按上下文绑定），
   * 并仅在插件启用时把结果合入模型工具面与提示词指南。
   */
  toolContributions?: (services: PluginHostServices) => PluginToolContribution[];
  /** HTTP 端点：与上下文无关，装配期挂载，上下文由宿主按请求注入 handler */
  httpEndpoints?: PluginHttpEndpoint[];
  /**
   * 确定性回放脚本贡献：键即 `AERVOX_LOOP_PROVIDER` 的模式名。
   *
   * 供插件自带其领域工具的确定性夹具，避免宿主为验证插件工具而内建插件领域脚本。
   * 宿主仅在自身未内建同名模式时采用（插件不得覆盖宿主内建模式）。
   */
  replayScripts?: Record<string, readonly ReplayStep[]>;
}
