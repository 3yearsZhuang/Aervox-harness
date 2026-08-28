/**
 * Aervox｜思隅 @aervox/agent-loop — 内存 Inbox 实现（阶段 5a 测试骨架）
 *
 * 实现 InboxPort 供单元测试与宿主开发夹具使用；生产由宿主以 @aervox/database
 * 仓储适配。行为约定以本文件为基准（ADR-017 claim/ack、幂等、边界过滤）。
 */
import type { InboxPort } from "./ports.js";
import type {
  AgentInboxCommand,
  AgentInboxConsumeBoundary,
  AgentInboxItem,
  AgentInboxItemStatus,
} from "./types.js";

export class InMemoryInbox implements InboxPort {
  private readonly itemsById = new Map<string, AgentInboxItem>();
  private readonly items = new Set<string>(); // 已入队的 idempotencyKey

  private readonly boundaryOf = (command: AgentInboxCommand): AgentInboxConsumeBoundary =>
    command.consumeBoundary ?? (command.type === "followup" ? "next-turn" : "next-step");

  async enqueue(command: AgentInboxCommand): Promise<AgentInboxItem> {
    // 幂等：同 idempotencyKey 已存在则返回既有项（ADR-017：重复提交安全）
    if (this.items.has(command.idempotencyKey)) {
      const existing = [...this.itemsById.values()].find(
        (i) => i.idempotencyKey === command.idempotencyKey,
      );
      if (existing) return existing;
    }
    const now = new Date().toISOString();
    const item: AgentInboxItem = {
      id: `inbox_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      idempotencyKey: command.idempotencyKey,
      sessionId: command.sessionId,
      attemptId: command.attemptId,
      stepId: command.stepId,
      type: command.type,
      orderingSeq: this.itemsById.size + 1,
      sourceActor: command.sourceActor,
      payload: command.payload,
      status: "pending",
      consumeBoundary: this.boundaryOf(command),
      expiresAt: command.expiresAt,
      createdAt: now,
    };
    this.itemsById.set(item.id, item);
    this.items.add(command.idempotencyKey);
    return item;
  }

  async claimForConsumption(input: {
    sessionId: string;
    attemptId?: string;
    type: AgentInboxConsumeBoundary;
    limit?: number;
  }): Promise<AgentInboxItem[]> {
    const limit = input.limit ?? 20;
    const now = Date.now();
    const candidates = [...this.itemsById.values()]
      .filter((i) => i.sessionId === input.sessionId)
      .filter((i) => i.consumeBoundary === input.type)
      .filter((i) => i.status === "pending")
      .filter((i) => {
        // next-step 需 attemptId 定位；next-turn 忽略 attemptId（可空）
        if (input.type === "next-step") {
          if (!input.attemptId) return false;
          return i.attemptId === input.attemptId;
        }
        return true;
      })
      .filter((i) => !i.expiresAt || Date.parse(i.expiresAt) > now) // 未过期
      .sort((a, b) => a.orderingSeq - b.orderingSeq)
      .slice(0, limit);
    const claimedAt = new Date().toISOString();
    const claimed: AgentInboxItem[] = [];
    for (const item of candidates) {
      item.status = "claimed";
      item.claimedAt = claimedAt;
      claimed.push({ ...item });
    }
    return claimed;
  }

  async ack(input: { itemIds: string[] }): Promise<void> {
    const ackedAt = new Date().toISOString();
    for (const id of input.itemIds) {
      const item = this.itemsById.get(id);
      if (!item) continue;
      // 只接受非 final 状态（pending/claimed）→ acknowledged；final 不再变更
      if (item.status === "acknowledged" || item.status === "expired") continue;
      item.status = "acknowledged";
      item.ackedAt = ackedAt;
    }
  }

  /** 测试钩子：按状态过滤查询 */
  list(status?: AgentInboxItemStatus): AgentInboxItem[] {
    const items = [...this.itemsById.values()];
    return status ? items.filter((i) => i.status === status) : items;
  }
}