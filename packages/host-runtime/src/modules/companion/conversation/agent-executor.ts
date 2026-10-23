import { setRequestToolApprovalMode } from "../../../shared/tool-approval-policy.js";
import { hostPromptPolicy } from "./prompt-policy.js";
import { ControlContext, createTurnTerminator, type TurnTerminator } from "@aervox/core";
/**
 * Aervox｜思隅 @aervox/api — 会话回合编排（runLoopTurnOnce）
 *
 * 机械拆分（B 档第三步，零行为变更）：原「Agent Loop SQLite 执行存储适配 +
 * 工具接线」巨型文件拆为——Provider 构建与 TurnLlmPort 适配在 llm-adapter.ts、
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
  createSummaryCompaction,
  executeTurn,
  stableSerialize,
} from "@aervox/core";
import type {
  InboxPort,
  ModelProviderPort,
  ReplayStep,
  SkillDescriptor,
  SubagentPort,
  ToolProviderPort,
  UserQuestionPort,
  WorkflowDefinition,
} from "@aervox/core";
import type { PluginHostServices, ServerPluginRegistration, TurnLlmPort } from "@aervox/host-plugin-api";
import { SqliteExecutionStore } from "@aervox/host-agent";
import {
  type IExtensionRepository,
  type IPluginConfigRepository,
  type IProactiveProfileRepository,
  type SqliteConversationRepository,
  type LocalContext,
  assertConversationExecutionPolicy,
} from "@aervox/repositories";
import { type ExecutionConfig } from "@aervox/config";
import type { Observability } from "@aervox/observability";
import {
  executeAfterTurnPlugins,
  executeBeforeTurnPlugins,
  isPluginEnabled,
  ServerPluginRegistry,
  type TurnPluginHostContext,
} from "../../ecosystem/plugins/index.js";
import type { ToolRuntimePort as ToolRuntime } from "../../ecosystem/tools/index.js";
import { HOST_TOOL_GUIDANCE } from "../../ecosystem/tools/index.js";
import type { LLMConfigPort } from "../../ecosystem/llm/index.js";
import type { ModelRoutingPort } from "../../ecosystem/llm/index.js";
import type { ModelRoutingSnapshot } from "@aervox/contracts";
import type { PluginApiRegistry } from "@aervox/contracts";
import { createPluginApiRegistry } from "../../../plugin-api-registry.js";
import { loadProactiveProfilePrompt } from "../../proactive/proactive/index.js";
import type { ProactiveActionPort } from "../../proactive/proactive/index.js";
import { buildMemoryContext, type MemoryRecallPort } from "./memory-recall.js";
import { buildLoopProvider, createLLMCallable } from "./llm-adapter.js";
import { createContributionToolProvider, createRuntimeToolProvider, hasBotExcludedPermissions, processToolImplementationRevision, type ContributionToolSource } from "./tool-providers.js";
import { createBroadcastingStore } from "./broadcasting-store.js";
import { turnStreamHub } from "./stream-hub.js";
import { createPluginToolScope } from "./plugin-tool-scope.js";
import { PluginToolCatalog, type PluginToolLease } from "./plugin-tool-catalog.js";
import { type DshTurnAdapterResolver, runDshAdapterTurn } from "./dsh-adapter.js";

/** SqliteExecutionStore 组合根适配由 @aervox/host-agent 提供（见上方 import），API 不再自维护 SQLite 执行存储 */

/**
 * 汇总第一方插件贡献的确定性回放脚本（键为 provider 模式名）。
 * 宿主只做分发，不在自身内建插件领域夹具（CR-060）。
 */
