/**
 * Aervox｜思隅 @aervox/api — 会话回合编排（runLoopTurnOnce）
 *
 * ADR-020 / ITER-026 演进最终态：
 * 1. 业务与跨切面逻辑（遥测、危机干预、伴学插件生命周期、主动智能画像）完全下沉为 TurnMiddleware；
 * 2. 上下文构建（历史、记忆召回、技能披露、提示词、规则压缩）收敛于 assembleConversationContextBuilder；
 * 3. 工具组合（静态 Contribution、动态 ToolRuntime、L1/L2 阶梯安全门）收敛于 assembleConversationTools；
 * 4. 存储与直推桥收敛于 createConversationExecutionStore；
 * 5. 执行器自身代码行数收敛 55% 以上，聚焦于纯粹的 LLM + 工具多轮驱动编排。
 */
import {
  executeTurn,
  ControlContext,
  type InboxPort,
  type ModelProviderPort,
  type PracticeAttemptPort,
  type SkillDescriptor,
  type SubagentPort,
  type ToolProviderPort,
  type UserQuestionPort,
  type WorkflowDefinition,
} from "@aervox/agent-loop";
import type { TurnMiddlewareContext, TurnMiddleware } from "@aervox/host-agent";
import {
  type AervoxDatabase,
  type IExtensionRepository,
  type IPluginConfigRepository,
  type IProactiveProfileRepository,
  type SqliteConversationRepository,
  type LocalContext,
  SqliteExtensionRepository,
} from "@aervox/repositories";
import type { Observability } from "@aervox/observability";
import {
  defaultServerPluginRegistry,
  type ServerPluginRegistry,
} from "../../ecosystem/plugins/turn-plugins/index.js";
import type { ToolRuntimePort as ToolRuntime } from "../../ecosystem/tools/index.js";
import type { LLMConfigService } from "../../ecosystem/llm/service.js";
import type { LlmDegradationService } from "../../ecosystem/llm/degradation-service.js";
import type { ProactiveActionAuthorizer } from "../../proactive/proactive/action-authorizer.js";
import type { MemoryRecallPort } from "./memory-recall.js";
import { buildLoopProvider, createLLMCallable } from "./llm-adapter.js";
import { assembleConversationTools } from "./tool-providers.js";
import { createConversationExecutionStore } from "./broadcasting-store.js";
import { failTurnWithError, executeDshTurnIfEnabled } from "./dsh-adapter.js";
import {
  assembleConversationPipeline,
  PIPELINE_ATTR_EXTRA_SECTIONS,
  PIPELINE_ATTR_PROACTIVE_PROMPT,
  PIPELINE_ATTR_LLM_CALLABLE,
} from "./pipeline-middlewares.js";
import { assembleConversationContextBuilder } from "./context-builder.js";

export interface RunLoopTurnInput {
  turnId: string;
  sessionId: string;
  attemptId: string;
  userMessage: string;
  metadata?: Record<string, unknown>;
  /** BTD-05 / ITER-007：统一执行控制上下文 */
  controlContext?: ControlContext;
  /** 请求级或底层取消信号 */
  signal?: AbortSignal;
}

