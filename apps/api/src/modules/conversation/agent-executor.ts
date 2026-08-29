/**
 * Aervox｜思隅 @aervox/api — Agent Loop SQLite 执行存储适配 + 工具接线（阶段 1+2d）
 *
 * 实现 @aervox/agent-loop 的 ExecutionStorePort 与 ToolProviderPort（只读白名单），
 * 宿主为对话仓储 + 工具运行时；迁移期 native-agent-loop 在 API 进程内挂载
 * （AVX-HAR-001 §13），阶段 4 抽出独立 Host 时仅替换接线。
 */
import {
  composeToolProviders,
  createComposedContextBuilder,
  createOpenAICompatProvider,
  createReplayProvider,
  createScriptedProvider,
  createSubagentToolProvider,
  createWorkflowToolProvider,
  createAskUserQuestionToolProvider,
  createPracticeAttemptToolProvider,
  createSummaryCompaction,
  defaultContextBuilder,
  executeTurn,
} from "@aervox/agent-loop";
import type {
  InboxPort,
  ModelProviderPort,
  PracticeAttemptPort,
  ReplayStep,
  SkillDescriptor,
  SubagentPort,
  ToolExecutionInput,
  ToolExecutionResult,
  ToolProviderPort,
  UserQuestionPort,
  WorkflowDefinition,
} from "@aervox/agent-loop";
import { SqliteExecutionStore } from "@aervox/host-agent";
import { extractTerms } from "@aervox/practice-review";
import type {
  IProactiveProfileRepository,
  SqliteConversationRepository,
  TenantContext,
} from "@aervox/database";
import { loadApiConfig } from "@aervox/config";
import type { ToolRuntime } from "../tools/runtime.js";
import type { LLMConfigService } from "../llm/service.js";
import { getRequestToolApprovalMode } from "../../shared/tool-approval-policy.js";
import {
  PROACTIVE_ACTION_DECIDER_PREFIX,
  type ProactiveActionAuthorizer,
} from "../proactive/action-authorizer.js";
import {
  isLiteralLoopbackUrl,
  loadProactiveProfilePrompt,
} from "../proactive/profile-context.js";

/** SqliteExecutionStore 组合根适配由 @aervox/host-agent 提供（见上方 import），API 不再自维护 SQLite 执行存储 */

/** 自动授权决策人前缀；显式授权查询排除该类记录，避免关闭完全访问后泄漏。 */
export const FULL_ACCESS_DECIDER_PREFIX = "permission:full_access:";

type ToolApprovalRepository = Pick<
  SqliteConversationRepository,
  "recordToolApproval" | "decideToolApproval" | "findGrantedToolApproval"
>;

async function findExplicitToolApproval(
  repo: ToolApprovalRepository,
  tenant: TenantContext,
  input: { toolName: string; argumentsHash: string },
) {
  return repo.findGrantedToolApproval(tenant, {
    ...input,
    excludeDecidedByPrefixes: [FULL_ACCESS_DECIDER_PREFIX, PROACTIVE_ACTION_DECIDER_PREFIX],
  });
}

async function recordAutomaticApproval(
  repo: ToolApprovalRepository,
  tenant: TenantContext,
  input: {
    turnId: string;
    attemptId: string;
    toolName: string;
    argumentsHash: string;
    toolVersion?: string | null;
  },
  decidedBy: string,
): Promise<boolean> {
  const approval = await repo.recordToolApproval(tenant, {
    ...input,
    requester: tenant.subjectUserId,
    state: "pending",
  });
  const actor = tenant.actorId ?? tenant.subjectUserId;
  const granted = await repo.decideToolApproval(
    tenant,
    approval.id,
    "granted",
    decidedBy || `${FULL_ACCESS_DECIDER_PREFIX}${actor}`,
  );
  return granted !== null;
}

async function executeAuthorizedProactiveAction(
  authorizer: ProactiveActionAuthorizer,
  tenant: TenantContext,
  actionId: string,
  execute: () => Promise<ToolExecutionResult>,
): Promise<ToolExecutionResult> {
  try {
    await authorizer.markRunning(tenant, actionId);
    const result = await execute();
    if (result.ok) await authorizer.markExecuted(tenant, actionId, result.output);
    else await authorizer.markFailed(tenant, actionId, result.error ?? "tool_execution_failed");
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await authorizer.markFailed(tenant, actionId, message).catch(() => undefined);
    return { ok: false, error: message };
  }
}

