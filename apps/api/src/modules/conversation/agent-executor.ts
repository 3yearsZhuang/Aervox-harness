/**
 * Aervox｜思隅 @aervox/api — Agent Loop SQLite 执行存储适配 + 工具接线（阶段 1+2d）
 *
 * 实现 @aervox/agent-loop 的 ExecutionStorePort 与 ToolProviderPort（只读白名单），
 * 宿主为对话仓储 + 工具运行时；迁移期 native-agent-loop 在 API 进程内挂载
 * （AVX-HAR-001 §13），阶段 4 抽出独立 Host 时仅替换接线。
 */
import {
  createOpenAICompatProvider,
  createReplayProvider,
  createScriptedProvider,
  defaultContextBuilder,
  executeTurn,
} from "@aervox/agent-loop";
import type {
  AgentStreamEvent,
  AgentStreamEventInput,
  ExecutionStorePort,
  ModelProviderPort,
  ReplayStep,
  ToolExecutionInput,
  ToolExecutionResult,
  ToolProviderPort,
} from "@aervox/agent-loop";
import type { SqliteConversationRepository, TenantContext } from "@aervox/database";
import type { ToolRuntime } from "../tools/runtime.js";
import type { LLMConfigService } from "../llm/service.js";

const now = (): string => new Date().toISOString();
let seqCounter = 0;
const nextEventId = (turnId: string): string =>
  `tev_${turnId}_${(++seqCounter).toString(36)}`;

const toAgentEvent = (row: {
  id: string;
  turnId: string;
  sequence: number;
  eventType: string;
  payloadVersion: number;
  data: unknown;
  occurredAt: string;
  attemptId?: string | null;
  safetyDecision?: string | null;
}): AgentStreamEvent => ({
  eventId: row.id,
  turnId: row.turnId,
  attemptId: row.attemptId ?? "",
  sequence: row.sequence,
  eventType: row.eventType as AgentStreamEvent["eventType"],
  payloadVersion: row.payloadVersion,
  data: row.data,
  safetyDecision: (row.safetyDecision as AgentStreamEvent["safetyDecision"]) ?? "pending",
  occurredAt: row.occurredAt,
});

export class SqliteExecutionStore implements ExecutionStorePort {
  constructor(
    private readonly repo: SqliteConversationRepository,
    private readonly tenant: TenantContext,
  ) {}

  async claimTurnAttempt(input: {
    turnId: string;
    attemptId: string;
    expectedFencingToken: number;
  }): Promise<{ ok: true; fencingToken: number } | { ok: false; reason: "not_runnable" | "already_claimed" }> {
    const res = await this.repo.claimTurnAttempt(this.tenant, {
      ...input,
      leaseId: `lease_${Date.now().toString(36)}`,
    });
    if (!res.ok) return { ok: false, reason: "already_claimed" };
    return { ok: true, fencingToken: res.fencingToken };
  }

  async nextSequence(turnId: string): Promise<number> {
    const events = await this.repo.getStreamEvents(this.tenant, turnId, 0);
    return events.length + 1;
  }

  async appendEvent(input: AgentStreamEventInput): Promise<AgentStreamEvent> {
    const created = await this.repo.appendStreamEvent(this.tenant, {
      id: nextEventId(input.turnId),
      turnId: input.turnId,
      sequence: input.sequence,
      eventType: input.eventType,
      data: input.data,
      occurredAt: now(),
      attemptId: input.attemptId,
      safetyDecision: input.safetyDecision,
    });
    return toAgentEvent(created);
  }

  async listEvents(turnId: string, afterSequence = 0): Promise<AgentStreamEvent[]> {
    const rows = await this.repo.getStreamEvents(this.tenant, turnId, afterSequence);
    return rows.map(toAgentEvent);
  }

