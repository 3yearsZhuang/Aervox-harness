/**
 * Aervox｜思隅 @aervox/api — Agent Loop SQLite 执行存储适配 + 工具接线（阶段 1+2d）
 *
 * 实现 @aervox/agent-loop 的 ExecutionStorePort 与 ToolProviderPort（只读白名单），
 * 宿主为对话仓储 + 工具运行时；迁移期 native-agent-loop 在 API 进程内挂载
 * （AVX-HAR-001 §13），阶段 4 抽出独立 Host 时仅替换接线。
 */
import {
  createReplayProvider,
  createScriptedProvider,
  defaultContextBuilder,
  executeTurn,
} from "@aervox/agent-loop";
import type {
  AgentStreamEvent,
  AgentStreamEventInput,
  ExecutionStorePort,
  ReplayStep,
  ToolExecutionInput,
  ToolExecutionResult,
  ToolProviderPort,
} from "@aervox/agent-loop";
import type { SqliteConversationRepository, TenantContext } from "@aervox/database";
import type { ToolRuntime } from "../tools/runtime.js";

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
 * - 只读白名单（PET-05 read_only）可被 Loop 自主调用；
 * - 未注册 / write_with_approval / privileged 一律拒绝（fail-closed）。
 */
export function createRuntimeToolProvider(runtime: ToolRuntime, tenant: TenantContext): ToolProviderPort {
  return {
    // 工具清单随注册表动态变化，不在此静态缓存（execute 时实时校验）
    tools: [],
    async execute(input: ToolExecutionInput): Promise<ToolExecutionResult> {
      const registrations = await runtime.listTools();
      const tool = registrations.find((t) => t.name === input.name && t.enabled === 1);
      if (!tool) {
        return { ok: false, error: `unregistered_tool: ${input.name}` };
      }
      if (tool.safetyLevel !== "read_only") {
        return { ok: false, error: `requires_approval: ${tool.id}（write_with_approval / privileged）` };
      }
      try {
        const output = await runtime.callTool(tenant, tool.id, input.arguments, { approval: false });
        return { ok: true, output };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "tool_execution_error" };
      }
    },
  };
}

/** 阶段 2d 工具路径脚本（AERVOX_LOOP_PROVIDER=scripted 时使用；跨 Step 验证只读工具链） */
export const API_TOOL_SCRIPT: readonly ReplayStep[] = [
  {
    text: "我先查一下学习笔记。",
    toolCalls: [{ id: "call_api_1", name: "aervox_notes_search", arguments: { query: "复习计划" } }],
  },
  { text: "查到了：今天复习三角函数。", toolCalls: [] },
];

/** 迁移期接线：创建 Turn 后立即执行一次 Loop（Replay 默认；AERVOX_LOOP_PROVIDER=scripted 走工具链） */
export async function runLoopTurnOnce(
  repo: SqliteConversationRepository,
  tenant: TenantContext,
  input: { turnId: string; sessionId: string; attemptId: string; userMessage: string },
  deps: { toolRuntime?: ToolRuntime } = {},
): Promise<void> {
  const store = new SqliteExecutionStore(repo, tenant);
  const useToolScript = process.env.AERVOX_LOOP_PROVIDER === "scripted";
  const provider = useToolScript ? createScriptedProvider(API_TOOL_SCRIPT) : createReplayProvider();
  const tools = deps.toolRuntime ? createRuntimeToolProvider(deps.toolRuntime, tenant) : undefined;
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