/**
 * Aervox｜思隅 @aervox/host-agent — SQLite Subagent 委托执行器（阶段 5c）
 *
 * 规则依据：AVX-HAR-001 §13 阶段 5c「Subagent/Workflow 通过独立 Tool/Provider Contribution」：
 * - 实现 @aervox/agent-loop 的 SubagentPort「宿主侧」：创建独立子 turn/attempt 落库
 *   （可审计/恢复），嵌套执行后返回结构化结果；
 * - 隔离原则：子上下文仅注入 task（defaultContextBuilder 起始即用户消息），不注入父历史；
 * - 递归防护：子任务工具集不得包含 subagent.delegate / workflow.run，执行前强校验 fail-closed；
 * - 幂等：parentAttemptId + parentExecutionId 唯一（subagent_runs），崩溃/重试复用既有子任务；
 * - 子任务默认无工具（纯推理）；宿主可选注入 childTools 提供受限工具集。
 */
import {
  defaultContextBuilder,
  executeTurn,
  SUBAGENT_DELEGATE_TOOL,
  WORKFLOW_RUN_TOOL,
} from "@aervox/agent-loop";
import type {
  AttemptStatus,
  ContextBuilderPort,
  ModelProviderPort,
  SubagentPort,
  SubagentRunResult,
  ToolProviderPort,
} from "@aervox/agent-loop";
import type { ISubagentRunRepository, SqliteConversationRepository, TenantContext } from "@aervox/database";
import type { SqliteExecutionStore } from "./sqlite-execution-store.js";

export interface SqliteSubagentPortDeps {
  /** 子任务归属租户（与父一致；仓储访问强绑定） */
  tenant: TenantContext;
  /** 子任务执行存储（与父同源：事件/工具账本/终态落同一库） */
  store: SqliteExecutionStore;
  /** 建子 turn/attempt（编程式，不触发 API 路由/Outbox——由本执行器直接驱动） */
  conversationRepo: SqliteConversationRepository;
  /** subagent_runs 关联仓储（溯源 + 结果摘要） */
  runRepo: ISubagentRunRepository;
  /** 子任务模型提供者（宿主决定模型/配置；支持异步构建，如按配置初始化 LLM provider） */
  providerBuilder: (input: {
    turnId: string;
    sessionId: string;
    attemptId: string;
  }) => ModelProviderPort | Promise<ModelProviderPort>;
  /** 子任务上下文构建（缺省 defaultContextBuilder：仅 task 开头，隔离父历史） */
  contextBuilder?: ContextBuilderPort;
  /**
   * 子任务工具集（可选；缺省无工具——纯推理子任务）。
   * 递归防护：不得含 subagent.delegate / workflow.run，delegate 前强校验。
   */
  childTools?: ToolProviderPort;
  /** 子任务 Step 上限（缺省 4；比 Leader 的 8 更保守，防子任务无限扩张） */
  maxSubSteps?: number;
  /** Turn/Attempt/Run id 生成（测试注入确定性；缺省时间戳 + 随机后缀） */
  genId?: (prefix: string) => string;
}

/** 子任务工具集禁用清单（递归防护；Leader 与子任务之间不得互相委托） */
const CHILD_FORBIDDEN_TOOLS = new Set([SUBAGENT_DELEGATE_TOOL, WORKFLOW_RUN_TOOL]);

const defaultGenId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export function createSqliteSubagentPort(deps: SqliteSubagentPortDeps): SubagentPort {
  const {
    tenant,
    store,
    conversationRepo,
    runRepo,
    providerBuilder,
    contextBuilder,
    childTools,
    maxSubSteps,
  } = deps;
  const builder = contextBuilder ?? defaultContextBuilder;
  const genId = deps.genId ?? defaultGenId;
  const subMaxSteps = maxSubSteps ?? 4;

  return {
    async delegate(input): Promise<SubagentRunResult> {
      const { parentTurnId, parentAttemptId, parentExecutionId, sessionId, task } = input;

      // 幂等：同一父执行键已有子任务 → 复用既有结果（崩溃/重试不重复创建；Host 幂等键语义 §9）
      const existing = await runRepo.getRunByParentExecution(tenant, parentAttemptId, parentExecutionId);
      if (existing) {
        return {
          subTurnId: existing.subTurnId,
          subAttemptId: existing.subAttemptId,
          status: existing.status as AttemptStatus,
          resultText: existing.resultText ?? undefined,
          error: existing.error ?? undefined,
        };
      }

      // 递归防护：子任务工具集不得含 delegate/workflow（fail-closed）
      if (childTools && childTools.tools.some((t) => CHILD_FORBIDDEN_TOOLS.has(t.name))) {
        throw new Error(`subagent childTools must not contain ${[...CHILD_FORBIDDEN_TOOLS].join(" / ")}`);
      }

      const subTurnId = genId("turn");
      const subAttemptId = genId("attempt");
      const runId = genId("subrun");

      // 1) 子任务落库（独立 turn/attempt ← 子事件流在子 turn 下审计；不写 Outbox）
      await conversationRepo.createTurnWithOutbox(
        tenant,
        { id: subTurnId, sessionId, idempotencyKey: `subagent:${parentExecutionId}` },
        { id: `msg_${subTurnId}_user`, content: task },
      );
      await conversationRepo.createTurnAttempt(tenant, subTurnId, { id: subAttemptId });
      await runRepo.createRun(tenant, {
        id: runId,
        sessionId,
        parentTurnId,
        parentAttemptId,
        parentExecutionId,
        subTurnId,
        subAttemptId,
        task,
      });

      // 2) 嵌套执行（executeTurn 内部 claim 子 attempt：Running+fencing0 → 可领）
      let status: AttemptStatus = "Failed";
      try {
        const provider = await providerBuilder({ turnId: subTurnId, sessionId, attemptId: subAttemptId });
        const result = await executeTurn(
          {
            execution: store,
            provider,
            contextBuilder: builder,
            tools: childTools,
            options: { maxSteps: subMaxSteps },
          },
          { turnId: subTurnId, sessionId, attemptId: subAttemptId, userMessage: task },
        );
        status =
          result.status === "completed"
            ? "Completed"
            : result.status === "cancelled"
              ? "Cancelled"
              : "Failed"; // Interrupted/skipped 收敛为 Failed：子任务无续跑，父侧可据 error 重试
      } catch (err) {
        status = "Failed";
        void err; // 终态信息由事件流 + run 行承载，不在此吞掉可观测面
      }

      // 3) 聚合子任务正文（delta 事件文本）→ 终态收口 run 行
      let resultText: string | undefined;
      let error: string | undefined;
      if (status === "Completed") {
        try {
          const events = await store.listEvents(subTurnId);
          resultText = events
            .filter((e) => e.eventType === "delta")
            .map((e) => ((e.data as { text?: string }).text ?? ""))
            .join("");
        } catch {
          resultText = undefined;
        }
      } else {
        error = status === "Cancelled" ? "subagent_cancelled" : "subagent_failed";
      }
      await runRepo.finalizeRun(tenant, runId, { status, resultText, error });

      return { subTurnId, subAttemptId, status, resultText, error };
    },
  };
}