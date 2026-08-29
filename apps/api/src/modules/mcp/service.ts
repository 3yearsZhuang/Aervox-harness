/**
 * Aervox｜思隅 @aervox/api — MCP 预设服务（CAP-020 / T-04 / PET-05）
 *
 * 职责：预设档案展示、Token 接入（connect）、工具同步（tools/list → tool_registrations）、
 * 远程调用代理（tools/call）、断开（注销同步工具）。安全规则：
 * - 同步出的远程工具以 `mcp__<serverId>__<toolName>` 命名落系统级注册表
 *   （category=external，pluginId=mcp:<serverId>），复用既有 ToolRuntime 与
 *   PET-05 安全级别门控——AI 自主调用只放行 read_only；
 * - 安全分级：按官方工具名前缀保守判定，查询/列表类 read_only，
 *   其余（下单、领券、写地址等有副作用）一律 write_with_approval；
 * - Token 只落本地库，API 一律脱敏回传（CR-004「不导出 MCP 凭据」）。
 */
import type { SqliteMcpServerRepository, McpServerModel } from "@aervox/database";
import { NotFoundError } from "../../shared/errors.js";
import type { ToolRuntime } from "../tools/runtime.js";
import { McpHttpClient, McpUpstreamError, type McpRemoteTool } from "./client.js";
import { MCP_PRESETS, findMcpPreset, type McpPresetDefinition } from "./presets.js";

