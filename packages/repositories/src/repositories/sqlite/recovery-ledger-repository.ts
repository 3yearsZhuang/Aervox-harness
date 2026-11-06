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

function assertSequence(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new DomainConflictError("recovery_ledger_sequence_invalid");
  }
}

/** Escape text before the native driver can truncate a control reference at NUL. */
const ledgerEventProjection = { value: sql<string>`json_object(
  'eventId', ${recoveryControlLedger.eventId}, 'idempotencyKey', ${recoveryControlLedger.idempotencyKey},
  'eventType', ${recoveryControlLedger.eventType}, 'workspaceRef', ${recoveryControlLedger.workspaceRef},
  'subjectRef', ${recoveryControlLedger.subjectRef}, 'targetRef', ${recoveryControlLedger.targetRef},
  'occurredAt', ${recoveryControlLedger.occurredAt}, 'sequence', ${recoveryControlLedger.sequence},
  'tamperEvidence', json(${recoveryControlLedger.tamperEvidence})
)`.mapWith((value: string): RecoveryLedgerEventModel => {
  const event = JSON.parse(value) as RecoveryLedgerEventModel;
  assertSequence(event.sequence);
  return event;
}) };

// Refuse an incomplete report rather than allocating in proportion to a
// damaged sequence value. These bound materialized rows and diagnostics, not
// the storage engine's scan time or the production recovery protocol.
const CONSISTENCY_ROW_LIMIT = 100_000;
const CONSISTENCY_DIAGNOSTIC_LIMIT = 10_000;

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
      HAVING count(*) = count(distinct ${recoveryControlLedger.sequence})
        and count(*) = coalesce(max(${recoveryControlLedger.sequence}), 0)
        and coalesce(max(${recoveryControlLedger.sequence}), 0) < 9007199254740991
        and coalesce(min(case when typeof(${recoveryControlLedger.sequence}) = 'integer'
          and ${recoveryControlLedger.sequence} between 1 and 9007199254740991
          then 1 else 0 end), 1) = 1
      ON CONFLICT (idempotency_key) DO NOTHING
    `);
    const created = await this.getByIdempotencyKey(event.idempotencyKey);
    if (!created) throw new DomainConflictError("recovery_ledger_append_untrusted_sequence");
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
    // One read statement supplies a single snapshot. Invalid/unsafe SQLite
    // values never cross the driver as integers that JavaScript could round.
    const rows = await this.db
      .select({ sequence: sql<string | null>`CASE
        WHEN typeof(${recoveryControlLedger.sequence}) = 'integer'
          AND ${recoveryControlLedger.sequence} BETWEEN 1 AND 9007199254740991
        THEN CAST(${recoveryControlLedger.sequence} AS TEXT) ELSE NULL END`
        .mapWith((value: string | null) => value === null ? null : Number(value)) })
      .from(recoveryControlLedger)
      .limit(CONSISTENCY_ROW_LIMIT + 1);
    const budgetExceeded = () => new DomainConflictError("recovery_ledger_consistency_budget_exceeded");
    if (rows.length > CONSISTENCY_ROW_LIMIT) throw budgetExceeded();
    const counts = new Map<number, number>();
    for (const row of rows) {
      if (!Number.isSafeInteger(row.sequence) || row.sequence === null || row.sequence < 1) {
        throw new DomainConflictError("recovery_ledger_sequence_invalid");
      }
      counts.set(row.sequence, (counts.get(row.sequence) ?? 0) + 1);
    }
    const sequences = [...counts.keys()].sort((a, b) => a - b);
    const maxSequence = sequences.at(-1) ?? 0;
    const duplicatedSequences: number[] = [];
    const missingSequences: number[] = [];
    let previous = 0;
    for (const sequence of sequences) {
      if (counts.get(sequence)! > 1) {
        if (duplicatedSequences.length === CONSISTENCY_DIAGNOSTIC_LIMIT) throw budgetExceeded();
        duplicatedSequences.push(sequence);
      }
      const gap = sequence - previous - 1;
      if (gap > CONSISTENCY_DIAGNOSTIC_LIMIT - missingSequences.length) throw budgetExceeded();
      for (let missing = previous + 1; missing < sequence; missing += 1) missingSequences.push(missing);
      previous = sequence;
    }
    return { eventCount: rows.length, maxSequence, duplicatedSequences, missingSequences };
  }

  async getMaxSequence(): Promise<number> {
    const [row] = await this.db
      // Validate every persisted value in the same snapshot as MAX. A higher
      // valid value cannot hide an invalid predecessor, and text casting keeps
      // an unsafe int64 from being rounded at the driver boundary.
      .select({ max: sql<string | null>`case when exists (
        select 1 from recovery_control_ledger invalid_ledger_sequence
        where typeof(invalid_ledger_sequence.sequence) != 'integer'
          or invalid_ledger_sequence.sequence < 1
          or invalid_ledger_sequence.sequence > 9007199254740991
        limit 1
      ) then null else cast(coalesce(max(${recoveryControlLedger.sequence}), 0) as text) end` })
      .from(recoveryControlLedger);
    if (!row || row.max === null) throw new DomainConflictError("recovery_ledger_sequence_invalid");
    const maximum = Number(row.max);
    if (maximum !== 0) assertSequence(maximum);
    return maximum;
  }

  async getBySequence(sequence: number): Promise<RecoveryLedgerEventModel | null> {
    assertSequence(sequence);
    const found = await this.db
      .select(ledgerEventProjection)
      .from(recoveryControlLedger)
      .where(eq(recoveryControlLedger.sequence, sequence))
      .limit(2);
    if (found.length > 1) throw new DomainConflictError("recovery_ledger_sequence_ambiguous");
    return found[0]?.value ?? null;
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<RecoveryLedgerEventModel | null> {
    const [found] = await this.db
      .select(ledgerEventProjection)
      .from(recoveryControlLedger)
      .where(eq(recoveryControlLedger.idempotencyKey, idempotencyKey));
    return found?.value ?? null;
  }
}
