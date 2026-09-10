/**
 * Aervox｜思隅 @aervox/repositories — mcp-server 仓储类型（自 types.ts 机械拆分）
 */
import type { McpServerModel } from "./tool-registry.js";

export interface IMcpServerRepository {
  /** 写入/更新服务器连接配置（幂等：同 id 覆盖，token 未提供时保留原值） */
  upsertServer(server: {
    id: string;
    name: string;
    transport: string;
    endpointUrl: string;
    authType: string;
    token?: string | null;
    enabled?: boolean;
    isPreset?: boolean;
  }): Promise<McpServerModel>;
  getServer(id: string): Promise<McpServerModel | null>;
  listServers(): Promise<McpServerModel[]>;
  listEnabledServers(): Promise<McpServerModel[]>;
  setToken(id: string, token: string | null): Promise<McpServerModel | null>;
  setEnabled(id: string, enabled: boolean): Promise<McpServerModel | null>;
  /** 更新连接状态（connected / error / disconnected；error 时附原因） */
  setStatus(id: string, status: string, lastError?: string | null): Promise<McpServerModel | null>;
  /** 记录一次成功同步（时间 + 工具数，清空 lastError） */
  markSynced(id: string, toolCount: number): Promise<McpServerModel | null>;
  /** 删除服务器配置（预设不可删，由调用方把关） */
  deleteServer(id: string): Promise<boolean>;
}

export interface PersonaModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  name: string;
  description: string;
  source: string; // "builtin" | "user_created" | "imported"
  status: string; // "active" | "archived"
  /** 模板审核状态：draft | pending_review | approved | rejected */
  reviewStatus: string;
  /** 审核备注 */
  reviewNotes: string;
  /** 审核时间 ISO-8601 */
  reviewedAt: string | null;
  currentRevisionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillRegistrationModel {
  /** 技能唯一标识（即目录名） */
  id: string;
  name: string;
  description: string;
  /** local / plugin / ai_authored */
  source: string;
  /** 0 | 1 */
  active: number;
  /** 0 | 1 */
  readonly: number;
  version: string;
  checksum?: string | null;
  pluginId?: string | null;
  /** AST-04 条件门控（JSON 数组） */
  gatingConditionsJson?: unknown;
  contentPath?: string | null;
  lastUsedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersonaRevisionModel {
  id: string;
  personaId: string;
  revision: number;
  config: unknown; // PersonaRevisionConfig（JSON）
  checksum: string;
  createdAt: string;
}

export interface ActivePersonaSelectionModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  personaId: string;
  revisionId: string;
  selectedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillPayloadModel {
  payloadRef: string;
  kind: string;
  content: unknown;
  checksum?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkillCandidateModel {
  candidateId: string;
  skillKey: string;
  /** { turnIds, memoryIds, learningItemIds } */
  sourceEvidence: { turnIds: string[]; memoryIds: string[]; learningItemIds: string[] };
  payloadRef?: string | null;
  scenarioKey?: string | null;
  /** pending / evaluated / promoted / rejected */
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillReleaseModel {
  releaseId: string;
  skillKey: string;
  /** canary / stable */
  stage: string;
  candidateId: string;
  payloadRef?: string | null;
  version: number;
  /** 0 | 1 */
  active: number;
  /** 0 | 1 */
  syncedToLocal: number;
  createdAt: string;
  updatedAt: string;
}

export interface PersonaTurnContextModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  turnId: string;
  personaId: string;
  revisionId: string;
  revisionChecksum: string;
  promptChecksum: string;
  skillChecksums: string[];
  mcpToolIds: string[];
  voice?: unknown;
  createdAt: string;
}

export interface PersonaSwitchLogModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  personaId: string;
  revisionId: string;
  previousPersonaId: string | null;
  previousRevisionId: string | null;
  switchReason: string; // "user_initiated" | "rollback" | "system_default"
  regressionNotes: string | null;
  switchedAt: string;
}

export interface PersonaMemoryScopeModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  personaId: string;
  memoryPolicy: string; // "isolated" | "shared"
  sharedPersonaIds: string[];
  sharedCategories: string[]; // "learning" | "preference" | "diary" | "fact"
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