/** 工具命名空间前缀：mcp__<serverId>__<toolName> */
export function mcpToolId(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName}`;
}

/** 只读工具名前缀白名单（保守：不匹配即视为有副作用，需授权） */
const READ_ONLY_TOOL_PREFIXES = [
  "list-",
  "query-",
  "delivery-query",
  "available-",
  "campaign-",
  "now-",
  "calculate-",
  "mall-points-",
  "mall-product-",
  "mall-order-",
] as const;

/** PET-05 安全分级：官方查询/列表类工具 → read_only；其余（下单/领券/写地址）→ 需授权 */
export function classifyToolSafety(toolName: string): "read_only" | "write_with_approval" {
  return READ_ONLY_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix))
    ? "read_only"
    : "write_with_approval";
}

/** Token 脱敏：保留首尾少量字符便于辨认，其余打码 */
export function maskToken(token: string | null | undefined): string | null {
  if (!token) return null;
  if (token.length <= 8) return "****";
  return `${token.slice(0, 4)}****${token.slice(-4)}`;
}

export interface McpPresetDto {
  id: string;
  name: string;
  description: string;
  transport: string;
  endpointUrl: string;
  authType: string;
  protocolVersion: string;
  homepage: string;
  docsUrl: string;
  tokenApplyUrl: string;
  regionNote?: string;
  rateLimitNote?: string;
  sourceUrl: string;
  /** 已接入过（存在配置行） */
  configured: boolean;
  enabled: boolean;
  /** disconnected / connected / error */
  status: string;
  toolCount: number;
  tokenConfigured: boolean;
  tokenMasked?: string | null;
  lastSyncAt?: string | null;
  lastError?: string | null;
}

export interface McpServerDto {
  id: string;
  name: string;
  transport: string;
  endpointUrl: string;
  authType: string;
  enabled: boolean;
  isPreset: boolean;
  status: string;
  toolCount: number;
  tokenConfigured: boolean;
  tokenMasked?: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface McpServerToolDto {
  id: string;
  name: string;
  description: string;
  safetyLevel: string;
  enabled: boolean;
  inputSchema?: unknown;
}

export interface McpServiceDeps {
  repo: SqliteMcpServerRepository;
  toolRuntime: ToolRuntime;
  /** 测试注入 fake fetch；缺省用全局 fetch */
  fetchImpl?: typeof fetch;
}

function toServerDto(row: McpServerModel): McpServerDto {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    endpointUrl: row.endpointUrl,
    authType: row.authType,
    enabled: row.enabled === 1,
    isPreset: row.isPreset === 1,
    status: row.status,
    toolCount: row.toolCount,
    tokenConfigured: Boolean(row.token),
    tokenMasked: maskToken(row.token),
    lastSyncAt: row.lastSyncAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPresetDto(preset: McpPresetDefinition, row: McpServerModel | null): McpPresetDto {
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    transport: preset.transport,
    endpointUrl: preset.endpointUrl,
    authType: preset.authType,
    protocolVersion: preset.protocolVersion,
    homepage: preset.homepage,
    docsUrl: preset.docsUrl,
    tokenApplyUrl: preset.tokenApplyUrl,
    regionNote: preset.regionNote,
    rateLimitNote: preset.rateLimitNote,
    sourceUrl: preset.sourceUrl,
    configured: row !== null,
    enabled: row?.enabled === 1,
    status: row?.status ?? "disconnected",
    toolCount: row?.toolCount ?? 0,
    tokenConfigured: Boolean(row?.token),
    tokenMasked: maskToken(row?.token),
    lastSyncAt: row?.lastSyncAt ?? null,
    lastError: row?.lastError ?? null,
  };
}

export class McpService {
  /** 每服务器缓存的客户端（端点/凭据变化时重建；initialize 每实例仅握手一次） */
  private readonly clients = new Map<string, McpHttpClient>();

  constructor(private readonly deps: McpServiceDeps) {}

  /** 预设清单（合并本机配置状态） */
  async listPresets(): Promise<McpPresetDto[]> {
    const rows = await this.deps.repo.listServers();
    const byId = new Map(rows.map((row) => [row.id, row]));
    return MCP_PRESETS.map((preset) => toPresetDto(preset, byId.get(preset.id) ?? null));
  }

  /** 已配置的 MCP 服务器（token 脱敏） */
  async listServers(): Promise<McpServerDto[]> {
    const rows = await this.deps.repo.listServers();
    return rows.map(toServerDto);
  }

  /** 服务器内已同步的工具清单 */
  async listServerTools(serverId: string): Promise<McpServerToolDto[]> {
    await this.requireServer(serverId);
    const prefix = `mcp__${serverId}__`;
    const all = await this.deps.toolRuntime.listTools();
    return all
      .filter((tool) => tool.id.startsWith(prefix))
      .map((tool) => ({
        id: tool.id,
        name: tool.name,
        description: tool.description,
        safetyLevel: tool.safetyLevel,
        enabled: tool.enabled === 1,
        inputSchema: tool.inputSchemaJson ?? undefined,
      }));
  }

  /**
   * 接入（预设）服务器：写入/更新连接配置并立即同步工具。
   * token 缺省时保留既有值（重复 connect 无需重填）。
   */
  async connectServer(serverId: string, token?: string | null): Promise<McpServerDto> {
    const preset = findMcpPreset(serverId);
    const existing = await this.deps.repo.getServer(serverId);
    if (!preset && !existing) {
      throw new NotFoundError(`MCP 服务器不存在或非预设：${serverId}`);
    }

    const row = await this.deps.repo.upsertServer({
      id: serverId,
      name: preset?.name ?? existing!.name,
      transport: preset?.transport ?? existing!.transport,
      endpointUrl: preset?.endpointUrl ?? existing!.endpointUrl,
      authType: preset?.authType ?? existing!.authType,
      token: token === undefined ? undefined : token || null,
      enabled: true,
      isPreset: Boolean(preset) || existing?.isPreset === 1,
    });

    try {
      await this.syncServer(serverId);
    } catch (err) {
      // 连接失败不回滚配置（保留 token 便于重试），但状态落 error 并向上抛出
      const message = err instanceof Error ? err.message : String(err);
      await this.deps.repo.setStatus(serverId, "error", message);
      throw err;
    }
    const updated = await this.deps.repo.getServer(serverId);
    return toServerDto(updated ?? row);
  }

  /** 重新同步工具（initialize + tools/list → 注册表幂等更新 + 失效工具注销） */
  async syncServer(serverId: string): Promise<McpServerDto> {
    const row = await this.requireServer(serverId);
    if (row.authType === "bearer" && !row.token) {
      throw new McpUpstreamError(`服务器 ${serverId} 尚未配置 MCP Token，请先接入`);
    }

    const client = this.getClient(row);
    await client.initialize();
    const remoteTools = await client.listTools();
    await this.applyRemoteTools(row, remoteTools);

    const updated = await this.deps.repo.markSynced(serverId, remoteTools.length);
    return toServerDto(updated ?? row);
  }

  /** 断开：停用配置并注销该服务器的全部同步工具（预设保留档案可重新接入） */
  async disconnectServer(serverId: string): Promise<McpServerDto> {
    const row = await this.requireServer(serverId);
    await this.unregisterServerTools(serverId);
    await this.deps.repo.setEnabled(serverId, false);
    await this.deps.repo.setStatus(serverId, "disconnected");
    const updated = await this.deps.repo.getServer(serverId);
    return toServerDto(updated ?? row);
  }

  /**
   * API 启动恢复：tool_registrations 持久化但 handler 在进程内，重启后按
   * 已启用服务器的存量注册行重新挂代理 handler（不触网，失败静默——下次
   * 手动/接入同步即可修复）。
   */
  async restoreOnStartup(): Promise<void> {
    const enabled = await this.deps.repo.listEnabledServers();
    for (const row of enabled) {
      const prefix = `mcp__${row.id}__`;
      const tools = (await this.deps.toolRuntime.listTools()).filter((tool) =>
        tool.id.startsWith(prefix),
      );
      for (const tool of tools) {
        this.registerProxyHandler(row.id, tool.id.slice(prefix.length));
      }
    }
  }

  /** 获取（或重建）服务器对应的 MCP 客户端 */
  private getClient(row: McpServerModel): McpHttpClient {
    const cached = this.clients.get(row.id);
    if (cached && cached.matches(row.endpointUrl, row.token)) return cached;
    const client = new McpHttpClient({
      endpointUrl: row.endpointUrl,
      token: row.token,
      fetchImpl: this.deps.fetchImpl,
    });
    this.clients.set(row.id, client);
    return client;
  }

  /** 调用远程工具（供 handler 代理；安全级别与授权已在 ToolRuntime 强制） */
  private async callRemote(
    serverId: string,
    toolName: string,
    args: unknown,
  ): Promise<unknown> {
    const row = await this.requireServer(serverId);
    if (row.enabled !== 1) {
      throw new McpUpstreamError(`MCP 服务器 ${serverId} 已断开，无法调用工具 ${toolName}`);
    }
    const client = this.getClient(row);
    await client.initialize();
    return client.callTool(toolName, args);
  }

  private registerProxyHandler(serverId: string, toolName: string): void {
    this.deps.toolRuntime.registerHandler(mcpToolId(serverId, toolName), {
      call: async (_tenant, args) => this.callRemote(serverId, toolName, args),
    });
  }

  /** 把远程工具清单落注册表（幂等），并注销远端已下线的工具 */
  private async applyRemoteTools(row: McpServerModel, remoteTools: McpRemoteTool[]): Promise<void> {
    const seen = new Set<string>();
    for (const tool of remoteTools) {
      if (!tool.name) continue;
      const id = mcpToolId(row.id, tool.name);
      seen.add(id);
      await this.deps.toolRuntime.registerTool({
        id,
        name: id,
        description: tool.description ?? `${row.name} 工具 ${tool.name}`,
        category: "external",
        safetyLevel: classifyToolSafety(tool.name),
        inputSchema: tool.inputSchema,
        builtin: false,
        pluginId: `mcp:${row.id}`,
        priority: 50,
      });
      this.registerProxyHandler(row.id, tool.name);
    }

    const prefix = `mcp__${row.id}__`;
    const existing = await this.deps.toolRuntime.listTools();
    for (const tool of existing) {
      if (tool.id.startsWith(prefix) && !seen.has(tool.id)) {
        await this.deps.toolRuntime.unregisterTool(tool.id);
      }
    }
  }

  private async unregisterServerTools(serverId: string): Promise<void> {
    const prefix = `mcp__${serverId}__`;
    const tools = await this.deps.toolRuntime.listTools();
    for (const tool of tools) {
      if (tool.id.startsWith(prefix)) {
        await this.deps.toolRuntime.unregisterTool(tool.id);
      }
    }
  }

  private async requireServer(serverId: string): Promise<McpServerModel> {
    const row = await this.deps.repo.getServer(serverId);
    if (!row) throw new NotFoundError(`MCP 服务器未接入：${serverId}`);
    return row;
  }
}
