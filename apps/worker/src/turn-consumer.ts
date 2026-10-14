/**
 * Aervox｜思隅 @aervox/worker — 异步 Turn 消费处理器（HLS-DEC-01）
 *
 * 消费 outbox_events 中的 turn.created / agent.turn.requested 事件：
 * 1. 依据 turnId 读取 Turn 与待执行 Attempt；
 * 2. 构造 SqliteExecutionStore（绑定 lease 与 fencingToken CAS）；
 * 3. 委托 @aervox/core 的 executeTurn 驱动模型与工具循环；
 * 4. 成功执行后推进 Attempt 终态，并由 Outbox 标记为已发布。
 *
 * 规则依据：AVX-HAR-001 §12.1、§12.2、ADR-004、ADR-021。
 */
import type { OutboxEventModel, SqliteConversationRepository, LocalContext, TurnModel } from "@aervox/repositories";
import type { OutboxEventHandler, OutboxCycleContext } from "./outbox-worker.js";
import { executeTurn, createComposedContextBuilder } from "@aervox/core";
import type { ModelProviderPort, ToolProviderPort, InboxPort, DeletionGatePort } from "@aervox/core";
import { SqliteExecutionStore, buildMemoryContext, type MemoryRecallPort } from "@aervox/host-agent";

export interface TurnConsumerDeps {
  repo: SqliteConversationRepository;
  provider: ModelProviderPort | ((turn: TurnModel) => Promise<ModelProviderPort>);
  tools?: ToolProviderPort;
  inbox?: InboxPort;
  deletionGate?: DeletionGatePort;
  memoryRecall?: MemoryRecallPort;
}

export function createTurnConsumerHandler(deps: TurnConsumerDeps): OutboxEventHandler {
  return async (event: OutboxEventModel, _ctx: OutboxCycleContext): Promise<void> => {
    let payload = event.payload as { turnId?: string; sessionId?: string; userMessage?: string } | undefined;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        // ignore JSON parse failure
      }
    }
    const turnId = payload?.turnId;
    if (!turnId) return;

    const localCtx: LocalContext = { workspaceId: "local", subjectUserId: "local" };
    const turn = await deps.repo.getTurn(localCtx, turnId);
    if (!turn) return;

    const attempts = await deps.repo.listTurnAttempts(localCtx, turnId);
    const runnableAttempt = attempts.find((a) => a.status === "Running" || a.status === "Pending");
    if (!runnableAttempt) return;

    const userMessage =
      payload?.userMessage ??
      (await deps.repo.getTurnUserMessage(localCtx, turnId)) ??
      "";

    const store = new SqliteExecutionStore(deps.repo, localCtx);
    const provider = typeof deps.provider === "function" ? await deps.provider(turn) : deps.provider;

    const historyPromise = deps.repo.getSessionHistory(localCtx, {
      sessionId: turn.sessionId,
      beforeTurnId: turnId,
    });
    const memoryPromise = deps.memoryRecall
      ? deps.memoryRecall
          .recall(localCtx, userMessage)
          .then(buildMemoryContext)
          .catch(() => null)
      : Promise.resolve(null);
    const [previous, recalled] = await Promise.all([historyPromise, memoryPromise]);

    const contextBuilder = createComposedContextBuilder({
      inbox: Boolean(deps.inbox),
      base: {
        build(context) {
          const index = context.messages.findIndex((m) => m.role !== "system");
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
    });

    const result = await executeTurn(
      {
        execution: store,
        provider,
        tools: deps.tools,
        inbox: deps.inbox,
        deletionGate: deps.deletionGate,
        contextBuilder,
      },
      {
        turnId,
        sessionId: turn.sessionId,
        attemptId: runnableAttempt.id,
        userMessage,
      },
    );

    if (result.status === "completed") {
      await deps.repo.updateTurnStatus(localCtx, turnId, "Completed");
    } else if (result.status === "failed") {
      await deps.repo.updateTurnStatus(localCtx, turnId, "Failed");
    }
  };
}
