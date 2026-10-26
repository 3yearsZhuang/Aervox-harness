/**
 * Aervox｜思隅 @aervox/repositories — RecoveryControlLedger 独立 deny 账本仓储实现
 *
 * 规则依据：docs/reference/PRD.md §8 数据规则 + docs/reference/DATABASE.md §14.7
 *
 * 调用方须提供独立 ledger client，并满足凭据、备份和故障域隔离；
 * 本类不建立或验证这些部署条件，也不替代账本先行的业务接线与水位对账。
 */
import { eq, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import type { Client } from "@libsql/client";
import { recoveryControlLedger } from "@aervox/schema";
import { initLedgerSchema } from "../../schema/ddl/index.js";
import type { IRecoveryLedgerPort, RecoveryLedgerEventModel } from "../types/index.js";
import { DomainConflictError } from "../../errors.js";

/** Escape text before the native driver can truncate a control reference at NUL. */
const ledgerEventProjection = { value: sql<string>`json_object(
  'eventId', ${recoveryControlLedger.eventId}, 'idempotencyKey', ${recoveryControlLedger.idempotencyKey},
  'eventType', ${recoveryControlLedger.eventType}, 'workspaceRef', ${recoveryControlLedger.workspaceRef},
  'subjectRef', ${recoveryControlLedger.subjectRef}, 'targetRef', ${recoveryControlLedger.targetRef},
  'occurredAt', ${recoveryControlLedger.occurredAt}, 'sequence', ${recoveryControlLedger.sequence},
  'tamperEvidence', json(${recoveryControlLedger.tamperEvidence})
)`.mapWith((value: string): RecoveryLedgerEventModel => JSON.parse(value)) };

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
    // Bind the receipt to the persisted control intent, not just its public ids.
    // Normalize as stored JSON so key order and JSON serialization do not create
    // false conflicts; omitted server-generated time keeps its original value.
    const proof = event.tamperEvidence === undefined ? null : JSON.parse(JSON.stringify(event.tamperEvidence));
    const assertIntent = (existing: RecoveryLedgerEventModel): RecoveryLedgerEventModel => {
      if (existing.eventId !== event.eventId || existing.eventType !== event.eventType
        || (existing.workspaceRef ?? null) !== (event.workspaceRef ?? null)
        || (existing.subjectRef ?? null) !== (event.subjectRef ?? null)
        || (existing.targetRef ?? null) !== (event.targetRef ?? null)
        || (event.occurredAt !== undefined && existing.occurredAt !== event.occurredAt)
        || !isDeepStrictEqual(existing.tamperEvidence ?? null, proof)) {
        throw new DomainConflictError("recovery_ledger_conflict");
      }
      return existing;
    };
    const existing = await this.getByIdempotencyKey(event.idempotencyKey);
    if (existing) return assertIntent(existing);
    const now = new Date().toISOString();
    // 序列在单条 INSERT ... SELECT 内原子分配（MAX+1 与写入同一语句，避免并发重复序列）
    await this.db.run(sql`
      INSERT INTO recovery_control_ledger
        (event_id, idempotency_key, event_type, workspace_ref, subject_ref, target_ref, occurred_at, sequence, tamper_evidence)
      SELECT
        ${event.eventId}, ${event.idempotencyKey}, ${event.eventType},
        ${event.workspaceRef ?? null}, ${event.subjectRef ?? null}, ${event.targetRef ?? null},
        ${event.occurredAt ?? now}, COALESCE(MAX(${recoveryControlLedger.sequence}), 0) + 1,
        ${proof === null ? null : JSON.stringify(proof)}
      FROM ${recoveryControlLedger}
      WHERE true
      ON CONFLICT (idempotency_key) DO NOTHING
    `);
    const created = await this.getByIdempotencyKey(event.idempotencyKey);
    if (!created) throw new Error("recovery_ledger_append_failed");
    // Another caller can win after our first read. It is an idempotent receipt
    // only if its complete intent still matches this command.
    return assertIntent(created);
  }

  /**
   * 只读一致性检查（不修改任何数据）：报告重复序列、序列缺口与总量，
   * 供对账/演练按契约 fail-closed 判断（缺口或重复即认为账本不可信）。
   */
  async inspectConsistency(): Promise<{
    eventCount: number;
    maxSequence: number;
    duplicatedSequences: number[];
    missingSequences: number[];
  }> {
    const rows = await this.db
      .select({ sequence: recoveryControlLedger.sequence })
      .from(recoveryControlLedger);
    const counts = new Map<number, number>();
    for (const row of rows) counts.set(row.sequence, (counts.get(row.sequence) ?? 0) + 1);
    const duplicatedSequences = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([sequence]) => sequence)
      .sort((a, b) => a - b);
    const maxSequence = counts.size > 0 ? Math.max(...counts.keys()) : 0;
    const missingSequences: number[] = [];
    for (let sequence = 1; sequence <= maxSequence; sequence += 1) {
      if (!counts.has(sequence)) missingSequences.push(sequence);
    }
    return { eventCount: rows.length, maxSequence, duplicatedSequences, missingSequences };
  }

  async getMaxSequence(): Promise<number> {
    const [row] = await this.db
      .select({ max: sql<number>`max(${recoveryControlLedger.sequence})` })
      .from(recoveryControlLedger);
    return row?.max ?? 0;
  }

  async getBySequence(sequence: number): Promise<RecoveryLedgerEventModel | null> {
    const [found] = await this.db
      .select(ledgerEventProjection)
      .from(recoveryControlLedger)
      .where(eq(recoveryControlLedger.sequence, sequence));
    return found?.value ?? null;
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<RecoveryLedgerEventModel | null> {
    const [found] = await this.db
      .select(ledgerEventProjection)
      .from(recoveryControlLedger)
      .where(eq(recoveryControlLedger.idempotencyKey, idempotencyKey));
    return found?.value ?? null;
  }
}
