/**
 * Aervox｜思隅 @aervox/api — 会话回合编排（runLoopTurnOnce）
 *
 * 机械拆分（B 档第三步，零行为变更）：原「Agent Loop SQLite 执行存储适配 +
 * 工具接线」巨型文件拆为——Provider 构建与 LLMCallable 适配在 llm-adapter.ts、
 * 工具提供者在 tool-providers.ts、回放脚本在 replay-scripts.ts、SSE 广播桥在
 * broadcasting-store.ts、DSH 整 Turn 执行在 dsh-adapter.ts；本文件仅保留
 * 迁移期接线：创建 Turn 后立即执行一次 Loop（AVX-HAR-001 §13），
 * 阶段 4 抽出独立 Host 时仅替换接线。
 */
import {
  composeToolProviders,
  createComposedContextBuilder,
  createSubagentToolProvider,
  createWorkflowToolProvider,
  createAskUserQuestionToolProvider,
  createPracticeAttemptToolProvider,
  createSummaryCompaction,
  executeTurn,
} from "@aervox/agent-loop";
import type {
  InboxPort,
  ModelProviderPort,
  PracticeAttemptPort,
  SkillDescriptor,
  SubagentPort,
  ToolProviderPort,
  UserQuestionPort,
  WorkflowDefinition,
} from "@aervox/agent-loop";
import { SqliteExecutionStore } from "@aervox/host-agent";
import type { LLMCallable } from "@aervox/practice-review";
import {
  type AervoxDatabase,
  type IExtensionRepository,
  type IPluginConfigRepository,
  type IProactiveProfileRepository,
  type SqliteConversationRepository,
  type LocalContext,
  SqliteExtensionRepository,
} from "@aervox/repositories";
import { loadApiConfig } from "@aervox/config";
import type { Observability } from "@aervox/observability";
import {
  executeAfterTurnPlugins,
  executeBeforeTurnPlugins,
  defaultServerPluginRegistry,
  type ServerPluginRegistry,
  type TurnPluginContext,
} from "../../ecosystem/plugins/turn-plugins/index.js";
import type { ToolRuntime } from "../../ecosystem/tools/runtime.js";
import type { LLMConfigService } from "../../ecosystem/llm/service.js";
import type { LlmDegradationService } from "../../ecosystem/llm/degradation-service.js";
import type { ModelRoutingSnapshot } from "@aervox/contracts";
import { loadProactiveProfilePrompt } from "../../proactive/proactive/profile-context.js";
import type { ProactiveActionAuthorizer } from "../../proactive/proactive/action-authorizer.js";
import { buildMemoryContext, type MemoryRecallPort } from "./memory-recall.js";
import { buildLoopProvider, createLLMCallable } from "./llm-adapter.js";
import { createApprovalGatedToolProvider, createRuntimeToolProvider } from "./tool-providers.js";
import { createBroadcastingStore } from "./broadcasting-store.js";
import { failTurnWithError, runDshAdapterTurn } from "./dsh-adapter.js";

/** SqliteExecutionStore 组合根适配由 @aervox/host-agent 提供（见上方 import），API 不再自维护 SQLite 执行存储 */

/**
 * 迁移期接线：创建 Turn 后立即执行一次 Loop。
 * Provider 选择见 buildLoopProvider；工具来源经 compose 合并（runtime / subagent / workflow Contribution）。
 */
