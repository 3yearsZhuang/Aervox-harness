/**
 * Aervox｜思隅 @aervox/api — 工具运行时（T-04 接线）
 *
 * 把 tool_registrations（注册表）与具体 handler 绑定，向 AI 运行时提供
 * listTools / exportRegistry / callTool 入口。PET-05 安全级别在调用侧强制：
 * - read_only：AI 可自主调用；
 * - write_with_approval：必须显式传 approval=true（模型请求 ≠ 授权）；
 * - privileged：仅管理员透传（本运行时一律拒绝，交由管理员通道）。
 *
 * 规则依据：docs/explanation/reference-design-transfer.md §3.4 / §4.11。
 */
import {
  SqliteMemoryRepository,
  SqliteMemoryEmbeddingRepository,
  SqliteToolRegistryRepository,
  type ToolRegistrationModel,
  type TenantContext,
} from "@aervox/database";
import type { Client } from "@libsql/client";
import type { MemoryEmbeddingProvider } from "./embedding-provider.js";
import { MemoryStoreTool } from "./memory-store-tool.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";

/** 工具调用处理器：入参已过注册表校验，返回结果由调用方编码 */
export interface ToolHandler {
  call(
    tenant: TenantContext,
    args: unknown,
    context: { approval: boolean; proactiveAuthorization: boolean },
  ): Promise<unknown>;
}

/** 运行时构造依赖 */
export interface ToolRuntimeDeps {
  registry: SqliteToolRegistryRepository;
  memoryRepo: SqliteMemoryRepository;
  embeddingRepo: SqliteMemoryEmbeddingRepository;
  client: Client;
  embeddingProvider?: MemoryEmbeddingProvider | null;
}

export class ToolRuntime {
  private handlers = new Map<string, ToolHandler>();
  /** 注册的内置工具定义（注册表在启动时同步写入） */
  private readonly builtinTools: ToolRegistrationModel[] = [];

  constructor(private readonly deps: ToolRuntimeDeps) {
    // 注册内置 MemoryStoreTool（同 ToolDefinition 形态交由注册表持久化）
    this.handlers.set("aervox_memory_store", {
      call: (tenant, args) => new MemoryStoreTool(deps).run(tenant, args as never),
    });
  }

  /** 补充插件/扩展 handler（工具注册表条目需另行 registerTool 持久化） */
  registerHandler(toolId: string, handler: ToolHandler): void {
    this.handlers.set(toolId, handler);
  }

  /** 列出全部已注册工具（注册表数据） */
  async listTools(): Promise<ToolRegistrationModel[]> {
    return this.deps.registry.listTools();
  }

  /** 注册工具（幂等，enabled 保持） */
  async registerTool(tool: Parameters<SqliteToolRegistryRepository["registerTool"]>[0]) {
    return this.deps.registry.registerTool(tool);
  }

  /** 启停工具 */
  async setEnabled(id: string, enabled: boolean) {
    return this.deps.registry.setEnabled(id, enabled);
  }

  /** 注销工具（内置工具拒绝） */
  async unregisterTool(id: string) {
    return this.deps.registry.unregisterTool(id);
  }

  /** 导出运行时可调用快照（enabled + 门控过滤） */
  async exportRegistry(options?: {
    disabledToolIds?: string[];
    category?: string;
  }): Promise<ToolRegistrationModel[]> {
    return this.deps.registry.exportRegistry({
      disabledToolIds: options?.disabledToolIds,
      category: options?.category,
      gatingEvaluator: (condition) => defaultGatingEvaluator(condition),
    });
  }

  /** 调用工具：安全级别 + handler 存在性双重检查 */
  async callTool(
    tenant: TenantContext,
    toolId: string,
    args: unknown,
    opts: { approval?: boolean; proactiveAuthorization?: boolean } = {},
  ): Promise<unknown> {
    const tool = await this.deps.registry.getTool(toolId);
    if (!tool) throw new NotFoundError(`tool not found: ${toolId}`);
    if (tool.enabled !== 1) throw new ForbiddenError(`tool disabled: ${toolId}`);

    // PET-05：非只读工具必须显式授权
    if ((tool.safetyLevel ?? "write_with_approval") !== "read_only" && !opts.approval) {
      throw new ForbiddenError(`tool requires approval: ${toolId}（write_with_approval / privileged）`);
    }

    const handler = this.handlers.get(toolId);
    if (!handler) throw new ForbiddenError(`tool handler not registered: ${toolId}`);
    return handler.call(tenant, args, {
      approval: opts.approval === true,
      proactiveAuthorization: opts.proactiveAuthorization === true,
    });
  }
}

/** 默认 AST-04 门控求值（生产接线处；equals/in/truthy 基础实现） */
export function defaultGatingEvaluator(condition: {
  field: string;
  operator: string;
  value?: unknown;
  evaluatorId?: string;
}): boolean {
  switch (condition.operator) {
    case "truthy":
      return !!condition.value;
    case "equals":
      return condition.value !== undefined && condition.value !== null;
    case "in":
      return Array.isArray(condition.value) && condition.value.length > 0;
    case "custom":
      return false; // custom 需注入真实求值器
    default:
      return true;
  }
}