/**
 * 给静态 Contribution 工具补齐通用写工具授权门：
 * readOnly 直接执行；写工具命中显式授权或本 Turn 完全访问后执行。
 */
export function createApprovalGatedToolProvider(
  provider: ToolProviderPort,
  tenant: TenantContext,
  repo: ToolApprovalRepository,
  proactiveActionAuthorizer?: ProactiveActionAuthorizer,
): ToolProviderPort {
  const specs = new Map(provider.tools.map((tool) => [tool.name, tool]));
  return {
    tools: provider.tools,
    async execute(input: ToolExecutionInput): Promise<ToolExecutionResult> {
      const spec = specs.get(input.name);
      if (!spec || spec.readOnly) return provider.execute(input);

      const argumentsHash = stableStringify(input.arguments);
      const granted = await findExplicitToolApproval(repo, tenant, {
        toolName: input.name,
        argumentsHash,
      });
      if (granted) return provider.execute(input);

      if (getRequestToolApprovalMode(tenant) === "full_access") {
        if (proactiveActionAuthorizer) {
          const authorization = await proactiveActionAuthorizer.authorize(tenant, {
            turnId: input.turnId,
            attemptId: input.attemptId,
            invocationId: input.invocationId,
            toolId: input.name,
            toolName: input.name,
            category: "system",
            safetyLevel: "write_with_approval",
            arguments: input.arguments,
          });
          if (authorization.authorized) {
            const recorded = await recordAutomaticApproval(repo, tenant, {
              turnId: input.turnId,
              attemptId: input.attemptId,
              toolName: input.name,
              argumentsHash,
            }, authorization.decidedBy);
            if (!recorded) {
              await proactiveActionAuthorizer.markFailed(
                tenant,
                authorization.action.id,
                "proactive_action_approval_not_recorded",
              );
              return { ok: false, error: "proactive_action_approval_not_recorded" };
            }
            return executeAuthorizedProactiveAction(
              proactiveActionAuthorizer,
              tenant,
              authorization.action.id,
              () => provider.execute(input),
            );
          }
        }
        const actor = tenant.actorId ?? tenant.subjectUserId;
        const recorded = await recordAutomaticApproval(repo, tenant, {
          turnId: input.turnId,
          attemptId: input.attemptId,
          toolName: input.name,
          argumentsHash,
        }, `${FULL_ACCESS_DECIDER_PREFIX}${actor}`);
        if (!recorded) return { ok: false, error: "full_access_approval_not_recorded" };
        return provider.execute(input);
      }

      const approval = await repo.recordToolApproval(tenant, {
        turnId: input.turnId,
        attemptId: input.attemptId,
        toolName: input.name,
        argumentsHash,
        requester: tenant.subjectUserId,
        state: "pending",
      });
      return {
        ok: false,
        needsApproval: { approvalId: approval.id, toolName: input.name, argumentsHash },
      };
    },
  };
}

/**
 * 把主仓 ToolRuntime（tool_registrations + handler）适配为 agent-loop 的 ToolProviderPort：
 * - read_only：AI 可自主调用（PET-05）；
 * - write_with_approval：需已授权（toolName+参数哈希匹配 granted）才执行，否则生成 pending 授权并返回 needsApproval（阶段 3a）；
 * - 未注册 / privileged 一律拒绝（fail-closed）；工具停用由 registry enabled 拦截。
 */
