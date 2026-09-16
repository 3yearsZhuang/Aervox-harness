/**
 * Aervox｜思隅 @aervox/repositories — persona 仓储类型（自 types.ts 机械拆分）
 */
import type { ActivePersonaSelectionModel, PersonaMemoryScopeModel, PersonaModel, PersonaRevisionModel, PersonaSwitchLogModel, PersonaTurnContextModel } from "./mcp-server.js";
import type { LocalContext } from "../../local-context.js";

export interface IPersonaRepository {
  listPersonas(ctx: LocalContext): Promise<PersonaModel[]>;
  getPersona(ctx: LocalContext, personaId: string): Promise<PersonaModel | null>;
  listPersonaRevisions(ctx: LocalContext, personaId: string): Promise<PersonaRevisionModel[]>;
  getPersonaRevision(
    ctx: LocalContext,
    personaId: string,
    revisionId?: string,
  ): Promise<PersonaRevisionModel | null>;
  /** 按全局唯一 personaId 读取修订（personaId 为 UUID，租户不参与过滤；仅供模块适配器使用） */
  getPersonaRevisionById(personaId: string, revisionId?: string): Promise<PersonaRevisionModel | null>;
  createPersona(
    ctx: LocalContext,
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
    ctx: LocalContext,
    data: {
      personaId: string;
      expectedRevision: number;
      name?: string;
      description?: string;
      config: unknown;
      checksum: string;
    },
  ): Promise<{ persona: PersonaModel; revision: PersonaRevisionModel } | null>;
  deletePersona(ctx: LocalContext, personaId: string): Promise<boolean>;
  activatePersona(
    ctx: LocalContext,
    personaId: string,
    revisionId?: string,
  ): Promise<ActivePersonaSelectionModel | null>;
  getActivePersona(ctx: LocalContext): Promise<ActivePersonaSelectionModel | null>;
  saveTurnContext(ctx: LocalContext, context: PersonaTurnContextModel): Promise<PersonaTurnContextModel>;
  getTurnContext(ctx: LocalContext, turnId: string): Promise<PersonaTurnContextModel | null>;

  // ---- CAP-019 扩展：模板审核、切换日志、回滚、记忆范围 ----

  /** 更新人格审核状态 */
  reviewPersona(
    ctx: LocalContext,
    personaId: string,
    reviewStatus: "pending_review" | "approved" | "rejected",
    reviewNotes?: string,
  ): Promise<PersonaModel | null>;

  /** 回滚人格到指定修订（更新 currentRevisionId，不删除修订历史） */
  rollbackPersona(
    ctx: LocalContext,
    personaId: string,
    revisionId: string,
  ): Promise<{ persona: PersonaModel; revision: PersonaRevisionModel } | null>;

  /** 记录人格切换日志 */
  recordSwitchLog(
    ctx: LocalContext,
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
    ctx: LocalContext,
    personaId?: string,
  ): Promise<PersonaSwitchLogModel[]>;

  /** 获取人格记忆范围配置 */
  getMemoryScope(ctx: LocalContext, personaId: string): Promise<PersonaMemoryScopeModel | null>;

  /** 更新或创建人格记忆范围配置 */
  upsertMemoryScope(
    ctx: LocalContext,
    personaId: string,
    data: {
      memoryPolicy: "isolated" | "shared";
      sharedPersonaIds?: string[];
      sharedCategories?: string[];
      confirmedAt?: string | null;
    },
  ): Promise<PersonaMemoryScopeModel>;
}