export async function runLoopTurnOnce(
  repo: SqliteConversationRepository,
  tenant: LocalContext,
  input: {
    turnId: string;
    sessionId: string;
    attemptId: string;
    userMessage: string;
    metadata?: Record<string, unknown>;
  },
  deps: {
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
  } = {},
): Promise<void> {
  const turnStartTime = Date.now();
  deps.observability?.metrics.emit({
    type: "counter",
    name: "agent.turn.started",
    value: 1,
  });
  deps.observability?.log.info({
    event: "agent.turn.started",
    message: `Turn ${input.turnId} started`,
    fields: {
      turnId: input.turnId,
      sessionId: input.sessionId,
      attemptId: input.attemptId,
    },
  });

  const repoDb = (repo as unknown as { db?: AervoxDatabase })?.db;
  const extRepo =
    deps.extensionRepo ??
    (repoDb ? new SqliteExtensionRepository(repoDb) : null);
  const pluginRegistry = deps.pluginRegistry ?? defaultServerPluginRegistry;

  const turnPluginCtx: TurnPluginContext = {
    turnId: input.turnId,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    userMessage: input.userMessage,
    tenant,
    repo,
    metadata: input.metadata,
  };

  const beforeTurnExec = await executeBeforeTurnPlugins(
    pluginRegistry,
    turnPluginCtx,
    extRepo,
    deps.pluginConfigRepo,
  );

  // 阶段 7（ADR-017）：Step 级 ModelRun + 每 Turn ContextManifest 快照落库（委托 platform 域）
  const store = new SqliteExecutionStore(
    repo,
    tenant,
    deps.platformRepo
      ? {
          recordModelRun: async (r) => {
            const p = deps.platformRepo!;
            await p.createModelRun(tenant, {
              id: r.runId,
              attemptId: r.attemptId,
              stepId: r.stepId,
              purpose: r.purpose,
              provider: r.provider,
              modelId: r.modelId,
            });
            await p.completeModelRun(tenant, r.runId, { status: r.status === "completed" ? "completed" : "failed", latencyMs: r.latencyMs });
          },
          recordContextManifest: async (m) => {
            const p = deps.platformRepo!;
            await p.createContextManifest({
              id: m.manifestId,
              modelRunId: m.modelRunId,
              purpose: m.purpose,
              sourceArtifactId: "turn:history",
              sourceRevisionId: "1",
              snapshot: m.snapshot,
            });
            await p.attachContextManifest(tenant, m.modelRunId, m.manifestId);
          },
        }
      : undefined,
  );
  const broadcastingStore = createBroadcastingStore(store);

  // CAP-008：前置安全门禁拦截（Crisis Safety Gate & Emotional Companionship）
  // 规则依据：PRD §4.3、§6.5、SRS FR-SAFE-001。
  // crisis_high 立即阻断 LLM 与工具调用，直推固定求助热线应答，消息脱敏（排除日记/记忆），记录安全审计；
  // distress_moderate 注入温和共情指引至 extraSections，不升级为危机，禁病理诊断与说教。
  if (deps.safetyService) {
    const safetyClassification = deps.safetyService.classify(input.userMessage);
    if (safetyClassification.level === "crisis_high") {
      deps.observability?.metrics.emit({
        type: "counter",
        name: "agent.safety.crisis_intercepted",
        value: 1,
      });
      deps.observability?.log.warn({
        event: "safety.crisis_intercepted",
        message: `Turn ${input.turnId} intercepted by crisis safety gate`,
        fields: {
          turnId: input.turnId,
          sessionId: input.sessionId,
          category: safetyClassification.category,
          matchedPatterns: safetyClassification.matchedPatterns,
        },
      });
      deps.observability?.audit.emit({
        eventType: "safety.crisis_intercepted",
        action: "intercept_crisis",
        actorId: tenant.subjectUserId ?? "system",
        scope: input.turnId,
        payload: {
          sessionId: input.sessionId,
          category: safetyClassification.category,
          policyVersion: deps.safetyService.getPolicyVersion(),
        },
      }).catch(() => undefined);

      // 1. 将当前 Turn 的用户输入消息标记为脱敏（isRedacted = 1），彻底阻断进入日记素材与长期记忆
      await repo.redactTurnMessages(tenant, input.turnId).catch(() => undefined);

      // 2. 生成固定不可篡改、不可被 Persona 或 Prompt 覆盖的地区化危机求助应答
      const crisisText = deps.safetyService.getCrisisResponse();
      const assistantMsgId = `msg_${Date.now().toString(36)}_safe`;

      // 3. 写入脱敏的助手危机回复版本（isRedacted = 1），同样绝不进入日记素材收集
      await repo.appendRedactedAssistantMessage(tenant, {
        id: assistantMsgId,
        turnId: input.turnId,
        content: crisisText,
      }).catch(() => undefined);

      // 4. 记录安全事件最小化审计记录
      await deps.safetyService.recordIncident(tenant, {
        id: `sinc_${input.turnId}`,
        category: safetyClassification.category,
        severity: "critical",
        disposition: "blocked",
        policyVersion: deps.safetyService.getPolicyVersion(),
      }).catch(() => undefined);

      // 5. 通过 broadcastingStore 广播 SSE delta + done 事件并以 Completed 终态收口
      await broadcastingStore.appendEvent({
        turnId: input.turnId,
        attemptId: input.attemptId,
        sequence: 1,
        eventType: "delta",
        data: {
          messageId: assistantMsgId,
          text: crisisText,
        },
        safetyDecision: "redacted",
        expectedFencingToken: 0,
      }).catch(() => undefined);

      await broadcastingStore.appendEvent({
        turnId: input.turnId,
        attemptId: input.attemptId,
        sequence: 2,
        eventType: "done",
        data: {
          status: "Completed",
          messageId: assistantMsgId,
          isComplete: true,
          lastSequence: 2,
        },
        safetyDecision: "approved",
        expectedFencingToken: 0,
      }).catch(() => undefined);

      await broadcastingStore.finalizeAttempt({
        turnId: input.turnId,
        attemptId: input.attemptId,
        status: "Completed",
      }).catch(() => undefined);

      await repo.updateTurnStatus(tenant, input.turnId, "Completed").catch(() => undefined);

      // 6. 立即退出：绝对阻断大模型调用、工具执行与事后插件（绝不提取记忆、术语或知识点）
      return;
    }

    if (safetyClassification.level === "distress_moderate") {
      deps.observability?.metrics.emit({
        type: "counter",
        name: "agent.safety.distress_guided",
        value: 1,
      });
      deps.observability?.log.info({
        event: "safety.distress_guided",
        message: `Turn ${input.turnId} emotional companionship distress guidance injected`,
        fields: {
          turnId: input.turnId,
          category: safetyClassification.category,
        },
      });
      // 将中度情绪困扰陪伴指引作为不可覆盖的最高优先级指引注入 extraSections
      beforeTurnExec.extraSections.unshift(deps.safetyService.getDistressGuidance());
    }
  }

  // ADR-010 阶段 6f：AERVOX_LOOP_DRIVER=dsh → 整 Turn 走 DSH 进程外 Adapter
  // （自带 Agent 循环与模型回合，Provider/工具/上下文组合全部跳过；未就绪 fail-closed 不回退 native）。
  if (loadApiConfig().loopDriver === "dsh") {
    let dshLlm: LLMCallable | undefined;
    if (deps.llmConfigService && loadApiConfig().loopProvider === "llm") {
      try {
        const p = await buildLoopProvider(tenant, deps.llmConfigService);
        dshLlm = createLLMCallable(p);
      } catch {
        // ignore
      }
    }
    const dshInput = {
      ...input,
      ...(beforeTurnExec.extraSections.length > 0
        ? { systemPrompt: beforeTurnExec.extraSections.join("\n\n") }
        : {}),
    };
    await runDshAdapterTurn(repo, tenant, broadcastingStore, dshInput, async (status) => {
      await executeAfterTurnPlugins(
        pluginRegistry,
        { ...turnPluginCtx, status, llm: dshLlm },
        extRepo,
        deps.pluginConfigRepo,
        beforeTurnExec.pluginResults,
        beforeTurnExec.snapshots,
      );
    });
    return;
  }

  let provider: ModelProviderPort;
  let proactiveProfilePrompt = "";
  try {
    const proactiveStatus = deps.proactiveRepository
      ? await deps.proactiveRepository.getEffectiveStatus(tenant)
      : null;
    const proactiveActive = proactiveStatus?.effectiveState === "active";
    const loopProvider = await buildLoopProvider(tenant, deps.llmConfigService, {
      requireLocalOnly: proactiveActive,
      sessionId: input.sessionId,
      turnId: input.turnId,
      modelRoutingService: deps.modelRoutingService,
      persona: deps.persona ? { name: deps.persona.name } : undefined,
    });
    provider = loopProvider;
    if (proactiveActive && deps.proactiveRepository) {
      proactiveProfilePrompt = await loadProactiveProfilePrompt(deps.proactiveRepository, tenant);
    }
  } catch (err) {
    await failTurnWithError(broadcastingStore, input.turnId, input.attemptId, err instanceof Error ? err.message : "provider_unavailable");
    await repo.updateTurnStatus(tenant, input.turnId, "Failed").catch(() => undefined);
    return;
  }

  // 5c：Provider Contribution 组合——
  // - subagent/workflow 为静态声明的 Contribution（compose 路由 + 工具清单入模型 schema）；
  // - toolRuntime（createRuntimeToolProvider）为动态注册表：tools 实时校验不静态声明，
  //   故作为 compose 的 fallback 兜底（未命中静态清单时由其自判 unregistered/审批，语义与既有一致）。
  const contribution: ToolProviderPort[] = [];
  const subagent = deps.subagentFactory ? deps.subagentFactory(tenant) : undefined;
  if (subagent) {
    contribution.push(createSubagentToolProvider({ subagent }));
  }
  if (deps.workflows && deps.workflows.length > 0) {
    contribution.push(createWorkflowToolProvider(deps.workflows));
  }
  if (deps.userQuestionPort) {
    contribution.push(createAskUserQuestionToolProvider({ userQuestionPort: deps.userQuestionPort }));
  }
  if (deps.practiceAttemptPort) {
    contribution.push(createPracticeAttemptToolProvider({ practiceAttemptPort: deps.practiceAttemptPort }));
  }
  const contributionProvider =
    contribution.length > 0
      ? createApprovalGatedToolProvider(
          composeToolProviders(contribution),
          tenant,
          repo,
          deps.proactiveActionAuthorizer,
          deps.observability,
        )
      : undefined;
  const apiConfig = loadApiConfig();
  const routingSnapshot = (provider as unknown as { routingSnapshot?: ModelRoutingSnapshot }).routingSnapshot;
  const isL1Tier = routingSnapshot?.tier === "L1";
  const isL2Tier = routingSnapshot?.tier === "L2";
  const isCapabilityTiering = apiConfig.modelRoutingFeatureFlags.has("capability_tiering");

  const runtimeProvider = deps.toolRuntime
    ? createRuntimeToolProvider(deps.toolRuntime, tenant, {
        conversationRepo: repo,
        proactiveActionAuthorizer: deps.proactiveActionAuthorizer,
        observability: deps.observability,
        capabilityTier: isL1Tier && isCapabilityTiering ? "restricted" : undefined,
      })
    : undefined;

  let tools: ToolProviderPort | undefined;
  if (!isL2Tier) {
    const rawTools = contributionProvider && runtimeProvider
      ? composeToolProviders([contributionProvider], { fallback: runtimeProvider })
      : contributionProvider ?? runtimeProvider;

    if (rawTools && isL1Tier && isCapabilityTiering) {
      tools = {
        get tools() {
          return (rawTools.tools || []).filter((t) => t.readOnly);
        },
        async execute(callInput) {
          const spec = rawTools.tools?.find((t) => t.name === callInput.name);
          if (spec && !spec.readOnly) {
            return {
              ok: false,
              error: `tool_restricted_in_tier_l1: 工具 ${callInput.name} 为写操作，在 L1 本地降级阶梯下被安全收紧拦截`,
            };
          }
          return rawTools.execute(callInput);
        },
      };
    } else {
      tools = rawTools;
    }
  }
  // 5b：默认启用 Base System Prompt（含核心工具指引）与 Skill 渐进披露；压缩 seam 默认关闭，
  // 设置 AERVOX_LOOP_COMPACTION=rule 启用内置规则式摘要。
  // 人格覆盖：激活人格时，其名称/设定覆盖系统默认身份，其技能白名单过滤渐进披露清单。
  const personaAllowedSkills = deps.persona?.allowedSkillNames;
  const disclosedSkills =
    personaAllowedSkills && deps.skills
      ? deps.skills.filter((s) => personaAllowedSkills.includes(s.name))
      : deps.skills;
  let history: ReturnType<SqliteConversationRepository["getSessionHistory"]> | undefined;
  let memoryContext: Promise<string | null> | undefined;
  let contextBuilder = createComposedContextBuilder({
    base: {
      async build(context) {
        history ??= repo.getSessionHistory(tenant, {
          sessionId: input.sessionId,
          beforeTurnId: input.turnId,
        });
        memoryContext ??= deps.memoryRecall
          ? deps.memoryRecall.recall(tenant, input.userMessage)
              .then(buildMemoryContext)
              .catch(() => null)
          : Promise.resolve(null);
        const [previous, recalled] = await Promise.all([history, memoryContext]);
        const index = context.messages.findIndex((message) => message.role !== "system");
        const insertion = index < 0 ? context.messages.length : index;
        return {
          turnId: context.turnId,
          sessionId: context.sessionId,
          messages: [
            ...context.messages.slice(0, insertion),
            ...previous,
            ...(recalled ? [{ role: "system" as const, content: recalled }] : []),
            ...context.messages.slice(insertion),
          ],
        };
      },
    },
    baseSystemPrompt: {
      assistantName: deps.persona?.name || "思隅 (Aervox)",
      personaPrompt: deps.persona?.prompt,
      activeTools: tools?.tools,
      extraSections: beforeTurnExec.extraSections,
    },
    skills: disclosedSkills,
    ...(loadApiConfig().loopCompaction === "rule"
      ? { compaction: createSummaryCompaction() }
      : {}),
  });
  if (proactiveProfilePrompt) {
    const inner = contextBuilder;
    contextBuilder = {
      async build(input) {
        const context = await inner.build(input);
        const messages = [...context.messages];
        const insertionIndex = messages.findIndex((message) => message.role !== "system");
        messages.splice(insertionIndex < 0 ? messages.length : insertionIndex, 0, {
          role: "system",
          content: proactiveProfilePrompt,
        });
        return { ...context, messages };
      },
    };
  }
  const result = await executeTurn(
    {
      execution: broadcastingStore,
      provider,
      contextBuilder,
      tools,
      deletionGate: deps.deletionGate,
      inbox: deps.inbox,
      modelRunMeta: routingSnapshot
        ? {
            provider: routingSnapshot.providerType ?? "rule",
            modelId: routingSnapshot.modelId ?? "rule",
            purpose: `tier_${routingSnapshot.tier}:${routingSnapshot.reason}`,
          }
        : undefined,
    },
    input,
  );
  const turnDurationMs = Date.now() - turnStartTime;
  deps.observability?.metrics.emit({
    type: "histogram",
    name: "agent.provider.duration_ms",
    value: turnDurationMs,
  });

  // 以 Loop 结果对齐 turns 状态；skipped（幂等保护）不覆盖。
  if (result.status === "completed") {
    deps.observability?.metrics.emit({
      type: "counter",
      name: "agent.turn.completed",
      value: 1,
    });
    deps.observability?.log.info({
      event: "agent.turn.completed",
      message: `Turn ${input.turnId} completed in ${turnDurationMs}ms`,
      fields: {
        turnId: input.turnId,
        sessionId: input.sessionId,
        durationMs: turnDurationMs,
      },
    });
    await repo.updateTurnStatus(tenant, input.turnId, "Completed");
    const llm = provider ? createLLMCallable(provider) : undefined;
    await executeAfterTurnPlugins(
      pluginRegistry,
      { ...turnPluginCtx, status: "Completed", llm },
      extRepo,
      deps.pluginConfigRepo,
      beforeTurnExec.pluginResults,
      beforeTurnExec.snapshots,
    );
  } else if (result.status === "failed") {
    deps.observability?.log.error({
      event: "agent.turn.failed",
      message: `Turn ${input.turnId} failed: ${result.reason}`,
      fields: {
        turnId: input.turnId,
        sessionId: input.sessionId,
        durationMs: turnDurationMs,
        error: result.reason,
      },
    });
  } else {
    deps.observability?.log.warn({
      event: "agent.turn.interrupted",
      message: `Turn ${input.turnId} status=${result.status}`,
      fields: {
        turnId: input.turnId,
        sessionId: input.sessionId,
        durationMs: turnDurationMs,
        status: result.status,
      },
    });
  }
}
