/**
 * CR-033 E1 SituationModel 投影快照 Port（纯派生物，可从事件流重建）。
 *
 * 规则依据：CR-033（已归档至归档库）
 * - 投影快照 additive 落 vault，回填记录标记 `backfill`，禁止静默合并或 MAX(rowid) 选胜者；
 * - 读取按 active revision、source grant、local_only 与 deny watermark 过滤；
 * - 撤权、删除、导出与重建覆盖投影及索引。
 */
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { AervoxDatabase } from "../../client.js";
import type { ProactiveVaultCipher } from "../../proactive-vault-crypto.js";
import { proactiveSituationSnapshots } from "@aervox/schema";
import {
  assertSituationModelSize,
  situationModelV1Schema,
} from "@aervox/contracts";
import type { LocalContext } from "../../local-context.js";

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stringify(value: unknown, fallback = "{}"): string {
  try {
    return JSON.stringify(value ?? JSON.parse(fallback));
  } catch {
    return fallback;
  }
}

export interface SituationSnapshotInput {
  id: string;
  revisionId: string;
  schemaVersion: string;
  snapshot: unknown;
  checksum: string;
  /** backfill | incremental | rebuild */
  origin: "backfill" | "incremental" | "rebuild";
  lastEventSequence: number;
  sourceEpochs: Record<string, string>;
  rebuiltAt?: string | null;
  localOnly?: boolean;
}

export interface SituationSnapshot {
  id: string;
  revisionId: string;
  schemaVersion: string;
  snapshot: unknown;
  checksum: string;
  origin: "backfill" | "incremental" | "rebuild";
  lastEventSequence: number;
  sourceEpochs: Record<string, string>;
  rebuiltAt: string | null;
  localOnly: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * SituationModel 投影快照 Port。additive 落库，不改变既有运行时行为。
 * snapshotJson 经 vault 加密（纯派生摘要仍含敏感证据）。
 */
export class SqliteProactiveSituationRepository {
  constructor(
    private readonly db: AervoxDatabase,
    private readonly cipher?: ProactiveVaultCipher,
  ) {}

  private encrypt(value: string | null | undefined, type: string, id: string): string | null {
    if (value === null || value === undefined) return null;
    if (!this.cipher || this.cipher.isEncrypted(value)) return value;
    return this.cipher.encrypt(value, `${type}:${id}`);
  }

  private decrypt(value: string | null | undefined, type: string, id: string): string | null {
    if (value === null || value === undefined) return null;
    if (!this.cipher || !this.cipher.isEncrypted(value)) return value;
    return this.cipher.decrypt(value, `${type}:${id}`);
  }

  /** 写投影快照；同 (revisionId, lastEventSequence) 幂等（禁止 MAX(rowid) 选胜者）。 */
  async saveSnapshot(
    _tenant: LocalContext,
    input: SituationSnapshotInput,
  ): Promise<SituationSnapshot> {
    if (input.schemaVersion !== "situation_model_v1") {
      throw new Error(`unsupported situation schema version: ${input.schemaVersion}`);
    }
    const validatedSnapshot = situationModelV1Schema.parse(input.snapshot);
    assertSituationModelSize(validatedSnapshot);
    const now = new Date().toISOString();
    const [existing] = await this.db
      .select()
      .from(proactiveSituationSnapshots)
      .where(and(
        eq(proactiveSituationSnapshots.revisionId, input.revisionId),
        eq(proactiveSituationSnapshots.lastEventSequence, input.lastEventSequence),
      ))
      .limit(1);

    if (existing) {
      if (existing.checksum !== input.checksum) {
        throw new Error(
          `situation snapshot conflict for ${input.revisionId}@${input.lastEventSequence}`,
        );
      }
      return this.snapshotModel(existing);
    }

    const [created] = await this.db.insert(proactiveSituationSnapshots).values({
      id: input.id,
      revisionId: input.revisionId,
      schemaVersion: input.schemaVersion,
      snapshotJson: this.encrypt(stringify(validatedSnapshot), "situation", input.id) ?? "{}",
      checksum: input.checksum,
      origin: input.origin,
      lastEventSequence: input.lastEventSequence,
      sourceEpochsJson: stringify(input.sourceEpochs),
      rebuiltAt: input.rebuiltAt ?? null,
      localOnly: input.localOnly ?? true,
      createdAt: now,
      updatedAt: now,
    }).returning();
    return this.snapshotModel(created!);
  }

