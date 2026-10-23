/**
 * Aervox｜思隅 @aervox/host-agent — SQLite Subagent 委托执行器（阶段 5c）
 *
 * 规则依据：AVX-HAR-001 §13 阶段 5c「Subagent/Workflow 通过独立 Tool/Provider Contribution」：
 * - 实现 @aervox/core 的 SubagentPort「宿主侧」：创建独立子 turn/attempt 落库
 *   （可审计/恢复），嵌套执行后返回结构化结果；
 * - 隔离原则：子上下文仅注入 task（defaultContextBuilder 起始即用户消息），不注入父历史；
 * - 递归防护：子任务工具集不得包含 subagent_delegate / workflow_run，执行前强校验 fail-closed；
 * - 幂等：parentAttemptId + parentExecutionId 唯一（subagent_runs），崩溃/重试复用既有子任务；
 * - 子任务默认无工具（纯推理）；宿主可选注入 childTools 提供受限工具集。
 */
import {
  defaultContextBuilder,
  claimAttemptExecution,
  awaitWithSignal,
  executeTurn,
  SUBAGENT_DELEGATE_TOOL,
  WORKFLOW_RUN_TOOL,
} from "@aervox/core";
import type {
  AttemptStatus,
  ContextBuilderPort,
  ModelProviderPort,
  SubagentPort,
  SubagentRunResult,
  ToolProviderPort,
} from "@aervox/core";
import type { ISubagentRunRepository, SubagentRunModel, LocalContext } from "@aervox/repositories";
import type { SqliteExecutionStore } from "./sqlite-execution-store.js";