export interface RunLoopTurnDeps {
  toolRuntime?: ToolRuntime;
  llmConfigService?: LLMConfigService;
  /** CR-034 模型降级与健康路由决策服务 */
  modelRoutingService?: LlmDegradationService;
  /** CAP-008：安全与危机干预服务（危急阻断/资源注入/中度困扰支持） */
  safetyService?: import("../../platform/safety/service.js").SafetyService;
  /** 2d：删除/撤权水位未追平 → Loop fail-closed（AVX-HAR-001 §11.3） */
  deletionGate?: import("@aervox/agent-loop").DeletionGatePort;
  /** 5a-2：受控收件箱消费（每 Step claim next-step → 注入 → ack；缺失时跳过） */
  inbox?: InboxPort;
  /** 5b：渐进披露的 Skill 清单（name+description；模型按需读取全文；缺省不注入） */
  skills?: SkillDescriptor[];
  /** 当前激活人格摘要：名称/设定/技能白名单优先于系统默认（无人格时不注入） */
  persona?: { name?: string; prompt?: string; allowedSkillNames?: string[] };
  /**
   * 5c：Subagent 委托执行器工厂（request 级 tenant 绑定后创建 SubagentPort）。
   * 注入时 `subagent_delegate` 进入工具清单；缺失则不被贡献（行为与既有一致）。
   */
  subagentFactory?: (tenant: LocalContext) => SubagentPort;
  /** 5c：已注册 Workflow 定义清单（贡献 `workflow_run` 工具 + GET /v1/workflows 元数据） */
  workflows?: WorkflowDefinition[];
  /**
   * 阶段 7：ModelRun/ContextManifest 落库口（可选委托 SqlitePlatformRepository；
   * 缺省不记录，兼容既有行为）。Step 级可追溯写入不进 Loop 控制流。
   */
  platformRepo?: import("@aervox/repositories").SqlitePlatformRepository;
  /** UQ-01：向用户提问协调端口（挂起与唤醒） */
  userQuestionPort?: UserQuestionPort;
  /** CAP-016：刷题模式作答落库端口（AI 判定后写 questions + question_attempts） */
  practiceAttemptPort?: PracticeAttemptPort;
  /** CAP-033：主动智能全动作授权与本地动作账本。 */
  proactiveActionAuthorizer?: ProactiveActionAuthorizer;
  /** CAP-033：本地画像声明来源；仅在有效且本地模型准入时注入。 */
  proactiveRepository?: IProactiveProfileRepository;
  /** CAP-005：普通长期记忆 FTS + 向量混合召回。 */
  memoryRecall?: MemoryRecallPort;
  /** 插件仓储：用于检查插件启用状态 */
  extensionRepo?: IExtensionRepository;
  /** 插件配置仓储：读取插件运行时配置 */
  pluginConfigRepo?: IPluginConfigRepository;
  /** 服务端插件注册表（提供回合插件生命周期与别名解析，默认回退全局单例） */
  pluginRegistry?: ServerPluginRegistry;
  /** 全链路可观测性门面（结构化日志与指标采集） */
  observability?: Observability;
  /** BTD-05 / ITER-007: 执行控制截止时间（ms） */
  turnTimeoutMs?: number;
  /** 自定义工具 Contribution 清单 */
  toolContributions?: ToolProviderPort[];
  /** 额外中间件 */
  extraMiddlewares?: TurnMiddleware[];
}

/**
 * 迁移期接线：创建 Turn 后立即执行一次 Loop。
 * Provider 选择见 buildLoopProvider；工具来源经 compose 合并（runtime / subagent / workflow Contribution）。
 */
