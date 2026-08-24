/**
 * Aervox｜思隅 @aervox/database — RecoveryControlLedger 独立 deny 账本仓储实现
 *
 * 规则依据：docs/PRD.md §8 数据规则 + docs/contracts/DATABASE.md §14.7
 *
 * 关键约束：本仓储使用独立 libsql client / 数据库文件，与业务库分离凭据与故障域。
 * 服务端先以确定性 eventId/idempotencyKey 追加账本并取得持久确认，再幂等提交业务状态。
 */
import { eq, sql } from "drizzle-orm";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import type { Client } from "@libsql/client";
import { recoveryControlLedger } from "../../schema/index.js";
import { initLedgerSchema } from "../../schema/init.js";
import type { IRecoveryLedgerPort, RecoveryLedgerEventModel } from "../types.js";

export class SqliteRecoveryLedgerRepository implements IRecoveryLedgerPort {
  private readonly db: LibSQLDatabase<{ recoveryControlLedger: typeof recoveryControlLedger }>;

  constructor(client: Client) {
    this.db = drizzle(client, { schema: { recoveryControlLedger } });
  }

  /** 初始化独立账本表结构（幂等）；调用方负责传入独立 ledger client */
  static async init(client: Client): Promise<void> {
    await initLedgerSchema(client);
  }

  async appendEvent(event: {
    eventId: string;
    idempotencyKey: string;
    eventType: string;
    workspaceRef?: string | null;
    subjectRef?: string | null;
    targetRef?: string | null;
    occurredAt?: string;
    tamperEvidence?: unknown;
  }): Promise<RecoveryLedgerEventModel> {
    const now = new Date().toISOString();
    const max = await this.getMaxSequence();
    const sequence = max + 1;
    const [created] = await this.db
      .insert(recoveryControlLedger)
      .values({
        eventId: event.eventId,
        idempotencyKey: event.idempotencyKey,
        eventType: event.eventType,
        workspaceRef: event.workspaceRef ?? null,
        subjectRef: event.subjectRef ?? null,
        targetRef: event.targetRef ?? null,
        occurredAt: event.occurredAt ?? now,
        sequence,
        tamperEvidence: event.tamperEvidence ?? null,
      })
      .returning();
    return created as RecoveryLedgerEventModel;
  }

  async getMaxSequence(): Promise<number> {
    const [row] = await this.db
      .select({ max: sql<number>`max(${recoveryControlLedger.sequence})` })
      .from(recoveryControlLedger);
    return row?.max ?? 0;
  }

  async getBySequence(sequence: number): Promise<RecoveryLedgerEventModel | null> {
    const [found] = await this.db
      .select()
      .from(recoveryControlLedger)
      .where(eq(recoveryControlLedger.sequence, sequence));
    return (found as RecoveryLedgerEventModel) ?? null;
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<RecoveryLedgerEventModel | null> {
    const [found] = await this.db
      .select()
      .from(recoveryControlLedger)
      .where(eq(recoveryControlLedger.idempotencyKey, idempotencyKey));
    return (found as RecoveryLedgerEventModel) ?? null;
  }
}