export interface SqliteSubagentPortDeps {
  /** 子任务归属租户（与父一致；仓储访问强绑定） */
  ctx: LocalContext;
  /** 子任务执行存储（与父同源：事件/工具账本/终态落同一库） */
  store: SqliteExecutionStore;
  /** subagent_runs 关联仓储（溯源 + 结果摘要） */
  runRepo: ISubagentRunRepository;
  /** 子任务模型提供者（宿主决定模型/配置；支持异步构建，如按配置初始化 LLM provider） */
  providerBuilder: (input: {
    turnId: string;
    sessionId: string;
    attemptId: string;
    controlContext?: import("@aervox/core").ControlContext;
  }) => ModelProviderPort | Promise<ModelProviderPort>;
  /** 子任务上下文构建（缺省 defaultContextBuilder：仅 task 开头，隔离父历史） */
  contextBuilder?: ContextBuilderPort;
  /**
   * 子任务工具集（可选；缺省无工具——纯推理子任务）。
   * 递归防护：不得含 subagent_delegate / workflow_run，delegate 前强校验。
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
    ctx,
    store,
    runRepo,
    providerBuilder,
    contextBuilder,
    childTools,
    maxSubSteps,
  } = deps;
  const builder = contextBuilder ?? defaultContextBuilder;
  const genId = deps.genId ?? defaultGenId;
  const subMaxSteps = maxSubSteps ?? 4;

  const asResult = (run: SubagentRunModel): SubagentRunResult => ({
    subTurnId: run.subTurnId, subAttemptId: run.subAttemptId, status: run.status as AttemptStatus,
    resultText: run.resultText ?? undefined, error: run.error ?? undefined,
  });
  const terminal = new Set(["Completed", "Failed", "Interrupted", "Cancelled"]);
  const reconcile = async (run: SubagentRunModel): Promise<SubagentRunResult> => {
    const status = await store.getAttemptStatus({ turnId: run.subTurnId, attemptId: run.subAttemptId });
    if (status === null) throw new Error("subagent_attempt_unavailable");
    // Another owner may still hold the lease. Observation never authorizes replay.
    if (!terminal.has(status)) return { subTurnId: run.subTurnId, subAttemptId: run.subAttemptId, status: "Running" };
    if (run.status !== "Running") return asResult(run);
    const events = (await store.listEvents(run.subTurnId)).filter(event => event.attemptId === run.subAttemptId);
    const resultText = status === "Completed" ? events.filter(event => event.eventType === "delta")
      .map(event => (event.data as { text?: string }).text ?? "").join("") : undefined;
    const error = status === "Completed" ? undefined : status === "Cancelled" ? "subagent_cancelled"
      : status === "Interrupted" ? "subagent_interrupted" : "subagent_failed";
    const updated = await runRepo.finalizeRun(ctx, run.id, { status, resultText, error });
    if (updated) return asResult(updated);
    // A concurrent observer may have committed the same terminal projection first.
    const settled = await runRepo.getRunByParentExecution(ctx, run.parentAttemptId, run.parentExecutionId);
    if (!settled || settled.status === "Running") throw new Error("subagent_reconciliation_unavailable");
    return asResult(settled);
  };

  return {
    async delegate(input): Promise<SubagentRunResult> {
      const { parentTurnId, parentAttemptId, parentExecutionId, sessionId, task, controlContext } = input;
      controlContext?.abortSignal.throwIfAborted();

      // Reject recursive capability before any durable admission.
      if (childTools && childTools.tools.some(t => CHILD_FORBIDDEN_TOOLS.has(t.name))) {
        throw new Error(`subagent childTools must not contain ${[...CHILD_FORBIDDEN_TOOLS].join(" / ")}`);
      }
      const accepted = await runRepo.acceptRun(ctx, {
        id: genId("subrun"), sessionId, parentTurnId, parentAttemptId, parentExecutionId,
        subTurnId: genId("turn"), subAttemptId: genId("attempt"), task,
      });
      const run = accepted.run;
      const effectiveTurnId = run.subTurnId;
      const effectiveAttemptId = run.subAttemptId;
      if (!accepted.created) return reconcile(run);
      const identity = { turnId: effectiveTurnId, sessionId, attemptId: effectiveAttemptId };
      const lifecycle = await claimAttemptExecution(identity, { execution: store, controlContext });
      if (!lifecycle.ok) return reconcile(run);
      let status: AttemptStatus = "Failed";
      let failureReason: string | undefined;
      let handedOff = false;
      const execution: SqliteExecutionStore = Object.create(store);
      execution.claimTurnAttempt = async requested => {
        lifecycle.checkFailure();
        lifecycle.control.abortSignal.throwIfAborted();
        if (handedOff || requested.turnId !== effectiveTurnId || requested.attemptId !== effectiveAttemptId) {
          return { ok: false, reason: "already_claimed" };
        }
        handedOff = true;
        lifecycle.stopMonitoring();
        return lifecycle.claim;
      };
      try {
        const provider = await awaitWithSignal(Promise.resolve().then(() => providerBuilder({
          ...identity, controlContext: lifecycle.control,
        })), lifecycle.control.abortSignal);
        const result = await executeTurn({
          execution, provider, contextBuilder: builder, tools: childTools, controlContext: lifecycle.control,
          options: { maxSteps: subMaxSteps,
            ...(controlContext?.deadlineEpochMs !== undefined
              ? { maxTurnDurationMs: Math.max(1, controlContext.deadlineEpochMs - Date.now()) } : {}),
          },
        }, { ...identity, userMessage: task });
        status = result.status === "completed" ? "Completed" : result.status === "cancelled" ? "Cancelled"
          : result.status === "interrupted" ? "Interrupted" : "Failed";
      } catch (err) {
        failureReason = err instanceof Error ? err.message : String(err);
        // Model setup is part of admission. Its failure cannot leave a Running child.
        lifecycle.checkFailure();
        const sequence = (await store.listEvents(effectiveTurnId)).reduce((n, event) => Math.max(n, event.sequence), 0) + 1;
        const stopped = await lifecycle.terminator.prematureTermination(sequence);
        const result = stopped ?? await lifecycle.terminator.finalize(sequence, { status: "failed", reason: failureReason }, {
          eventType: "error", eventData: { code: "SUBAGENT_SETUP_FAILED", message: "Subagent execution failed", retryable: false },
          safetyDecision: "approved",
        });
        status = result.status === "cancelled" ? "Cancelled" : result.status === "interrupted" ? "Interrupted" : "Failed";
      } finally {
        lifecycle.dispose();
      }

      // 3) 聚合子任务正文（delta 事件文本）→ 终态收口 run 行
      let resultText: string | undefined;
      let error: string | undefined;
      if (status === "Completed") {
        try {
          const events = await store.listEvents(effectiveTurnId);
          resultText = events
            .filter((e) => e.eventType === "delta")
            .map((e) => ((e.data as { text?: string }).text ?? ""))
            .join("");
        } catch {
          resultText = undefined;
        }
      } else {
        error = status === "Cancelled" ? "subagent_cancelled" : (failureReason ?? (status === "Interrupted" ? "subagent_interrupted" : "subagent_failed"));
      }
      await runRepo.finalizeRun(ctx, run.id, { status, resultText, error });

      return { subTurnId: effectiveTurnId, subAttemptId: effectiveAttemptId, status, resultText, error };
    },
  };
}