export async function runLoopTurnOnce(
  repo: SqliteConversationRepository,
  tenant: LocalContext,
  input: RunLoopTurnInput,
  deps: RunLoopTurnDeps = {},
): Promise<void> {
  const control =
    input.controlContext ??
    new ControlContext({
      turnId: input.turnId,
      attemptId: input.attemptId,
      sessionId: input.sessionId,
      abortSignal: input.signal,
      deadlineEpochMs: deps.turnTimeoutMs ? Date.now() + deps.turnTimeoutMs : undefined,
    });

  let middlewareCtx: TurnMiddlewareContext | undefined;
  try {
    const repoDb = (repo as unknown as { db?: AervoxDatabase })?.db;
    const extRepo =
      deps.extensionRepo ??
      (repoDb ? new SqliteExtensionRepository(repoDb) : null);
    const pluginRegistry = deps.pluginRegistry ?? defaultServerPluginRegistry;

    // 阶段 7（ADR-017）+ CR-031 实时流式直推执行存储
    const broadcastingStore = createConversationExecutionStore(repo, tenant, deps.platformRepo);

    // 组装洋葱执行管道 (ExecutionPipeline)
    const pipeline = assembleConversationPipeline({
      observability: deps.observability,
      safetyService: deps.safetyService,
      repo,
      tenant,
      broadcastingStore,
      pluginRegistry,
      extensionRepo: extRepo,
      pluginConfigRepo: deps.pluginConfigRepo,
      proactiveRepository: deps.proactiveRepository,
      extraMiddlewares: deps.extraMiddlewares,
    });

    middlewareCtx = {
      turnId: input.turnId,
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      userMessage: input.userMessage,
      metadata: input.metadata,
      controlContext: control,
      attributes: new Map<string, unknown>(),
    };

    await pipeline.execute(middlewareCtx, async (ctx) => {
      // 1. ADR-010 阶段 6f：AERVOX_LOOP_DRIVER=dsh 进程外 Adapter 分支
      const dshResult = await executeDshTurnIfEnabled(repo, tenant, broadcastingStore, ctx, {
        llmConfigService: deps.llmConfigService,
      });
      if (dshResult) {
        return dshResult;
      }

      // 2. 解析模型 Provider 并适配 LLMCallable
      let provider: ModelProviderPort;
      try {
        provider = await buildLoopProvider(tenant, deps.llmConfigService, {
          requireLocalOnly: ctx.controlContext.localProcessingOnly,
          sessionId: input.sessionId,
          turnId: input.turnId,
          modelRoutingService: deps.modelRoutingService,
          persona: deps.persona ? { name: deps.persona.name } : undefined,
        });
        const llm = createLLMCallable(provider);
        ctx.attributes.set(PIPELINE_ATTR_LLM_CALLABLE, llm);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "provider_unavailable";
        await failTurnWithError(broadcastingStore, input.turnId, input.attemptId, errorMsg);
        return { status: "failed", attemptId: input.attemptId, reason: errorMsg };
      }

      // 3. 组装工具集合（Contribution + ToolRuntime + L1/L2 阶梯安全门禁）
      const tools = assembleConversationTools({
        tenant,
        repo,
        provider,
        toolRuntime: deps.toolRuntime,
        proactiveActionAuthorizer: deps.proactiveActionAuthorizer,
        observability: deps.observability,
        subagentFactory: deps.subagentFactory,
        workflows: deps.workflows,
        userQuestionPort: deps.userQuestionPort,
        practiceAttemptPort: deps.practiceAttemptPort,
        customContributions: deps.toolContributions,
      });

      // 4. 组装回合上下文构建器 (ContextBuilderPort)
      const extraSections = (ctx.attributes.get(PIPELINE_ATTR_EXTRA_SECTIONS) as string[] | undefined) ?? [];
      const proactiveProfilePrompt = (ctx.attributes.get(PIPELINE_ATTR_PROACTIVE_PROMPT) as string | undefined) ?? "";
      const contextBuilder = assembleConversationContextBuilder({
        repo,
        tenant,
        input,
        tools,
        persona: deps.persona,
        skills: deps.skills,
        memoryRecall: deps.memoryRecall,
        proactiveProfilePrompt,
        extraSections,
      });

      // 5. 驱动纯粹的 Agent Loop 核心多轮循环
      const routingSnapshot = (provider as unknown as { routingSnapshot?: import("@aervox/contracts").ModelRoutingSnapshot }).routingSnapshot;
      return executeTurn(
        {
          execution: broadcastingStore,
          provider,
          contextBuilder,
          tools,
          deletionGate: deps.deletionGate,
          inbox: deps.inbox,
          controlContext: ctx.controlContext,
          modelRunMeta: routingSnapshot
            ? {
                provider: routingSnapshot.providerType ?? "rule",
                modelId: routingSnapshot.modelId ?? "rule",
                purpose: `tier_${routingSnapshot.tier}:${routingSnapshot.reason}`,
              }
            : undefined,
        },
        {
          ...input,
          controlContext: ctx.controlContext,
        },
      );
    });
  } finally {
    if (!input.controlContext) {
      if (middlewareCtx && middlewareCtx.controlContext !== control) {
        middlewareCtx.controlContext.dispose();
      }
      control.dispose();
    }
  }
}
