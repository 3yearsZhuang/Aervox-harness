import { SqliteExecutionStore } from "@aervox/host-agent";
import { createBroadcastingStore } from "./broadcasting-store.js";
import { setRequestToolApprovalMode } from "../../../shared/tool-approval-policy.js";
import type { SkillDescriptor } from "@aervox/core";
import type { SqliteConversationRepository, SqlitePrivacyRepository, SqliteAgentInboxRepository, SqliteSubagentRunRepository, SqlitePlatformRepository, LocalContext } from "@aervox/repositories";
import { assertConversationExecutionPolicy } from "@aervox/repositories";
import type { ToolRuntimePort as ToolRuntime } from "../../ecosystem/tools/index.js";
import type { LLMConfigPort } from "../../ecosystem/llm/index.js";
import type { ProactiveActionPort } from "../../proactive/proactive/index.js";
import type { MemoryRecallPort } from "./memory-recall.js";
import type { Observability } from "@aervox/observability";
import type { UserQuestionCoordinator } from "./user-question-coordinator.js";
import { acquireWorkerPressureLease, releaseWorkerPressureLease } from "../../../shared/worker-pressure-lease.js";
import { createTenantInboxPort } from "../inbox/index.js";
import { runLoopTurnOnce } from "./agent-executor.js";

export interface ConversationRouteDeps {
  signal?: AbortSignal;
  prepareExecution?: () => Promise<void>;
  isMcpToolAllowed?: (tool: { id: string; name: string; pluginId?: string | null }) => Promise<boolean>;
  /** 阶段 2d：Agent Loop 只读工具提供者（缺失时工具请求 fail-closed） */
  toolRuntime?: ToolRuntime;
  /** 阶段 2e：AERVOX_LOOP_PROVIDER=llm 时的模型配置来源（CR-015） */
  llmConfigService?: LLMConfigPort;
  /** CR-034 模型降级与健康路由决策服务 */
  modelRoutingService?: import("../../ecosystem/llm/index.js").ModelRoutingPort;
  /** CAP-008：安全与危机干预服务（危急阻断/资源注入/中度困扰支持） */
  safetyService?: import("../../platform/safety/index.js").SafetyPort;
  /** 2d：删除/撤权闸门数据源（缺失时 Loop 不做删除 fail-closed） */
  privacyRepo?: SqlitePrivacyRepository;
  /** 5a-2：受控收件箱（followup 排队为新 Turn 输入；next-step 由 Loop 每 Step 消费） */
  inboxRepo?: SqliteAgentInboxRepository;
  /** 5b：Skill 渐进披露清单加载器（activeOnly；缺省不注入 Skills 段） */
  skillLoader?: () => Promise<SkillDescriptor[]>;
  /** 人格提示词摘要加载器（激活人格的名称/设定/技能白名单，覆盖系统默认） */
  personaLoader?: (
    tenant: import("@aervox/repositories").LocalContext,
  ) => Promise<{ name?: string; prompt?: string; allowedSkillNames?: string[] } | undefined>;
  /** 5c：Subagent 委托执行器工厂（request 级 tenant 绑定；注入则贡献 subagent_delegate 工具） */
  subagentFactory?: (tenant: import("@aervox/repositories").LocalContext) => import("@aervox/core").SubagentPort;
  /** 5c：已注册 Workflow 定义清单（贡献 workflow_run 工具；GET /v1/workflows 元数据） */
  workflows?: import("@aervox/core").WorkflowDefinition[];
  /** 5c：subagent_runs 仓储（GET /v1/turns/:id/subagents 审计查询） */
  subagentRunRepo?: SqliteSubagentRunRepository;
  /** 阶段 7：ModelRun/ContextManifest 落库口（Step 级可追溯写入；缺失则不记录） */
  platformRepo?: SqlitePlatformRepository;
  /** UQ-01：向用户提问会话协调器 */
  userQuestionCoordinator?: UserQuestionCoordinator;
  /** CR-060：第一方插件注册单元读取器（plugins 模块晚于本模块注册，故惰性读取） */
  pluginRegistrations?: () => import("@aervox/host-plugin-api").ServerPluginRegistration[] | undefined;
  /** CR-060：插件宿主服务工厂（按 request 级本地上下文产出窄端口集合） */
  pluginHostServices?: import("../../../plugin-assembly.js").PluginHostServicesFactory;
  /** CAP-033：主动智能全动作授权与本地动作账本。 */
  proactiveActionAuthorizer?: ProactiveActionPort;
  /** CAP-033：本地画像上下文来源。 */
  proactiveRepository?: import("@aervox/repositories").IProactiveProfileRepository;
  /** CAP-005：普通长期记忆混合召回，按 request tenant 绑定。 */
  memoryRecall?: MemoryRecallPort;
  /** 插件仓储：用于检查插件启用状态 */
  extensionRepo?: import("@aervox/repositories").IExtensionRepository;
  /** 插件配置仓储：用于加载插件运行时配置 */
  pluginConfigRepo?: import("@aervox/repositories").IPluginConfigRepository;
  /** 服务端插件注册表（提供回合插件生命周期与别名解析） */
  pluginRegistry?: import("../../ecosystem/plugins/index.js").ServerPluginRegistry;
  /** 全链路可观测性门面（结构化日志与指标采集） */
  observability?: Observability;
}