export function createRuntimeToolProvider(
  runtime: ToolRuntime,
  tenant: TenantContext,
  deps: {
    conversationRepo: SqliteConversationRepository;
    proactiveActionAuthorizer?: ProactiveActionAuthorizer;
  },
): ToolProviderPort {
  return {
    // 工具清单随注册表动态变化，不在此静态缓存（execute 时实时校验）
    tools: [],
    async execute(input: ToolExecutionInput): Promise<ToolExecutionResult> {
      const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : "tool_execution_error");
      const registrations = await runtime.listTools();
      const tool = registrations.find((t) => t.name === input.name && t.enabled === 1);
      if (!tool) {
        return { ok: false, error: `unregistered_tool: ${input.name}` };
      }

      // 只读工具：自主执行
      if (tool.safetyLevel === "read_only") {
        try {
          const output = await runtime.callTool(tenant, tool.id, input.arguments, { approval: false });
          return { ok: true, output };
        } catch (err) {
          return { ok: false, error: errorMessage(err) };
        }
      }

      // 写工具（write_with_approval / privileged）：须已授权（参数哈希匹配 + granted），否则生成待决授权。
      // privileged 与 write 同流程；「仅管理员可批准」由路由 decideToolApproval 的管理员校验把关（3b）。
      if (tool.safetyLevel === "write_with_approval" || tool.safetyLevel === "privileged") {
        const hash = stableStringify(input.arguments);
        const granted = await findExplicitToolApproval(deps.conversationRepo, tenant, {
          toolName: tool.name,
          argumentsHash: hash,
        });
        if (granted) {
          try {
            const output = await runtime.callTool(tenant, tool.id, input.arguments, { approval: true });
            return { ok: true, output };
          } catch (err) {
            return { ok: false, error: errorMessage(err) };
          }
        }
        // 主动智能模式下，全动作授权包可覆盖普通写、外部、privileged 与不可逆动作；
        // 每次执行仍绑定当前画像修订/租约/scope 并写入本地动作账本。
        if (
          getRequestToolApprovalMode(tenant) === "full_access" &&
          deps.proactiveActionAuthorizer
        ) {
          const authorization = await deps.proactiveActionAuthorizer.authorize(tenant, {
            turnId: input.turnId,
            attemptId: input.attemptId,
            invocationId: input.invocationId,
            toolId: tool.id,
            toolName: tool.name,
            category: tool.category,
            safetyLevel: tool.safetyLevel,
            requiredPermissions: tool.requiredPermissionsJson,
            arguments: input.arguments,
          });
          if (authorization.authorized) {
            const recorded = await recordAutomaticApproval(deps.conversationRepo, tenant, {
              turnId: input.turnId,
              attemptId: input.attemptId,
              toolName: tool.name,
              argumentsHash: hash,
              toolVersion: tool.updatedAt,
            }, authorization.decidedBy);
            if (!recorded) {
              await deps.proactiveActionAuthorizer.markFailed(
                tenant,
                authorization.action.id,
                "proactive_action_approval_not_recorded",
              );
              return { ok: false, error: "proactive_action_approval_not_recorded" };
            }
            return executeAuthorizedProactiveAction(
              deps.proactiveActionAuthorizer,
              tenant,
              authorization.action.id,
              async () => {
                try {
                  const output = await runtime.callTool(tenant, tool.id, input.arguments, {
                    approval: true,
                    proactiveAuthorization: true,
                  });
                  return { ok: true, output };
                } catch (error) {
                  return { ok: false, error: errorMessage(error) };
                }
              },
            );
          }
        }
        // CR-022 fallback：普通写工具可由 Turn full_access 预授权；privileged 无主动授权时仍走管理员通道。
        if (
          tool.safetyLevel === "write_with_approval" &&
          getRequestToolApprovalMode(tenant) === "full_access"
        ) {
          const actor = tenant.actorId ?? tenant.subjectUserId;
          const recorded = await recordAutomaticApproval(deps.conversationRepo, tenant, {
            turnId: input.turnId,
            attemptId: input.attemptId,
            toolName: tool.name,
            argumentsHash: hash,
            toolVersion: tool.updatedAt,
          }, `${FULL_ACCESS_DECIDER_PREFIX}${actor}`);
          if (!recorded) return { ok: false, error: "full_access_approval_not_recorded" };
          try {
            const output = await runtime.callTool(tenant, tool.id, input.arguments, { approval: true });
            return { ok: true, output };
          } catch (err) {
            return { ok: false, error: errorMessage(err) };
          }
        }
        const approval = await deps.conversationRepo.recordToolApproval(tenant, {
          turnId: input.turnId,
          attemptId: input.attemptId,
          toolName: tool.name,
          argumentsHash: hash,
          requester: tenant.subjectUserId,
          state: "pending",
          toolVersion: tool.updatedAt,
        });
        return { ok: false, needsApproval: { approvalId: approval.id, toolName: tool.name, argumentsHash: hash } };
      }

      // 其它（含不可识别的 safetyLevel）：fail-closed 拒绝
      return { ok: false, error: `requires_approval: ${tool.id}（未支持的安全级别）` };
    },
  };
}

