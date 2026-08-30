/**
 * Aervox｜思隅 @aervox/api — MCP 预设模块入口（CAP-020）
 *
 * 实例化 SqliteMcpServerRepository + McpService 并注册路由；启动时对已启用
 * 服务器做进程内 handler 恢复（不触网）。必须在 registerToolsModule 之后装配
 * （依赖 ctx.toolRuntime）。
 */
import type { ModuleContext } from "../context.js";
import { SqliteMcpServerRepository } from "@aervox/database";
import { registerMcpRoutes } from "./routes.js";
import { McpService } from "./service.js";

export interface McpModuleOptions {
  /** 测试注入 fake fetch；缺省用全局 fetch */
  fetchImpl?: typeof fetch;
}

export function registerMcpModule(ctx: ModuleContext, options: McpModuleOptions = {}): McpService {
  const repo = new SqliteMcpServerRepository(ctx.db);
  const service = new McpService({
    repo,
    toolRuntime: ctx.toolRuntime!,
    fetchImpl: options.fetchImpl,
  });

  registerMcpRoutes(ctx.app, service);

  // 重启恢复：为已启用服务器的存量注册行重挂代理 handler（不触网，静默容错）
  void service.restoreOnStartup().catch(() => undefined);

  return service;
}

export { McpService } from "./service.js";
export { McpHttpClient, McpUpstreamError } from "./client.js";
export { MCP_PRESETS, findMcpPreset } from "./presets.js";
export { classifyToolSafety, maskToken, mcpToolId } from "./service.js";