  async finalizeAttempt(input: {
    turnId: string;
    attemptId: string;
    status: "Running" | "Completed" | "Failed" | "Interrupted";
  }): Promise<void> {
    await this.repo.finalizeTurnAttempt(this.tenant, {
      turnId: input.turnId,
      attemptId: input.attemptId,
      status: input.status,
    });
  }

  /** 工具副作用证据落库（tool_executions，AVX-HAR-001 §12） */
  async recordToolExecution(input: import("@aervox/agent-loop").ToolExecutionRecord): Promise<void> {
    await this.repo.recordToolExecution(this.tenant, {
      turnId: input.turnId,
      attemptId: input.attemptId,
      invocationId: input.invocationId,
      name: input.name,
      arguments: input.arguments,
      status: input.status,
      output: input.output,
      error: input.error ?? null,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
    });
  }
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
  deps: { conversationRepo: SqliteConversationRepository },
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

      // 写工具：须已授权（参数哈希匹配 + granted），否则生成待决授权
      if (tool.safetyLevel === "write_with_approval") {
        const hash = stableStringify(input.arguments);
        const granted = await deps.conversationRepo.findGrantedToolApproval(tenant, {
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

      // privileged：仅管理员通道，Loop 一律拒绝
      return { ok: false, error: `requires_approval: ${tool.id}（privileged 仅管理员通道）` };
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
  }).catch(() => undefined);
  await store.finalizeAttempt({ turnId, attemptId, status: "Failed" }).catch(() => undefined);
}

/**
 * 迁移期接线：创建 Turn 后立即执行一次 Loop。
 * Provider 选择（AERVOX_LOOP_PROVIDER）：replay（默认确定性回放）/ scripted（两步工具链验证）/ llm（CR-015 真实配置）。
 */
export async function runLoopTurnOnce(
  repo: SqliteConversationRepository,
  tenant: TenantContext,
  input: { turnId: string; sessionId: string; attemptId: string; userMessage: string },
  deps: { toolRuntime?: ToolRuntime; llmConfigService?: LLMConfigService } = {},
): Promise<void> {
  const store = new SqliteExecutionStore(repo, tenant);

  const buildProvider = async (): Promise<ModelProviderPort> => {
    const mode = process.env.AERVOX_LOOP_PROVIDER ?? "replay";
    if (mode === "scripted") return createScriptedProvider(API_TOOL_SCRIPT);
    if (mode === "scripted-write") return createScriptedProvider(API_WRITE_SCRIPT);
    if (mode === "llm") {
      if (!deps.llmConfigService) {
        throw new Error("llm_provider_unavailable: LLMConfigService 未接线");
      }
      const cfg = await deps.llmConfigService.getConfig(tenant);
      if (!cfg.enabled) throw new Error("llm_disabled: 当前租户未启用 LLM 配置");
      if (cfg.providerType === "anthropic") {
        throw new Error("anthropic_unsupported: 阶段 2e 仅支持 OpenAI 兼容协议（openai/deepseek/ollama/custom_openai）");
      }
      return createOpenAICompatProvider({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        modelId: cfg.modelId,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
      });
    }
    return createReplayProvider();
  };

  let provider: ModelProviderPort;
  try {
    provider = await buildProvider();
  } catch (err) {
    await failTurnWithError(store, input.turnId, input.attemptId, err instanceof Error ? err.message : "provider_unavailable");
    await repo.updateTurnStatus(tenant, input.turnId, "Failed").catch(() => undefined);
    return;
  }

  const tools = deps.toolRuntime ? createRuntimeToolProvider(deps.toolRuntime, tenant, { conversationRepo: repo }) : undefined;
  const result = await executeTurn(
    {
      execution: store,
      provider,
      contextBuilder: defaultContextBuilder,
      tools,
    },
    input,
  );
  // 以 Loop 结果对齐 turns 状态；skipped（幂等保护）不覆盖。
  if (result.status === "completed") {
    await repo.updateTurnStatus(tenant, input.turnId, "Completed");
  }
}