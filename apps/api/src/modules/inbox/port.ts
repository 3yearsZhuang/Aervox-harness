/**
 * Aervox｜思隅 @aervox/api — inbox 仓储 → agent-loop InboxPort 租户适配器（阶段 5a-2）
 *
 * 组合根适配（ADR-016 分层）：API 组合根持有 SQLite 仓储，按请求租户绑定后
 * 提供给 agent-loop 消费（每 Step claim next-step → 注入上下文 → ack）。
 * agent-loop 应用层不导入 @aervox/database。
 */
import type {
  AgentInboxCommand,
  AgentInboxConsumeBoundary,
  AgentInboxItem,
  AgentInboxItemType,
  AgentInboxItemStatus,
  InboxPort,
} from "@aervox/agent-loop";
import type { AgentInboxItemModel, SqliteAgentInboxRepository, TenantContext } from "@aervox/database";

let seq = 0;
const nextId = (): string => `ibx_${Date.now().toString(36)}_${(++seq).toString(36)}`;

/** 数据库模型 → Loop 应用层模型（映射 status/type 枚举；过滤租户实现细节） */
const toLoopItem = (item: AgentInboxItemModel): AgentInboxItem => ({
  id: item.id,
  idempotencyKey: item.idempotencyKey,
  sessionId: item.sessionId,
  ...(item.attemptId ? { attemptId: item.attemptId } : {}),
  ...(item.stepId ? { stepId: item.stepId } : {}),
  type: item.type as AgentInboxItemType,
  orderingSeq: item.orderingSeq,
  sourceActor: item.sourceActor as AgentInboxItem["sourceActor"],
  payload: item.payload,
  status: item.status as AgentInboxItemStatus,
  consumeBoundary: item.consumeBoundary as AgentInboxConsumeBoundary,
  ...(item.claimedAt ? { claimedAt: item.claimedAt } : {}),
  ...(item.ackedAt ? { ackedAt: item.ackedAt } : {}),
  ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
  createdAt: item.createdAt,
});

/** 绑定租户的 InboxPort 实现（供 agent-loop executor 消费 / Host 接线复用） */
export function createTenantInboxPort(
  repo: SqliteAgentInboxRepository,
  tenant: TenantContext,
): InboxPort {
  return {
    async enqueue(command: AgentInboxCommand): Promise<AgentInboxItem> {
      const item = await repo.enqueue(tenant, {
        id: nextId(),
        idempotencyKey: command.idempotencyKey,
        sessionId: command.sessionId,
        attemptId: command.attemptId ?? null,
        stepId: command.stepId ?? null,
        type: command.type,
        sourceActor: command.sourceActor,
        payload: command.payload,
        consumeBoundary: command.consumeBoundary,
        expiresAt: command.expiresAt ?? null,
      });
      return toLoopItem(item);
    },
    async claimForConsumption(input) {
      const items = await repo.claimForConsumption(tenant, {
        sessionId: input.sessionId,
        attemptId: input.attemptId ?? null,
        type: input.type,
        limit: input.limit,
      });
      return items.map(toLoopItem);
    },
    async ack(input) {
      await repo.acknowledge(tenant, input.itemIds);
    },
  };
}