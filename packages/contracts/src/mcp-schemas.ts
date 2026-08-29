/**
 * Aervox｜思隅 @aervox/contracts — MCP 服务器预设契约（CAP-020）
 *
 * 描述预设 MCP 服务器的接入档案与配置状态。Token 不入契约（服务端只回传
 * tokenConfigured / tokenMasked 脱敏态，CR-004「不导出 MCP 凭据」）。
 */
import { z } from "zod";

/** MCP 传输协议（当前支持 Streamable HTTP；sse 预留） */
export const mcpTransportSchema = z.enum(["streamable_http", "sse"]);

/** MCP 鉴权方式 */
export const mcpAuthTypeSchema = z.enum(["bearer", "none"]);

/** MCP 服务器连接状态 */
export const mcpServerStatusSchema = z.enum(["disconnected", "connected", "error"]);

/** 预设 MCP 服务器（出厂内置接入档案，含本机接入状态） */
export const mcpPresetServerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  transport: mcpTransportSchema,
  endpointUrl: z.string().min(1),
  authType: mcpAuthTypeSchema,
  protocolVersion: z.string().min(1),
  homepage: z.string().min(1),
  docsUrl: z.string().min(1),
  tokenApplyUrl: z.string().min(1),
  regionNote: z.string().optional(),
  rateLimitNote: z.string().optional(),
  sourceUrl: z.string().min(1),
  /** 本机是否已有配置行 */
  configured: z.boolean(),
  enabled: z.boolean(),
  status: mcpServerStatusSchema,
  toolCount: z.number().int().nonnegative(),
  tokenConfigured: z.boolean(),
  tokenMasked: z.string().nullable().optional(),
  lastSyncAt: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
});

/** 已配置的 MCP 服务器（token 只回传脱敏态） */
export const mcpServerConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  transport: mcpTransportSchema,
  endpointUrl: z.string().min(1),
  authType: mcpAuthTypeSchema,
  enabled: z.boolean(),
  isPreset: z.boolean(),
  status: mcpServerStatusSchema,
  toolCount: z.number().int().nonnegative(),
  tokenConfigured: z.boolean(),
  tokenMasked: z.string().nullable().optional(),
  lastSyncAt: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** 接入请求：bearer 服务器需携带 token（从预设 tokenApplyUrl 申请） */
export const mcpConnectServerRequestSchema = z.object({
  token: z.string().min(1).optional(),
});

/** 服务器内已同步的工具条目（PET-05 安全级别随注册表返回） */
export const mcpServerToolEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  safetyLevel: z.string().min(1),
  enabled: z.boolean(),
  inputSchema: z.unknown().optional(),
});

export type McpTransport = z.infer<typeof mcpTransportSchema>;
export type McpAuthType = z.infer<typeof mcpAuthTypeSchema>;
export type McpServerStatus = z.infer<typeof mcpServerStatusSchema>;
export type McpPresetServer = z.infer<typeof mcpPresetServerSchema>;
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type McpConnectServerRequest = z.infer<typeof mcpConnectServerRequestSchema>;
export type McpServerToolEntry = z.infer<typeof mcpServerToolEntrySchema>;
