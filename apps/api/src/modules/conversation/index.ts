/**
 * Aervox｜思隅 @aervox/api — 对话模块入口
 *
 * 自管仓储实例化：本模块唯一对外入口，业务路由不依赖任何全局容器。
 * 阶段 2d：可注入 ToolRuntime 作为 Agent Loop 的只读工具提供者（缺失时 fail-closed）。
 */
import type { FastifyInstance } from "fastify";
import {
  SqliteAgentInboxRepository,
  SqliteConversationRepository,
  SqlitePrivacyRepository,
  SqliteSkillRegistryRepository,
  SqliteSubagentRunRepository,
} from "@aervox/database";
import type { AervoxDatabase } from "@aervox/database";
import { createSqliteSubagentPort, SqliteExecutionStore } from "@aervox/host-agent";
import type { WorkflowDefinition } from "@aervox/agent-loop";
import type { ToolRuntime } from "../tools/runtime.js";
import type { LLMConfigService } from "../llm/service.js";
import { buildLoopProvider } from "./agent-executor.js";
import { registerConversationRoutes } from "./routes.js";

export interface RegisterConversationModuleOptions {
  /** Agent Loop 只读工具提供者（阶段 2d，可选） */
  toolRuntime?: ToolRuntime;
  /** 阶段 2e：AERVOX_LOOP_PROVIDER=llm 时的模型配置来源（CR-015） */
  llmConfigService?: LLMConfigService;
  /** 阶段 5c：已注册 Workflow 定义清单（缺省无；贡献 workflow.run 工具 + GET /v1/workflows） */
  workflows?: WorkflowDefinition[];
}

export function registerConversationModule(
  app: FastifyInstance,
  db: AervoxDatabase,
  options: RegisterConversationModuleOptions = {},
): void {
  const conversationRepo = new SqliteConversationRepository(db);
  const privacyRepo = new SqlitePrivacyRepository(db);
  const skillRepo = new SqliteSkillRegistryRepository(db);
  const subagentRunRepo = new SqliteSubagentRunRepository(db);
  registerConversationRoutes(app, conversationRepo, {
    toolRuntime: options.toolRuntime,
    llmConfigService: options.llmConfigService,
    privacyRepo,
    inboxRepo: new SqliteAgentInboxRepository(db),
    // 5b：Skill 渐进披露（activeOnly 清单 → name+description）
    skillLoader: async () =>
      (await skillRepo.listSkills(true)).map((s) => ({
        name: s.name,
        description: s.description,
      })),
    // 5c：Subagent 委托执行器（request 级 tenant 绑定；子任务独立 turn/attempt 落库审计）
    subagentFactory: (tenant) =>
      createSqliteSubagentPort({
        tenant,
        store: new SqliteExecutionStore(conversationRepo, tenant),
        conversationRepo,
        runRepo: subagentRunRepo,
        providerBuilder: () => buildLoopProvider(tenant, options.llmConfigService),
      }),
    subagentRunRepo,
    workflows: options.workflows,
  });
}