export interface ConversationTurnInput {
  turnId: string;
  sessionId: string;
  attemptId: string;
  userMessage: string;
  metadata?: Record<string, unknown>;
  toolApprovalMode?: "ask" | "full_access";
  actorId?: string;
  signal?: AbortSignal;
  resume?: import("@aervox/core").ExecuteTurnResumeInput;
}

/** Shared admission, product dependencies and failure handling for both execution hosts. */
export async function executeConversationTurn(
  conversationRepo: SqliteConversationRepository,
  tenant: LocalContext,
  input: ConversationTurnInput,
  deps: ConversationRouteDeps,
): Promise<void> {
  const { turnId, sessionId, attemptId } = input;
  const turn = await conversationRepo.getTurn(tenant, turnId);
  const session = await conversationRepo.getSession(tenant, sessionId);
  if (!turn || !session || turn.sessionId !== sessionId || turn.executionPolicy !== session.executionPolicy) {
    throw new Error("conversation_policy_mismatch");
  }
  assertConversationExecutionPolicy(turn.executionPolicy);
  const attempt = (await conversationRepo.listTurnAttempts(tenant, turnId)).find(candidate => candidate.id === attemptId);
  if (!attempt) throw new Error("conversation_attempt_mismatch");
  if (!["Created", "Running"].includes(turn.status) || attempt.status !== "Running") return;
  const userMessage = await conversationRepo.getTurnUserMessage(tenant, turnId);
  if (userMessage === null) throw new Error("conversation_input_unavailable");
  const bot = turn.executionPolicy !== "local-v1";
  const group = turn.executionPolicy === "bot-group-member-v1";
  if (bot) {
    input = { ...input, metadata: undefined, toolApprovalMode: "ask" };
    deps = {
      ...deps, inboxRepo: undefined, subagentFactory: undefined, workflows: undefined,
      userQuestionCoordinator: undefined, proactiveActionAuthorizer: undefined, proactiveRepository: undefined,
      ...(group ? {
        prepareExecution: undefined, isMcpToolAllowed: undefined, toolRuntime: undefined,
        personaLoader: undefined, skillLoader: undefined, memoryRecall: undefined,
        pluginRegistrations: undefined, pluginHostServices: undefined, extensionRepo: undefined,
        pluginConfigRepo: undefined, pluginRegistry: undefined,
      } : {}),
    };
  }
  if (input.toolApprovalMode) setRequestToolApprovalMode(tenant, input.toolApprovalMode);
  // Acquire ownership before product hooks or other preparatory side effects.
  const admissionStore = createBroadcastingStore(new SqliteExecutionStore(conversationRepo, tenant));
  const claim = await admissionStore.claimTurnAttempt({ turnId, attemptId, expectedFencingToken: 0 });
  if (!claim.ok) return;
  const preparationAbort = new AbortController();
  const signal = AbortSignal.any([preparationAbort.signal, ...(deps.signal ? [deps.signal] : []), ...(input.signal ? [input.signal] : [])]);
  // Cancellation is persisted by another host when this Turn runs in a Worker.
  let pollingCancellation = false;
  const cancellation = setInterval(() => {
    if (pollingCancellation || signal.aborted) return;
    pollingCancellation = true;
    void admissionStore.isCancelRequested({ turnId, attemptId }).then(cancelled => {
      if (cancelled) preparationAbort.abort(new Error("turn_cancel_requested"));
    }).catch(error => preparationAbort.abort(error)).finally(() => { pollingCancellation = false; });
  }, 100);
  cancellation.unref();
  let preparing = true;
  const renew = () => claim.leaseId ? admissionStore.renewAttemptLease({
    attemptId, leaseId: claim.leaseId, expectedFencingToken: claim.fencingToken,
  }) : Promise.resolve({ ok: true });
  const heartbeat = setInterval(() => {
    void renew().then(result => {
      if (preparing && !result.ok) preparationAbort.abort(new Error("preparation_lease_lost"));
    }).catch(error => { if (preparing) preparationAbort.abort(error); });
  }, 30_000);
  heartbeat.unref();
  const handoffClaim: SqliteExecutionStore["claimTurnAttempt"] = async requested => {
    if (!preparing || requested.turnId !== turnId || requested.attemptId !== attemptId || signal.aborted || !(await renew()).ok) {
      return { ok: false, reason: "already_claimed" };
    }
    preparing = false;
    clearInterval(heartbeat);
    return claim;
  };
  const settleAdmission = async (status: "Interrupted" | "Failed" | "Cancelled", reason: string) => {
    const store = admissionStore;
    const messageId = `msg_${turnId}_assistant`;
    if (status === "Interrupted") await store.appendEvent({
      turnId, attemptId, expectedFencingToken: claim.fencingToken,
      sequence: await store.nextSequence(turnId), eventType: "message", safetyDecision: "approved",
      data: { messageId, role: "assistant" },
    });
    const sequence = await store.nextSequence(turnId);
    await store.finalizeAttemptWithEvent({
      turnId, attemptId, status, expectedFencingToken: claim.fencingToken,
      sequence, eventType: status === "Failed" ? "error" : "done",
      eventData: status === "Failed" ? {
        code: "MODEL_UNAVAILABLE", retryable: false,
        message: bot ? "会话执行失败，请在工作台重试。" : reason, lastSequence: sequence,
      } : { status, messageId, isComplete: false, reason, lastSequence: sequence }, safetyDecision: "approved",
    });
  };
  const uqPort = deps.userQuestionCoordinator ? deps.userQuestionCoordinator.createPort(tenant) : undefined;
  // ITER-027: 会话流式/多轮密集执行期间下发写入压力信号，协调后台 Worker 降频退避。
  // 以租约（而非裸 true/false）下发：并发会话互不提前解除，长回合按 TTL 续期。
  const pressureLease = acquireWorkerPressureLease();
  try {
    if (signal.aborted) { await settleAdmission("Cancelled", "host_shutdown"); return; }
    if (deps.privacyRepo && await deps.privacyRepo.hasPendingDeletionRequest(tenant)) {
      await settleAdmission("Interrupted", "deletion_blocked");
      return;
    }
    await deps.prepareExecution?.();
    await runLoopTurnOnce(
      conversationRepo,
      tenant,
      {
        turnId,
        sessionId,
        attemptId,
        userMessage,
        metadata: input.metadata,
        resume: input.resume,
      },
      {
        signal,
        claimTurnAttempt: handoffClaim,
        preparationFencingToken: claim.fencingToken,
        toolRuntime: deps.toolRuntime,
        isMcpToolAllowed: deps.isMcpToolAllowed,
        llmConfigService: deps.llmConfigService,
        modelRoutingService: deps.modelRoutingService,
        safetyService: deps.safetyService,
        // 人格覆盖：激活人格的名称/设定/技能白名单覆盖系统默认（无人格时 undefined 不注入）
        persona: deps.personaLoader ? await deps.personaLoader(tenant) : undefined,
        // 2d：删除/撤权水位未追平 → Loop fail-closed（AVX-HAR-001 §11.3）
        deletionGate: deps.privacyRepo
          ? { isBlocked: async () => deps.privacyRepo!.hasPendingDeletionRequest(tenant) }
          : undefined,
        // 5a-2：受控收件箱端口（每 Step 消费 next-step；steer/inject 注入上下文）
        inbox: deps.inboxRepo ? createTenantInboxPort(deps.inboxRepo, tenant) : undefined,
        // 5b：Skill 渐进披露（activeOnly 清单注入 system prompt）
        skills: deps.skillLoader ? await deps.skillLoader() : undefined,
        // 5c：Subagent/Workflow Contribution（独立 Tool/Provider 组合；惰性工厂按 request tenant 绑定）
        subagentFactory: deps.subagentFactory,
        workflows: deps.workflows,
        // 阶段 7：Step 级 ModelRun + 每 Turn ContextManifest 快照落库
        platformRepo: deps.platformRepo,
        // UQ-01: 向用户提问端口
        userQuestionPort: uqPort,
        // CR-060: 第一方插件工具贡献（按插件启用状态门控；宿主不感知具体插件）
        pluginRegistrations: deps.pluginRegistrations?.(),
        pluginHostServices: deps.pluginHostServices,
        proactiveActionAuthorizer: deps.proactiveActionAuthorizer,
        proactiveRepository: deps.proactiveRepository,
        memoryRecall: deps.memoryRecall,
        extensionRepo: deps.extensionRepo,
        pluginConfigRepo: deps.pluginConfigRepo,
        pluginRegistry: deps.pluginRegistry,
        observability: deps.observability,
      },
    );
  } catch (err) {
    // ARC-01: 捕获预加载与执行初始化阶段异常，防止 Attempt/Turn 永久滞留于 Running/Created
    const errMsg = err instanceof Error ? err.message : String(err);
    deps.observability?.log.error({
      event: "turn.dispatch_failed",
      message: `Turn ${turnId} pre-execution failed: ${errMsg}`,
      fields: { turnId, sessionId, attemptId, error: errMsg },
    });

    await settleAdmission("Failed", bot ? "conversation_execution_failed" : errMsg);
  } finally {
    preparing = false;
    clearInterval(heartbeat);
    preparationAbort.abort();
    clearInterval(cancellation);
    releaseWorkerPressureLease(pressureLease);
    if (bot) await conversationRepo.synchronizeTurnWithLatestAttempt(turnId);
  }
}