/** 参数规范化哈希：key 排序，保证等价 JSON 命中同一授权 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 阶段 2d 工具路径脚本（AERVOX_LOOP_PROVIDER=scripted 时使用；跨 Step 验证只读工具链） */
export const API_TOOL_SCRIPT: readonly ReplayStep[] = [
  {
    text: "我先查一下学习笔记。",
    toolCalls: [{ id: "call_api_1", name: "aervox_notes_search", arguments: { query: "复习计划" } }],
  },
  { text: "查到了：今天复习三角函数。", toolCalls: [] },
];

/** 阶段 3a 写工具脚本（AERVOX_LOOP_PROVIDER=scripted-write；单 Step 请求写工具 → 审批待决） */
export const API_WRITE_SCRIPT: readonly ReplayStep[] = [
  {
    text: "我需要保存一条复习笔记。",
    toolCalls: [{ id: "call_write_1", name: "aervox_save_note", arguments: { content: "今日复习三角函数" } }],
  },
];

/** 3b privileged 管理员通道脚本（AERVOX_LOOP_PROVIDER=scripted-privileged；单 Step 请求特权工具） */
export const API_PRIVILEGED_SCRIPT: readonly ReplayStep[] = [
  {
    text: "需要执行特权操作。",
    toolCalls: [{ id: "call_priv_1", name: "aervox_privileged_op", arguments: { op: "export_all" } }],
  },
];

/** CAP-016 刷题闭环脚本（AERVOX_LOOP_PROVIDER=scripted-quiz；record_practice_attempt 落库验证） */
export const API_QUIZ_SCRIPT: readonly ReplayStep[] = [
  {
    text: "我来记录本次作答。",
    toolCalls: [
      {
        id: "call_quiz_1",
        name: "record_practice_attempt",
        arguments: {
          prompt: "1 + 1 等于几？",
          questionType: "short_answer",
          userAnswer: "3",
          correctAnswer: "2",
          judgement: "incorrect",
          explanation: "基础加法：1 + 1 = 2。",
        },
      },
    ],
  },
  { text: "答错了，正确答案是 2。", toolCalls: [] },
];

/** 迁移期接线：把 Loop 未完成/配置失败写为 error 事件 + Failed 终态（不抛到 HTTP 层） */
async function failTurnWithError(
  store: SqliteExecutionStore,
  turnId: string,
  attemptId: string,
  message: string,
): Promise<void> {
  await store.appendEvent({
    turnId,
    attemptId,
    sequence: await store.nextSequence(turnId),
    eventType: "error",
    data: {
      code: "MODEL_UNAVAILABLE",
      retryable: false,
      message,
      lastSequence: Math.max(0, (await store.nextSequence(turnId)) - 1),
    },
    safetyDecision: "approved",
    // B1：Attempt 未被 claim（fencing=0）；携带期望值使事件写入走 fencing CAS（抢占后自然被拒）
    expectedFencingToken: 0,
  }).catch(() => undefined);
  await store.finalizeAttempt({ turnId, attemptId, status: "Failed" }).catch(() => undefined);
}

/**
 * Loop 模型 Provider 构建（Leader 与 5c 子任务共用）。
 * 选择（AERVOX_LOOP_PROVIDER）：replay（默认确定性回放）/ scripted（两步工具链验证）/
 * scripted-write / scripted-privileged / llm（CR-015 真实配置；anthropic 明示不支持）。
 */