function collectReplayScripts(
  registrations?: ServerPluginRegistration[],
): Record<string, readonly ReplayStep[]> | undefined {
  const merged: Record<string, readonly ReplayStep[]> = {};
  for (const registration of registrations ?? []) {
    for (const [mode, script] of Object.entries(registration.replayScripts ?? {})) {
      merged[mode] ??= script;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

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
    signal?: AbortSignal;
    deadlineEpochMs?: number;
    resume?: import("@aervox/core").ExecuteTurnResumeInput;
  },
  deps: {
    executionConfig: ExecutionConfig;
    apiRegistry?: PluginApiRegistry;
    dshResolver?: DshTurnAdapterResolver;
    pluginToolCatalog?: PluginToolCatalog;
    signal?: AbortSignal;
    claimTurnAttempt?: SqliteExecutionStore["claimTurnAttempt"];
    preparationFencingToken?: number;
    preparationTerminator?: TurnTerminator;
    isMcpToolAllowed?: (tool: { id: string; name: string; pluginId?: string | null }) => Promise<boolean>;
    toolRuntime?: ToolRuntime;
    llmConfigService?: LLMConfigPort;
    /** CR-034 模型降级与健康路由决策服务 */
    modelRoutingService?: ModelRoutingPort;
    /** CAP-008：安全与危机干预服务（危急阻断/资源注入/中度困扰支持） */
    safetyService?: import("../../platform/safety/index.js").SafetyPort;
    /** 2d：删除/撤权水位未追平 → Loop fail-closed（AVX-HAR-001 §11.3） */
    deletionGate?: import("@aervox/core").DeletionGatePort;
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
    /** CR-060：已装配的第一方插件注册单元（其工具贡献按启用状态门控后合入模型工具面） */
    pluginRegistrations?: ServerPluginRegistration[];
    /** CR-060：插件宿主服务工厂（按当前本地上下文产出窄端口集合） */
    pluginHostServices?: import("../../../plugin-assembly.js").PluginHostServicesFactory;
    /** CAP-033：主动智能全动作授权与本地动作账本。 */
    proactiveActionAuthorizer?: ProactiveActionPort;
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
  },
): Promise<void> {
  const resources: Array<() => void | Promise<void>> = [];
  try {
  const apiConfig = deps.executionConfig;
  const apiRegistry = deps.apiRegistry ?? createPluginApiRegistry();
  const persisted = await repo.getTurn(tenant, input.turnId);
  const session = await repo.getSession(tenant, input.sessionId);
  if (!persisted || !session || persisted.sessionId !== input.sessionId || persisted.executionPolicy !== session.executionPolicy) throw new Error("conversation_policy_mismatch");
  assertConversationExecutionPolicy(persisted.executionPolicy);
  const attempt = (await repo.listTurnAttempts(tenant, input.turnId)).find(candidate => candidate.id === input.attemptId);
  if (!attempt) throw new Error("conversation_attempt_mismatch");
  const acceptedMessage = await repo.getTurnUserMessage(tenant, input.turnId);
  if (acceptedMessage === null) throw new Error("conversation_input_unavailable");
  input = { ...input, userMessage: acceptedMessage };
  const group = persisted.executionPolicy === "bot-group-member-v1";
  const bot = persisted.executionPolicy !== "local-v1";
  if (group) {
    deps = { executionConfig: deps.executionConfig, apiRegistry: deps.apiRegistry, llmConfigService: deps.llmConfigService, modelRoutingService: deps.modelRoutingService,
      signal: deps.signal, claimTurnAttempt: deps.claimTurnAttempt, preparationFencingToken: deps.preparationFencingToken,
      preparationTerminator: deps.preparationTerminator,
      safetyService: deps.safetyService, deletionGate: deps.deletionGate,
      platformRepo: deps.platformRepo, observability: deps.observability };
  } else if (bot) {
    deps = { ...deps, proactiveRepository: undefined, proactiveActionAuthorizer: undefined,
      subagentFactory: undefined, workflows: undefined, inbox: undefined, userQuestionPort: undefined };
  }
  if (bot) {
    setRequestToolApprovalMode(tenant, "ask");
    input = { ...input, metadata: undefined };
  }
  const signal = input.signal && deps.signal ? AbortSignal.any([input.signal, deps.signal]) : input.signal ?? deps.signal;
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

  const baseExtRepo = group ? null : deps.extensionRepo ?? null;
  const extRepo = bot && baseExtRepo ? new Proxy(baseExtRepo, {
    get(target, property) {
      if (property === "getPlugin") return async (pluginId: string) => {
        const plugin = await target.getPlugin(pluginId);
        return plugin && !hasBotExcludedPermissions(plugin.permissions) && !plugin.proactiveSpecJson ? plugin : null;
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) : baseExtRepo;
  const pluginRegistry = group ? undefined : deps.pluginRegistry ?? new ServerPluginRegistry();

  // CR-060：向插件暴露**窄端口**而非仓储与总线本体。
  // 序号交由仓储原子分配（appendStreamEvent 缺省 sequence），避免插件自行推算；
  // 写入同时落库并广播，保证 SSE 实时性与重放一致。
  const turnPluginCtx: TurnPluginHostContext = {
    turnId: input.turnId,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    userMessage: input.userMessage,
    metadata: input.metadata,
    signal,
    deadlineEpochMs: input.deadlineEpochMs,
    stream: {
      readEvents: (turnId, fromSequence) => repo.getStreamEvents(tenant, turnId, fromSequence),
      appendEvent: async (appendInput, control) => {
        // CR-060：插件只能写入内核事件类型或其在登记表中**声明过**的事件类型。
        // 登记表不是装饰——未声明的类型在此拒绝（fail-closed），避免插件静默塞入
        // 前端不认识、投影白名单也无从收敛的事件。
        if (!apiRegistry.isKnownStreamEventType(appendInput.eventType)) {
          throw new Error(`unregistered_stream_event_type: ${appendInput.eventType}`);
        }
        if (!control) throw new Error("plugin_hook_identity_required");
        await control.checkActive(); control.signal.throwIfAborted();
        const stored = await repo.appendPluginHookEvent(tenant, {
          turnId: input.turnId, attemptId: input.attemptId,
          expectedFencingToken: deps.preparationFencingToken ?? attempt.fencingToken,
          pluginGeneration: control.pluginGeneration, phase: control.phase,
          eventType: appendInput.eventType, payloadVersion: appendInput.payloadVersion,
          data: appendInput.data,
        });
        turnStreamHub.publishEvent(input.turnId, stored);
        return stored;
      },
    },
  };

  // Runner 的宿主依赖：`tenant` 只用于读取插件配置，不进入插件上下文（CR-060）
  const turnPluginDeps = { tenant, extRepo, configRepo: deps.pluginConfigRepo };
  const beforeTurnExec = group ? { extraSections: [] as string[], pluginResults: new Map(), snapshots: new Map() }
    : await executeBeforeTurnPlugins(pluginRegistry!, turnPluginCtx, turnPluginDeps);

  // 每次实际模型调用的 ModelRun + ContextManifest 快照落库（委托 platform 域）
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
            await p.completeModelRun(tenant, r.runId, { status: r.status === "completed" ? "completed" : "failed", latencyMs: r.latencyMs, tokenUsage: r.usage });
          },
          recordContextManifest: async (m) => {
            const p = deps.platformRepo!;
            await p.createContextManifest({
              id: m.manifestId,
              modelRunId: m.modelRunId,
              purpose: m.purpose,
              sourceArtifactId: "turn:history",
              sourceRevisionId: "1",
              snapshot: m.requestSnapshot
                ? { version: 1, messages: m.snapshot, ...m.requestSnapshot }
                : m.snapshot,
            });
            await p.attachContextManifest(tenant, m.modelRunId, m.manifestId);
          },
        }
      : undefined,
  );
  if (deps.claimTurnAttempt) store.claimTurnAttempt = deps.claimTurnAttempt;
  const broadcastingStore = createBroadcastingStore(store);
  // Production preparation uses the same claimed lifecycle that will be handed
  // to the driver. Standalone internal callers still use Core terminal policy.
  const preparationControl = deps.preparationTerminator ? undefined : new ControlContext({
    abortSignal: signal, deadlineEpochMs: input.deadlineEpochMs,
  });
  if (preparationControl) resources.push(() => preparationControl.dispose());
  const preparationTerminator = deps.preparationTerminator ?? createTurnTerminator({
    ...input, execution: broadcastingStore, claimFencingToken: deps.preparationFencingToken ?? 0,
    stepsTaken: 0, startedAt: turnStartTime, control: preparationControl, deletionGate: deps.deletionGate,
  });
  const stopPreparation = async () => preparationTerminator.prematureTermination(await store.nextSequence(input.turnId));
  const failPreparation = async (error: unknown, code = "MODEL_UNAVAILABLE") => preparationTerminator.finalizeFailure(
    await store.nextSequence(input.turnId), error, { code, retryable: false },
  );
  if (await stopPreparation()) return;

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

      // 5. Terminal status and done are committed together under the preparation fence.
      if (await stopPreparation()) return;
      await broadcastingStore.appendEvent({
        turnId: input.turnId,
        attemptId: input.attemptId,
        sequence: await store.nextSequence(input.turnId),
        eventType: "delta",
        data: {
          messageId: assistantMsgId,
          text: crisisText,
        },
        safetyDecision: "redacted",
        expectedFencingToken: deps.preparationFencingToken ?? 0,
      }).catch(() => undefined);

      if (await stopPreparation()) return;
      const terminalSequence = await store.nextSequence(input.turnId);
      await preparationTerminator.finalize(terminalSequence, { status: "completed" }, {
        eventType: "done",
        eventData: {
          status: "Completed",
          messageId: assistantMsgId,
          isComplete: true,
          lastSequence: terminalSequence,
        },
        safetyDecision: "approved",
      }).catch(() => undefined);

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

  // CAP-033：主动智能本地处理限制在驱动分支之前求值——进程外 Adapter 同样不得绕过（fail-closed）。
  let proactiveActive = false;
  if (deps.proactiveRepository) {
    try {
      const proactiveStatus = await deps.proactiveRepository.getEffectiveStatus(tenant);
      proactiveActive = proactiveStatus?.effectiveState === "active";
    } catch (err) {
      await failPreparation(err);
      return;
    }
  }
  const localProcessingOnly = proactiveActive;

  // ADR-010 阶段 6f：AERVOX_LOOP_DRIVER=dsh → 整 Turn 走 DSH 进程外 Adapter
  // （自带 Agent 循环与模型回合，Provider/工具/上下文组合全部跳过；未就绪 fail-closed 不回退 native）。
  if (!bot && apiConfig.loopDriver === "dsh") {
    // 主动智能本地处理期间：进程外 Adapter 不得代执行（既有策略接进本分支，不新增政策）
    if (localProcessingOnly) {
      await failPreparation(new Error("proactive_local_provider_required: 主动智能本地处理期间不允许进程外 Adapter"));
      return;
    }
    if (await stopPreparation()) return;
    let dshLlm: TurnLlmPort | undefined;
    if (deps.llmConfigService && apiConfig.loopProvider === "llm") {
      try {
        const p = await buildLoopProvider(tenant, deps.llmConfigService, { executionConfig: apiConfig });
        dshLlm = createLLMCallable(p);
      } catch {
        // ignore
      }
    }
    const dshInput = { ...input, signal, deletionGate: deps.deletionGate, preparationFencingToken: deps.preparationFencingToken,
      ...(beforeTurnExec.extraSections.length > 0
        ? { systemPrompt: beforeTurnExec.extraSections.join("\n\n") }
        : {}),
    };
    const resolver = deps.dshResolver;
    if (!resolver) { await failPreparation(new Error("dsh_resolver_required"), "ADAPTER_UNAVAILABLE"); return; }
    await runDshAdapterTurn(broadcastingStore, {
      ...dshInput, beforeComplete: async completionSignal => executeAfterTurnPlugins(
        pluginRegistry!, { ...turnPluginCtx, signal: completionSignal, status: "Completed", llm: dshLlm },
        turnPluginDeps, beforeTurnExec.pluginResults, beforeTurnExec.snapshots,
      ),
    }, resolver, preparationTerminator);
    return;
  }

  let provider: ModelProviderPort;
  let proactiveProfilePrompt = "";
  try {
    const loopProvider = await buildLoopProvider(tenant, deps.llmConfigService, {
      executionConfig: apiConfig, requireLocalOnly: proactiveActive,
      sessionId: input.sessionId,
      turnId: input.turnId,
      modelRoutingService: deps.modelRoutingService,
      persona: deps.persona ? { name: deps.persona.name } : undefined,
      pluginReplayScripts: collectReplayScripts(deps.pluginRegistrations),
    });
    provider = loopProvider;
    if (proactiveActive && deps.proactiveRepository) {
      proactiveProfilePrompt = await loadProactiveProfilePrompt(deps.proactiveRepository, tenant);
    }
  } catch (err) {
    await failPreparation(err);
    return;
  }

  // 5c：Provider Contribution 组合——
  // - subagent/workflow 为静态声明的 Contribution（compose 路由 + 工具清单入模型 schema）；
  // - toolRuntime（createRuntimeToolProvider）为动态注册表：tools 实时校验不静态声明，
  //   故作为 compose 的 fallback 兜底（未命中静态清单时由其自判 unregistered/审批，语义与既有一致）。
  const contribution: ContributionToolSource[] = [];
  const subagent = deps.subagentFactory ? deps.subagentFactory(tenant) : undefined;
  if (subagent) {
    contribution.push({ provider: createSubagentToolProvider({ subagent }),
      approvalRevision: `host:subagent:v1:${processToolImplementationRevision(deps.subagentFactory!)}` });
  }
  if (deps.workflows && deps.workflows.length > 0) {
    contribution.push({ provider: createWorkflowToolProvider(deps.workflows),
      approvalRevision: stableSerialize(["host:workflow:v1", deps.workflows.map(workflow => ({ name: workflow.name,
        description: workflow.description, steps: workflow.steps.map(step => ({
          description: step.description, implementation: processToolImplementationRevision(step.execute) })) }))]) });
  }
  if (deps.userQuestionPort) {
    contribution.push({ provider: createAskUserQuestionToolProvider({ userQuestionPort: deps.userQuestionPort }), approvalRevision: "host:ask-user:v1" });
  }
  // CR-060：插件工具贡献——按当前本地上下文构造，并**按插件启用状态门控**。
  // 禁用、缺记录或不可用的插件不得向模型暴露其工具（与 Runner、插件端点同判据）。
  // 门控一律 fail-closed：`isPluginEnabled` 在仓储缺失时同样返回 false，故此处不得再
  // 用 `extRepo &&` 短路（那会在仓储不可用时退化为放行）。
  // 模型侧使用指南由插件自述，经内核既有的 customGuidance 通用注入位合入基础提示词；
  // 宿主自有工具（日记 / 笔记检索 / 记忆沉淀）的指南同经该注入位提供
  // （ADR-021 内核提纯修订：产品域 guidance 不再随内核发布，见 host-tool-guidance）。
  const pluginLeases: PluginToolLease[] = [];
  if (deps.pluginRegistrations?.length && deps.pluginHostServices && extRepo) {
    const catalog = deps.pluginToolCatalog ?? new PluginToolCatalog(extRepo, apiRegistry);
    if (!deps.pluginToolCatalog) resources.push(() => catalog.dispose());
    const toolNames = new Set(contribution.flatMap(item => item.provider.tools.map(tool => tool.name)));
    for (const registration of deps.pluginRegistrations) {
      if (!registration.toolContributions) continue;
      const record = await extRepo.getPlugin(registration.pluginId);
      if (!record || record.enabled !== 1 || (record.availability ?? "available") !== "available" || !record.lifecycleGeneration) continue;
      const prior = beforeTurnExec.snapshots?.get(registration.pluginId)?.lifecycleGeneration;
      if (prior !== undefined && prior !== record.lifecycleGeneration) continue;
      try {
        const lease = await catalog.acquire({ owner: registration.pluginId, generation: record.lifecycleGeneration,
          signal, reservedNames: toolNames,
          create: scope => registration.toolContributions!(deps.pluginHostServices!(tenant, scope)),
        });
        contribution.push(...lease.sources);
        pluginLeases.push(lease);
        for (const source of lease.sources) for (const tool of source.provider.tools) toolNames.add(tool.name);
        resources.push(lease.release);
      } catch (err) {
        deps.observability?.log.warn({
          event: "plugin.tool_contribution_failed", message: `插件 ${registration.pluginId} 工具贡献构造失败，已跳过`,
          fields: { pluginId: registration.pluginId, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }
  const contributionProvider = contribution.length > 0
    ? createContributionToolProvider(contribution, tenant, repo, deps.proactiveActionAuthorizer, deps.observability)
    : undefined;
  const routingSnapshot = (provider as unknown as { routingSnapshot?: ModelRoutingSnapshot }).routingSnapshot;
  const isL1Tier = routingSnapshot?.tier === "L1";
  const isL2Tier = routingSnapshot?.tier === "L2";
  const isCapabilityTiering = apiConfig.modelRoutingFeatureFlags.has("capability_tiering");

  const runtimeScopes = new Map<string, ReturnType<typeof createPluginToolScope>>();
  const runtimeProvider = deps.toolRuntime
    ? createRuntimeToolProvider(deps.toolRuntime, tenant, {
        conversationRepo: repo,
        proactiveActionAuthorizer: deps.proactiveActionAuthorizer,
        observability: deps.observability,
        generationFor: tool => tool.pluginId ? runtimeScopes.get(tool.pluginId)?.pluginGeneration?.generation : undefined,
        signalFor: tool => tool.pluginId ? runtimeScopes.get(tool.pluginId)?.signal : undefined,
        capabilityTier: isL1Tier && isCapabilityTiering ? "restricted" : undefined,
        async isToolAllowed(tool) {
          if (bot && hasBotExcludedPermissions(tool.requiredPermissionsJson)) return false;
          // Native tools retain their domain-owned authorization. Plugin grants are re-read per dispatch.
          if (tool.pluginId?.startsWith("mcp:")) return deps.isMcpToolAllowed?.(tool) ?? false;
          if (!tool.pluginId) return tool.builtin === 1 || !tool.requiredPermissionsJson || (Array.isArray(tool.requiredPermissionsJson) && !tool.requiredPermissionsJson.length);
          if (!extRepo) return false;
          let scope = runtimeScopes.get(tool.pluginId);
          if (!scope) {
            const plugin = await extRepo.getPlugin(tool.pluginId);
            if (!plugin || plugin.enabled !== 1 || (plugin.availability ?? "available") !== "available" || !plugin.lifecycleGeneration) return false;
            scope = createPluginToolScope(extRepo, tool.pluginId, plugin.lifecycleGeneration, signal);
            runtimeScopes.set(tool.pluginId, scope);
            resources.push(() => scope!.dispose());
          }
          if (!(await scope.active())) return false;
          const required = tool.requiredPermissionsJson ?? [];
          if (!Array.isArray(required)) return false;
          for (const item of required) {
            const permission = typeof item === "string" ? item : item?.permission;
            const scope = typeof item === "string" ? "*" : item?.scope;
            if (typeof permission !== "string" || typeof scope !== "string" || !(await extRepo.hasPluginGrant(tenant, tool.pluginId, permission, scope))) return false;
          }
          return true;
        },
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
        async listTools() { return (rawTools.listTools ? await rawTools.listTools() : rawTools.tools).filter(t => t.readOnly); },
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
    inbox: !bot,
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
      ...hostPromptPolicy(
        // ADR-027：角色名取人格名（角色名的服务端形态），否则取客户端随轮注入的
        // companionName；用户称呼同理。人格设定 prompt 仍可覆盖（既有优先级不变）。
        deps.persona?.name ||
          (typeof input.metadata?.companionName === "string" && input.metadata.companionName.trim()) ||
          undefined,
        (typeof input.metadata?.userAddress === "string" && input.metadata.userAddress.trim()) || undefined,
      ),
      personaPrompt: deps.persona?.prompt,
      activeTools: tools?.tools,
      extraSections: beforeTurnExec.extraSections,
      ...(!group && HOST_TOOL_GUIDANCE.length + pluginLeases.flatMap(lease => lease.guidance).length > 0
        ? { customGuidance: [...HOST_TOOL_GUIDANCE, ...pluginLeases.flatMap(lease => lease.guidance)] }
        : {}),
    },
    skills: disclosedSkills,
    ...(apiConfig.loopCompaction === "rule"
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
  const control = new ControlContext({ turnId: input.turnId, attemptId: input.attemptId, sessionId: input.sessionId, localProcessingOnly, abortSignal: signal, deadlineEpochMs: input.deadlineEpochMs });
  const result = await executeTurn(
    {
      execution: broadcastingStore,
      controlContext: control,
      provider,
      contextBuilder,
      tools,
      deletionGate: deps.deletionGate,
      inbox: deps.inbox,
      options: {
        beforeComplete: !group ? async completionSignal => executeAfterTurnPlugins(
          pluginRegistry!, { ...turnPluginCtx, signal: completionSignal, status: "Completed", llm: createLLMCallable(provider) },
          turnPluginDeps, beforeTurnExec.pluginResults, beforeTurnExec.snapshots,
        ) : undefined,
        resume: input.resume,
      },
      modelRunMeta: routingSnapshot
        ? {
            provider: routingSnapshot.providerType ?? "rule",
            modelId: routingSnapshot.modelId ?? "rule",
            purpose: `tier_${routingSnapshot.tier}:${routingSnapshot.reason}`,
          }
        : undefined,
    },
    input,
  ).finally(() => control.dispose());
  if (result.status === "skipped" && await stopPreparation()) return;
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
  } finally { for (const dispose of resources.reverse()) await dispose(); }
}
