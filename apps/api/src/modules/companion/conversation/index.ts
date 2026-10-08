import { loadApiConfig } from "@aervox/config";
import { createBroadcastingStore } from "./broadcasting-store.js";
/**
 * Aervox｜思隅 @aervox/api — 对话模块入口
 *
 * 自管仓储实例化：本模块唯一对外入口，业务路由不依赖任何全局容器。
 * 阶段 2d/2e/5c：ToolRuntime / LLMConfigService / workflows 等共享依赖由
 * 模块上下文（ModuleContext）提供（tools/llm 模块在其之前注册并填充）。
 */
import type { ModuleContext } from "../../context.js";
import {
  SqliteAgentInboxRepository,
  SqliteConversationRepository,
  SqliteExtensionRepository,
  SqliteLearningRepository,
  SqlitePlatformRepository,
  SqlitePluginConfigRepository,
  SqlitePrivacyRepository,
  SqliteSkillRegistryRepository,
  SqliteSubagentRunRepository,
  SqliteUserQuestionRepository,
} from "@aervox/repositories";
import { createSqliteSubagentPort, createSqliteResumeSource, resumeCommittedTurns, SqliteExecutionStore } from "@aervox/host-agent";
import { buildLoopProvider } from "./llm-adapter.js";
import { registerConversationRoutes } from "./routes.js";
import { UserQuestionCoordinator } from "./user-question-coordinator.js";

export function registerConversationModule(ctx: ModuleContext): void {
  const {
    app,
    db,
    toolRuntime,
    llmConfigService,
    safetyService,
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
  const extensionRepo = new SqliteExtensionRepository(db);
  const pluginConfigRepo = new SqlitePluginConfigRepository(db);
  const userQuestionCoordinator = new UserQuestionCoordinator(
    conversationRepo,
    // 缺陷 C：挂起提问持久化到 pending_user_questions，进程重启后仍可作答/查询
    new SqliteUserQuestionRepository(db),
  );
  // Startup recovery competes via the same fencing CAS as Worker recovery. A finalized attempt is never revived.
  if (loadApiConfig().loopResume === "local-results") {
    const controller = new AbortController();
    const local = { workspaceId: "local", subjectUserId: "local" };
    let recovery: Promise<unknown> | undefined;
    app.addHook("onReady", async () => {
      recovery = resumeCommittedTurns({
        source: createSqliteResumeSource({ repo: conversationRepo, client: ctx.client }),
        createStore: () => createBroadcastingStore(new SqliteExecutionStore(conversationRepo, local)),
        createProvider: (turn, control) => buildLoopProvider(local, llmConfigService, {
          requireLocalOnly: control.localProcessingOnly, sessionId: turn.sessionId, turnId: turn.turnId,
          modelRoutingService: ctx.modelRoutingService,
        }),
        deletionGate: { isBlocked: () => privacyRepo.hasPendingDeletionRequest(local) },
        signal: controller.signal,
      }).catch(error => app.log.error({ err: error }, "startup resume failed"));
    });
    app.addHook("onClose", async () => { controller.abort(); await recovery; });
  }
  registerConversationRoutes(app, conversationRepo, {
    toolRuntime,
    llmConfigService,
    modelRoutingService: ctx.modelRoutingService,
    safetyService,
    privacyRepo,
    extensionRepo,
    pluginConfigRepo,
    pluginRegistry: ctx.pluginRegistry,
    inboxRepo: new SqliteAgentInboxRepository(db),
    // 5b：Skill 渐进披露（activeOnly 清单 → name+description）
    skillLoader: async () =>
      (await skillRepo.listSkills(true)).map((s) => ({
        name: s.name,
        description: s.description,
      })),
    // 人格提示词摘要：激活人格时由其覆盖系统默认名称/设定并约束技能白名单。
    // persona 模块在 conversation 之后注册，这里惰性读取 ctx；读取失败按无人格兜底。
    personaLoader: async (tenant) => {
      try {
        return await ctx.personaService?.describeActivePersonaSummary(tenant);
      } catch {
        return undefined;
      }
    },
    // 5c：Subagent 委托执行器（request 级 tenant 绑定；子任务独立 turn/attempt 落库审计）
    subagentFactory: (tenant) =>
      createSqliteSubagentPort({
        ctx: tenant,
        store: new SqliteExecutionStore(conversationRepo, tenant),
        conversationRepo,
        runRepo: subagentRunRepo,
        providerBuilder: (input) => buildLoopProvider(tenant, llmConfigService, {
          requireLocalOnly: input.controlContext?.localProcessingOnly,
          sessionId: input.sessionId, turnId: input.turnId, modelRoutingService: ctx.modelRoutingService,
        }),
      }),
    subagentRunRepo,
    workflows,
    platformRepo,
    userQuestionCoordinator,
    // CR-060：第一方插件工具贡献（注册单元由 plugins 模块在装配后填充，故惰性读取；
    // 宿主服务工厂由组合根提供，按 request 级本地上下文产出窄端口）
    pluginRegistrations: () => ctx.pluginRegistrations,
    pluginHostServices: ctx.pluginHostServices,
    proactiveActionAuthorizer,
    proactiveRepository,
    memoryRecall: ctx.memoryRecall,
    observability: ctx.observability,
  });
}