export async function buildLoopProvider(
  tenant: TenantContext,
  llmConfigService?: LLMConfigService,
  options: { requireLocalOnly?: boolean } = {},
): Promise<ModelProviderPort> {
  // 缺陷 E：Provider 选择经 @aervox/config 集中解析（AERVOX_LOOP_PROVIDER 启动期枚举校验）；
  // 每次调用读取，避免模块级缓存导致测试/配置热变失效。
  const { loopProvider: mode } = loadApiConfig();
  if (mode === "replay") return createReplayProvider();
  if (mode === "scripted") return createScriptedProvider(API_TOOL_SCRIPT);
  if (mode === "scripted-write") return createScriptedProvider(API_WRITE_SCRIPT);
  if (mode === "scripted-privileged") return createScriptedProvider(API_PRIVILEGED_SCRIPT);
  if (mode === "scripted-quiz") return createScriptedProvider(API_QUIZ_SCRIPT);
  if (mode === "llm") {
    if (!llmConfigService) {
      throw new Error("llm_provider_unavailable: LLMConfigService 未接线");
    }
    const cfg = await llmConfigService.getConfig(tenant);
    if (!cfg.enabled) throw new Error("llm_disabled: 当前租户未启用 LLM 配置");
    if (cfg.providerType === "anthropic") {
      throw new Error("anthropic_unsupported: 阶段 2e 仅支持 OpenAI 兼容协议（openai/deepseek/ollama/custom_openai）");
    }
    if (options.requireLocalOnly && !isLiteralLoopbackUrl(cfg.baseUrl)) {
      throw new Error("proactive_local_provider_required: 主动画像上下文禁止发送到非本机模型端点");
    }
    // CR-027：思考型模型经 settings.requestTimeoutMs（空闲超时，ms）放宽上游静默上限；
    // provider 语义为「每收到一段数据即重置」，默认 45s 空闲。
    const requestTimeoutMs = Number(cfg.settings?.requestTimeoutMs);
    return createOpenAICompatProvider({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      modelId: cfg.modelId,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      ...(Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? { timeoutMs: requestTimeoutMs } : {}),
      redirect: options.requireLocalOnly ? "error" : undefined,
    });
  }
  return createReplayProvider();
}

/**
 * 迁移期接线：创建 Turn 后立即执行一次 Loop。
 * Provider 选择见 buildLoopProvider；工具来源经 compose 合并（runtime / subagent / workflow Contribution）。
 */