  /** 读取最新快照（按 active revision 与 deny watermark 过滤；local_only 之外拒绝）。 */
  async getLatestSnapshot(
    _tenant: LocalContext,
    revisionId: string,
    denyWatermark?: number,
  ): Promise<SituationSnapshot | null> {
    const [row] = await this.db
      .select()
      .from(proactiveSituationSnapshots)
      .where(and(
        eq(proactiveSituationSnapshots.revisionId, revisionId),
        eq(proactiveSituationSnapshots.localOnly, true),
        denyWatermark !== undefined
          ? gte(proactiveSituationSnapshots.lastEventSequence, denyWatermark)
          : undefined,
      ))
      .orderBy(desc(proactiveSituationSnapshots.lastEventSequence))
      .limit(1);
    return row ? this.snapshotModel(row) : null;
  }

  /** 写重建 watermark（rebuild 标记）：将最新快照的 watermark 提升到目标值。 */
  async markRebuild(
    _tenant: LocalContext,
    revisionId: string,
    lastEventSequence: number,
  ): Promise<void> {
    const [latest] = await this.db
      .select()
      .from(proactiveSituationSnapshots)
      .where(and(
        eq(proactiveSituationSnapshots.revisionId, revisionId),
        eq(proactiveSituationSnapshots.localOnly, true),
      ))
      .orderBy(desc(proactiveSituationSnapshots.lastEventSequence))
      .limit(1);
    if (!latest) return;

    const currentSnapshot = situationModelV1Schema.parse(
      parseJson(this.decrypt(latest.snapshotJson, "situation", latest.id), {}),
    );
    const now = new Date().toISOString();
    const nextSequence = Math.max(latest.lastEventSequence, lastEventSequence);
    const rebuiltSnapshot = situationModelV1Schema.parse({
      ...currentSnapshot,
      watermark: {
        ...currentSnapshot.watermark,
        lastEventSequence: nextSequence,
        rebuiltAt: now,
      },
      rebuiltAt: now,
    });
    const serialized = stringify(rebuiltSnapshot);
    const checksum = createHash("sha256").update(serialized).digest("hex");
    await this.db
      .update(proactiveSituationSnapshots)
      .set({
        snapshotJson: this.encrypt(serialized, "situation", latest.id) ?? "{}",
        checksum,
        lastEventSequence: nextSequence,
        origin: "rebuild",
        rebuiltAt: now,
        updatedAt: now,
      })
      .where(eq(proactiveSituationSnapshots.id, latest.id));
  }

  /** 撤权/删除传播：按 revision 删全部投影快照（投影随删除零召回）。 */
  async deleteByRevision(_tenant: LocalContext, revisionId: string): Promise<number> {
    const deleted = await this.db
      .delete(proactiveSituationSnapshots)
      .where(eq(proactiveSituationSnapshots.revisionId, revisionId))
      .returning({ id: proactiveSituationSnapshots.id });
    return deleted.length;
  }

  /** 删除低于某 watermark 的过期投影（重建覆盖）。 */
  async deleteBeforeWatermark(
    _tenant: LocalContext,
    revisionId: string,
    lastEventSequence: number,
  ): Promise<number> {
    const deleted = await this.db
      .delete(proactiveSituationSnapshots)
      .where(and(
        eq(proactiveSituationSnapshots.revisionId, revisionId),
        lt(proactiveSituationSnapshots.lastEventSequence, lastEventSequence),
      ))
      .returning({ id: proactiveSituationSnapshots.id });
    return deleted.length;
  }

  private snapshotModel(row: typeof proactiveSituationSnapshots.$inferSelect): SituationSnapshot {
    return {
      id: row.id,
      revisionId: row.revisionId,
      schemaVersion: row.schemaVersion,
      snapshot: parseJson(this.decrypt(row.snapshotJson, "situation", row.id), {}),
      checksum: row.checksum,
      origin: row.origin as SituationSnapshot["origin"],
      lastEventSequence: row.lastEventSequence,
      sourceEpochs: parseJson<Record<string, string>>(row.sourceEpochsJson, {}),
      rebuiltAt: row.rebuiltAt,
      localOnly: row.localOnly,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
