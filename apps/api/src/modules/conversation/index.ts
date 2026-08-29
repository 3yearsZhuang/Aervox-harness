/**
 * Aervox｜思隅 @aervox/api — 对话模块入口
 *
 * 自管仓储实例化：本模块唯一对外入口，业务路由不依赖任何全局容器。
 * 阶段 2d/2e/5c：ToolRuntime / LLMConfigService / workflows 等共享依赖由
 * 模块上下文（ModuleContext）提供（tools/llm 模块在其之前注册并填充）。
 */
import type { ModuleContext } from "../context.js";
import {
  SqliteAgentInboxRepository,
  SqliteConversationRepository,
  SqliteLearningRepository,
  SqlitePlatformRepository,
  SqlitePrivacyRepository,
  SqliteSkillRegistryRepository,
  SqliteSubagentRunRepository,
  SqliteUserQuestionRepository,
} from "@aervox/database";
import { createSqliteSubagentPort, SqliteExecutionStore } from "@aervox/host-agent";
import { buildLoopProvider } from "./agent-executor.js";
import { registerConversationRoutes } from "./routes.js";
import { UserQuestionCoordinator } from "./user-question-coordinator.js";
import { createPracticeAttemptPortFactory } from "./practice-attempt-port.js";

export function registerConversationModule(ctx: ModuleContext): void {
  const {
    app,
    db,
    toolRuntime,
    llmConfigService,
    workflows,
    proactiveActionAuthorizer,
    proactiveRepository,
  } = ctx;
  const conversationRepo = new SqliteConversationRepository(db);
  const privacyRepo = new SqlitePrivacyRepository(db);
  const skillRepo = new SqliteSkillRegistryRepository(db);
  const subagentRunRepo = new SqliteSubagentRunRepository(db);
  // 阶段 7：ModelRun/ContextManifest 落库口（Step 级可追溯写入）
  const platformRepo = new SqlitePlatformRepository(db);
  const userQuestionCoordinator = new UserQuestionCoordinator(
    conversationRepo,
    // 缺陷 C：挂起提问持久化到 pending_user_questions，进程重启后仍可作答/查询
    new SqliteUserQuestionRepository(db),
  );
  registerConversationRoutes(app, conversationRepo, {
    toolRuntime,
    llmConfigService,
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
        providerBuilder: () => buildLoopProvider(tenant, llmConfigService),
      }),
    subagentRunRepo,
    workflows,
    platformRepo,
    userQuestionCoordinator,
    // CAP-016：刷题模式作答落库端口（模块自管 learning 仓储，按 request tenant 绑定）
    practiceAttemptFactory: createPracticeAttemptPortFactory(new SqliteLearningRepository(db)),
    proactiveActionAuthorizer,
    proactiveRepository,
  });
}