export async function runLoopTurnOnce(
  repo: SqliteConversationRepository,
  tenant: TenantContext,
  input: { turnId: string; sessionId: string; attemptId: string; userMessage: string },
  deps: {
    toolRuntime?: ToolRuntime;
    llmConfigService?: LLMConfigService;
    /** 2d：删除/撤权水位未追平 → Loop fail-closed（AVX-HAR-001 §11.3） */
    deletionGate?: import("@aervox/agent-loop").DeletionGatePort;
    /** 5a-2：受控收件箱消费（每 Step claim next-step → 注入 → ack；缺失时跳过） */
    inbox?: InboxPort;
    /** 5b：渐进披露的 Skill 清单（name+description；模型按需读取全文；缺省不注入） */
    skills?: SkillDescriptor[];
    /**
     * 5c：Subagent 委托执行器工厂（request 级 tenant 绑定后创建 SubagentPort）。
     * 注入时 `subagent_delegate` 进入工具清单；缺失则不被贡献（行为与既有一致）。
     */
    subagentFactory?: (tenant: TenantContext) => SubagentPort;
    /** 5c：已注册 Workflow 定义清单（贡献 `workflow_run` 工具 + GET /v1/workflows 元数据） */
    workflows?: WorkflowDefinition[];
  /**
     * 阶段 7：ModelRun/ContextManifest 落库口（可选委托 SqlitePlatformRepository；
     * 缺省不记录，兼容既有行为）。Step 级可追溯写入不进 Loop 控制流。
     */
    platformRepo?: import("@aervox/database").SqlitePlatformRepository;
    /** UQ-01：向用户提问协调端口（挂起与唤醒） */
    userQuestionPort?: UserQuestionPort;
    /** CAP-016：刷题模式作答落库端口（AI 判定后写 questions + question_attempts） */
    practiceAttemptPort?: PracticeAttemptPort;
    /** CAP-033：主动智能全动作授权与本地动作账本。 */
    proactiveActionAuthorizer?: ProactiveActionAuthorizer;
    /** CAP-033：本地画像声明来源；仅在有效且本地模型准入时注入。 */
    proactiveRepository?: IProactiveProfileRepository;
  } = {},
): Promise<void> {
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

  let provider: ModelProviderPort;
  let proactiveProfilePrompt = "";
  try {
    const proactiveStatus = deps.proactiveRepository
      ? await deps.proactiveRepository.getEffectiveStatus(tenant)
      : null;
    const proactiveActive = proactiveStatus?.effectiveState === "active";
    provider = await buildLoopProvider(tenant, deps.llmConfigService, {
      requireLocalOnly: proactiveActive,
    });
    if (proactiveActive && deps.proactiveRepository) {
      proactiveProfilePrompt = await loadProactiveProfilePrompt(deps.proactiveRepository, tenant);
    }
  } catch (err) {
    await failTurnWithError(store, input.turnId, input.attemptId, err instanceof Error ? err.message : "provider_unavailable");
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
        )
      : undefined;
  const runtimeProvider = deps.toolRuntime
    ? createRuntimeToolProvider(deps.toolRuntime, tenant, {
        conversationRepo: repo,
        proactiveActionAuthorizer: deps.proactiveActionAuthorizer,
      })
    : undefined;
  const tools = contributionProvider && runtimeProvider
    ? composeToolProviders([contributionProvider], { fallback: runtimeProvider })
    : contributionProvider ?? runtimeProvider;
  // 识别当前消息是否带专注模式前缀或标识，动态决定是否注入专注模式专属 Prompt
  const isStudyMode =
    input.userMessage.includes("[模式：专注模式]") ||
    input.userMessage.includes("[模式：陪学讲解]") ||
    input.userMessage.includes("[模式：深度拆解]");
  // CAP-016 刷题模式触发：按钮前缀（任何模式生效）或 专注模式下的刷题关键词（避免日常聊天误触发）
  const hasQuizPrefix = input.userMessage.includes("[模式：刷题模式]");
  const quizKeywords = /来几道题|来几道|刷题|出几道题|考考我|出题/;
  const isQuizMode = hasQuizPrefix || (isStudyMode && quizKeywords.test(input.userMessage));
  // 5b：默认启用 Base System Prompt（含核心工具指引）与 Skill 渐进披露；压缩 seam 默认关闭，
  // 设置 AERVOX_LOOP_COMPACTION=rule 启用内置规则式摘要。
  let contextBuilder = createComposedContextBuilder({
    base: defaultContextBuilder,
    baseSystemPrompt: {
      assistantName: "思隅 (Aervox)",
      activeTools: tools?.tools,
      studyMode: isStudyMode,
      quizMode: isQuizMode,
    },
    skills: deps.skills,
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
      execution: store,
      provider,
      contextBuilder,
      tools,
      deletionGate: deps.deletionGate,
      inbox: deps.inbox,
    },
    input,
  );
  // 以 Loop 结果对齐 turns 状态；skipped（幂等保护）不覆盖。
  if (result.status === "completed") {
    await repo.updateTurnStatus(tenant, input.turnId, "Completed");

    // CAP-007 / CAP-002: 仅在专注模式下，后处理阶段异步抽取文本中的术语并写入 turn_stream_events (terms_extracted)
    if (isStudyMode) {
      try {
        const events = await repo.getStreamEvents(tenant, input.turnId, 0);
        let fullAssistantText = "";
        let lastSeq = 0;
        let lastMessageId: string | undefined;

        for (const ev of events) {
          if (ev.sequence > lastSeq) lastSeq = ev.sequence;
          if (ev.eventType === "message" && (ev.data as { messageId?: string }).messageId) {
            lastMessageId = (ev.data as { messageId?: string }).messageId;
          }
          if (ev.eventType === "delta" && typeof (ev.data as { text?: string }).text === "string") {
            fullAssistantText += (ev.data as { text?: string }).text;
          }
        }

        let terms = fullAssistantText.trim().length > 0 ? await extractTerms(fullAssistantText) : [];
        if (terms.length === 0 && input.userMessage) {
          terms = await extractTerms(input.userMessage);
        }
        if (terms.length > 0) {
          await repo.appendStreamEvent(tenant, {
            id: `tme_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
            turnId: input.turnId,
            sequence: lastSeq + 1,
            eventType: "terms_extracted",
            payloadVersion: 1,
            data: {
              turnId: input.turnId,
              messageId: lastMessageId,
              terms,
            },
          });
        }
      } catch (err) {
        // 术语抽取属于增强后处理，吞掉异常防止影响 Turn 最终完成态
      }
    }
  }
}
