/**
 * Aervox｜思隅 @aervox/repositories — tool-registry 仓储类型（自 types.ts 机械拆分）
 */
import type { ToolRegistrationModel } from "./voice-input-config.js";

export interface IToolRegistryRepository {
  /** 注册工具（幂等：同一 id 覆盖元数据，enabled 保持不变） */
  registerTool(
    tool: {
      id: string;
      name: string;
      description: string;
      category: string;
      safetyLevel?: string;
      /** B3：结果未知恢复复议声明（"never" | "safe"；省略=未声明，收敛） */
      replay?: string;
      requiredPermissions?: unknown;
      inputSchema?: unknown;
      builtin?: boolean;
      pluginId?: string | null;
      gatingConditions?: unknown;
      priority?: number;
    },
  ): Promise<ToolRegistrationModel>;
  /** 获取单个工具注册信息 */
  getTool(id: string): Promise<ToolRegistrationModel | null>;
  /** 列出所有工具 */
  listTools(): Promise<ToolRegistrationModel[]>;
  /** 启用/禁用工具（disabledToolIds 操作） */
  setEnabled(id: string, enabled: boolean): Promise<ToolRegistrationModel | null>;
  /** 注销工具（内置工具不可注销） */
  unregisterTool(id: string): Promise<boolean>;
  /**
   * 导出工具注册表快照（面向 AI 运行时 / MCP server）
   * 过滤逻辑：enabled = 1 且门控条件通过（门控求值由调用方注入 evaluator）
   */
  exportRegistry(
    options?: {
      /** 全局禁用列表（补充 per-entry enabled=false） */
      disabledToolIds?: string[];
      /** AST-04 门控求值函数（field, operator, value, context）→ boolean */
      gatingEvaluator?: (condition: {
        field: string;
        operator: string;
        value?: unknown;
        evaluatorId?: string;
      }, context?: unknown) => boolean;
      /** 门控求值上下文 */
      gatingContext?: unknown;
      /** 按分类过滤 */
      category?: string;
    },
  ): Promise<ToolRegistrationModel[]>;
}

export interface McpServerModel {
  id: string;
  name: string;
  /** streamable_http / sse（预留） */
  transport: string;
  endpointUrl: string;
  /** bearer / none */
  authType: string;
  token: string | null;
  enabled: number; // 0 | 1
  isPreset: number; // 0 | 1
  /** disconnected / connected / error */
  status: string;
  lastSyncAt: string | null;
  lastError: string | null;
  toolCount: number;
  createdAt: string;
  updatedAt: string;
}
