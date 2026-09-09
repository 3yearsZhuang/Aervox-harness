/**
 * Aervox｜思隅 @aervox/repositories — persona 仓储类型（自 types.ts 机械拆分）
 */
import type { ActivePersonaSelectionModel, PersonaMemoryScopeModel, PersonaModel, PersonaRevisionModel, PersonaSwitchLogModel, PersonaTurnContextModel } from "./mcp-server.js";
import type { TenantContext } from "../../tenant.js";

export interface IPersonaRepository {
  listPersonas(tenant: TenantContext): Promise<PersonaModel[]>;
  getPersona(tenant: TenantContext, personaId: string): Promise<PersonaModel | null>;
  listPersonaRevisions(tenant: TenantContext, personaId: string): Promise<PersonaRevisionModel[]>;
  getPersonaRevision(
    tenant: TenantContext,
    personaId: string,
    revisionId?: string,
  ): Promise<PersonaRevisionModel | null>;
  /** 按全局唯一 personaId 读取修订（personaId 为 UUID，租户不参与过滤；仅供模块适配器使用） */
  getPersonaRevisionById(personaId: string, revisionId?: string): Promise<PersonaRevisionModel | null>;
  createPersona(
    tenant: TenantContext,
    data: {
      id: string;
      name: string;
      description?: string;
      source?: string;
      config: unknown;
      checksum: string;
    },
  ): Promise<{ persona: PersonaModel; revision: PersonaRevisionModel }>;
  updatePersona(
    tenant: TenantContext,
    data: {
      personaId: string;
      expectedRevision: number;
      name?: string;
      description?: string;
      config: unknown;
      checksum: string;
    },
  ): Promise<{ persona: PersonaModel; revision: PersonaRevisionModel } | null>;
  deletePersona(tenant: TenantContext, personaId: string): Promise<boolean>;
  activatePersona(
    tenant: TenantContext,
    personaId: string,
    revisionId?: string,
  ): Promise<ActivePersonaSelectionModel | null>;
  getActivePersona(tenant: TenantContext): Promise<ActivePersonaSelectionModel | null>;
  saveTurnContext(tenant: TenantContext, context: PersonaTurnContextModel): Promise<PersonaTurnContextModel>;
  getTurnContext(tenant: TenantContext, turnId: string): Promise<PersonaTurnContextModel | null>;

  // ---- CAP-019 扩展：模板审核、切换日志、回滚、记忆范围 ----

  /** 更新人格审核状态 */
  reviewPersona(
    tenant: TenantContext,
    personaId: string,
    reviewStatus: "pending_review" | "approved" | "rejected",
    reviewNotes?: string,
  ): Promise<PersonaModel | null>;

  /** 回滚人格到指定修订（更新 currentRevisionId，不删除修订历史） */
  rollbackPersona(
    tenant: TenantContext,
    personaId: string,
    revisionId: string,
  ): Promise<{ persona: PersonaModel; revision: PersonaRevisionModel } | null>;

  /** 记录人格切换日志 */
  recordSwitchLog(
    tenant: TenantContext,
    data: {
      personaId: string;
      revisionId: string;
      previousPersonaId?: string | null;
      previousRevisionId?: string | null;
      switchReason?: string;
      regressionNotes?: string | null;
    },
  ): Promise<PersonaSwitchLogModel>;

  /** 获取人格切换历史 */
  getSwitchHistory(
    tenant: TenantContext,
    personaId?: string,
  ): Promise<PersonaSwitchLogModel[]>;

  /** 获取人格记忆范围配置 */
  getMemoryScope(tenant: TenantContext, personaId: string): Promise<PersonaMemoryScopeModel | null>;

  /** 更新或创建人格记忆范围配置 */
  upsertMemoryScope(
    tenant: TenantContext,
    personaId: string,
    data: {
      memoryPolicy: "isolated" | "shared";
      sharedPersonaIds?: string[];
      sharedCategories?: string[];
      confirmedAt?: string | null;
    },
  ): Promise<PersonaMemoryScopeModel>;
}
