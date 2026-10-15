import { and, asc, desc, eq, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { botConnections, botDeliveries, botInbox, botSessionBindings } from "@aervox/schema";
import type { AervoxDatabase } from "../../client.js";

export type BotConnectionRecord = typeof botConnections.$inferSelect;
export type BotInboxRecord = typeof botInbox.$inferSelect;
export type BotDeliveryRecord = typeof botDeliveries.$inferSelect;
export interface BotLeaseFence { connectionId: string; revision: number; owner: string }

const fenceCondition = (fence?: BotLeaseFence): SQL => fence ? sql`EXISTS (
  SELECT 1 FROM bot_connections WHERE id = ${fence.connectionId} AND revision = ${fence.revision}
    AND enabled = 1 AND lease_owner = ${fence.owner} AND lease_until > ${new Date().toISOString()}
)` : sql`1`;

/** Storage owns atomic CAS; no network calls are made while a writer transaction is open. */
export class SqliteBotRepository {
  constructor(private readonly db: AervoxDatabase) {}
  listConnections() { return this.db.select().from(botConnections).orderBy(asc(botConnections.createdAt)); }
  async getConnection(id: string) {
    return (await this.db.select().from(botConnections).where(eq(botConnections.id, id)).limit(1))[0] ?? null;
  }
  async createConnection(input: typeof botConnections.$inferInsert) {
    return (await this.db.insert(botConnections).values(input).returning())[0]!;
  }
  async updateConnection(id: string, revision: number, patch: Partial<typeof botConnections.$inferInsert>) {
    return (await this.db.update(botConnections).set({ ...patch, revision: revision + 1 })
      .where(and(eq(botConnections.id, id), eq(botConnections.revision, revision))).returning())[0] ?? null;
  }
  async deleteConnection(id: string) {
    // Cancel accepted work before the cascading delete removes its durable routing link.
    const turnIds = sql`SELECT id FROM turns WHERE idempotency_key IN (
      SELECT 'bot:' || id FROM bot_inbox WHERE connection_id = ${id} AND state IN ('queued', 'processing', 'responding'))`;
    await this.db.transaction(async tx => {
      await tx.run(sql`UPDATE turn_attempts SET status = CASE WHEN lease_id IS NULL THEN 'Cancelled' ELSE 'CancelRequested' END,
        finished_at = CASE WHEN lease_id IS NULL THEN ${new Date().toISOString()} ELSE finished_at END
        WHERE status = 'Running' AND turn_id IN (${turnIds})`);
      await tx.run(sql`UPDATE turns SET status = 'Cancelled', updated_at = ${new Date().toISOString()} WHERE id IN (${turnIds})
        AND status NOT IN ('Completed', 'Failed', 'Interrupted', 'Cancelled')`);
      await tx.delete(botConnections).where(eq(botConnections.id, id));
    });
  }
  async revokeConnection(id: string, clearSecrets = false) {
    return (await this.db.update(botConnections).set({ enabled: false, revision: sql`${botConnections.revision} + 1`,
      pairingHash: null, pairingCandidate: null, pairingExpiresAt: null,
      ...(clearSecrets ? { secretCipher: null, checkpointCipher: null, ownerSenderId: null } : {}),
    }).where(eq(botConnections.id, id)).returning())[0] ?? null;
  }
  async acquireLease(id: string, owner: string, now: string, until: string, revision?: number) {
    const rows = await this.db.update(botConnections).set({ leaseOwner: owner, leaseUntil: until })
      .where(and(eq(botConnections.id, id), eq(botConnections.enabled, true), revision === undefined ? undefined : eq(botConnections.revision, revision),
        or(isNull(botConnections.leaseOwner), lte(botConnections.leaseUntil, now), eq(botConnections.leaseOwner, owner)))).returning();
    return rows[0] ?? null;
  }
  async releaseLease(id: string, owner: string, state: string = "stopped") {
    await this.db.update(botConnections).set({ leaseOwner: null, leaseUntil: null, state })
      .where(and(eq(botConnections.id, id), eq(botConnections.leaseOwner, owner)));
  }
  async writeRuntime(id: string, revision: number, owner: string, patch: Partial<typeof botConnections.$inferInsert>) {
    const rows = await this.db.update(botConnections).set(patch).where(and(
      eq(botConnections.id, id), eq(botConnections.enabled, true), eq(botConnections.revision, revision), eq(botConnections.leaseOwner, owner),
      sql`${botConnections.leaseUntil} > ${new Date().toISOString()}`,
    )).returning();
    return rows[0] ?? null;
  }
  async recordPairingCandidate(id: string, revision: number, owner: string, pairingHash: string, senderId: string) {
    return (await this.db.update(botConnections).set({ pairingCandidate: senderId }).where(and(
      eq(botConnections.id, id), eq(botConnections.pairingHash, pairingHash), isNull(botConnections.pairingCandidate),
      sql`${botConnections.pairingExpiresAt} > ${new Date().toISOString()}`,
      fenceCondition({ connectionId: id, revision, owner }),
    )).returning())[0] ?? null;
  }
  async confirmPairing(fence: BotLeaseFence, accountId: string, pairingHash: string, senderId: string) {
    return (await this.db.update(botConnections).set({ revision: fence.revision + 1, ownerSenderId: senderId,
      pairingHash: null, pairingCandidate: null, pairingExpiresAt: null }).where(and(
      eq(botConnections.id, fence.connectionId), eq(botConnections.accountId, accountId), eq(botConnections.pairingHash, pairingHash),
      eq(botConnections.pairingCandidate, senderId), sql`${botConnections.pairingExpiresAt} > ${new Date().toISOString()}`,
      fenceCondition(fence),
    )).returning())[0] ?? null;
  }
  async bindSession(connectionId: string, routeKey: string, sessionId: string) {
    await this.db.insert(botSessionBindings).values({ id: sessionId, connectionId, routeKey, sessionId }).onConflictDoNothing();
  }
  async enqueue(input: typeof botInbox.$inferInsert, fence?: BotLeaseFence, control = false) {
    // Admission and queue limits share one SQLite writer statement. A duplicate remains a
    // durable tombstone even when the queue is full or its original session was deleted.
    const inserted = await this.db.all<{ id: string }>(sql`INSERT INTO bot_inbox
      (id, connection_id, session_id, message_json, connection_revision, state, turn_id, created_at, last_error)
      SELECT ${input.id}, ${input.connectionId}, ${input.sessionId}, ${input.messageJson}, ${input.connectionRevision},
        ${input.state ?? "queued"}, ${input.turnId ?? null}, ${input.createdAt}, ${input.lastError ?? null}
      WHERE ${fenceCondition(fence)}
        AND (( ${control ? 1 : 0} = 1
          AND (SELECT count(*) FROM bot_inbox WHERE connection_id = ${input.connectionId}
            AND state IN ('queued', 'processing', 'responding') AND json_extract(message_json, '$.text') = '/cancel') < 100
          AND (SELECT count(*) FROM bot_inbox WHERE session_id = ${input.sessionId}
            AND state IN ('queued', 'processing', 'responding') AND json_extract(message_json, '$.text') = '/cancel') < 1
        ) OR ( ${control ? 1 : 0} = 0
          AND (SELECT count(*) FROM bot_inbox WHERE connection_id = ${input.connectionId}
            AND state IN ('queued', 'processing', 'responding') AND coalesce(json_extract(message_json, '$.text'), '') != '/cancel') < 100
          AND (SELECT count(*) FROM bot_inbox WHERE session_id = ${input.sessionId}
            AND state IN ('queued', 'processing', 'responding') AND coalesce(json_extract(message_json, '$.text'), '') != '/cancel') < 20
        ))
      ON CONFLICT DO NOTHING RETURNING id`);
    if (inserted.length) return this.getInbox(input.id);
    if (await this.getInbox(input.id)) return null;
    if (fence && !(await this.db.all(sql`SELECT 1 WHERE ${fenceCondition(fence)}`)).length) return null;
    throw new Error("bot_inbox_full");
  }
  async getInbox(id: string) { return (await this.db.select().from(botInbox).where(eq(botInbox.id, id)).limit(1))[0] ?? null; }
  listPending(connectionId: string) {
    return this.db.select().from(botInbox).where(and(eq(botInbox.connectionId, connectionId), inArray(botInbox.state, ["queued", "processing", "responding"])))
      .orderBy(sql`bot_inbox.rowid ASC`).limit(100);
  }
  listPendingControls(connectionId: string) {
    return this.db.select().from(botInbox).where(and(eq(botInbox.connectionId, connectionId),
      inArray(botInbox.state, ["queued", "processing"]), sql`json_extract(${botInbox.messageJson}, '$.text') = '/cancel'`))
      .orderBy(sql`bot_inbox.rowid ASC`).limit(100);
  }
  async cancelBefore(controlId: string, fence: BotLeaseFence) {
    // The durable command's insertion position is the boundary, not a later wall clock or
    // a snapshot taken after restart. Turn cancellation and inbox tombstones commit together.
    const previous = sql`SELECT p.id FROM bot_inbox p JOIN bot_inbox c ON c.id = ${controlId}
      WHERE p.connection_id = c.connection_id AND p.session_id = c.session_id AND p.rowid < c.rowid
        AND c.connection_id = ${fence.connectionId} AND c.connection_revision = ${fence.revision}
        AND c.state IN ('queued', 'processing') AND json_extract(c.message_json, '$.text') = '/cancel'
        AND p.state IN ('queued', 'processing', 'responding') AND coalesce(json_extract(p.message_json, '$.text'), '') != '/cancel'
        AND ${fenceCondition(fence)}`;
    const turnIds = sql`SELECT id FROM turns WHERE idempotency_key IN (SELECT 'bot:' || id FROM bot_inbox WHERE id IN (${previous}))`;
    await this.db.transaction(async tx => {
      await tx.run(sql`UPDATE turn_attempts SET status = CASE WHEN lease_id IS NULL THEN 'Cancelled' ELSE 'CancelRequested' END,
        finished_at = CASE WHEN lease_id IS NULL THEN ${new Date().toISOString()} ELSE finished_at END
        WHERE status = 'Running' AND turn_id IN (${turnIds})`);
      await tx.run(sql`UPDATE turns SET status = 'Cancelled', updated_at = ${new Date().toISOString()} WHERE id IN (${turnIds})
        AND status NOT IN ('Completed', 'Failed', 'Interrupted', 'Cancelled')`);
      await tx.run(sql`UPDATE bot_deliveries SET status = CASE WHEN status = 'sending' THEN 'unknown' ELSE 'failed' END,
        last_error = 'bot_cancelled' WHERE inbox_id IN (${previous}) AND status IN ('queued', 'sending')`);
      await tx.run(sql`UPDATE bot_inbox SET state = 'cancelled' WHERE id IN (${previous})`);
      await tx.run(sql`UPDATE bot_inbox SET state = 'responding' WHERE id = ${controlId}
        AND connection_id = ${fence.connectionId} AND connection_revision = ${fence.revision}
        AND state IN ('queued', 'processing') AND json_extract(message_json, '$.text') = '/cancel'
        AND ${fenceCondition(fence)}`);
    });
  }
  async updateInbox(id: string, patch: Partial<typeof botInbox.$inferInsert>, fence?: BotLeaseFence) {
    return (await this.db.update(botInbox).set(patch).where(and(eq(botInbox.id, id), sql`${botInbox.state} NOT IN ('deleted', 'cancelled', 'superseded')`,
      fence ? eq(botInbox.connectionId, fence.connectionId) : undefined, fenceCondition(fence))).returning())[0] ?? null;
  }
  async addDeliveries(rows: (typeof botDeliveries.$inferInsert)[], fence?: BotLeaseFence) {
    for (const row of rows) await this.db.run(sql`INSERT INTO bot_deliveries
      (id, connection_id, inbox_id, part_index, text, status, platform_message_id, last_error, created_at)
      SELECT ${row.id}, ${row.connectionId}, ${row.inboxId}, ${row.partIndex}, ${row.text},
        ${row.status ?? "queued"}, ${row.platformMessageId ?? null}, ${row.lastError ?? null}, ${row.createdAt}
      WHERE EXISTS (SELECT 1 FROM bot_inbox WHERE id = ${row.inboxId} AND connection_id = ${row.connectionId} AND state NOT IN ('deleted', 'cancelled', 'superseded'))
        AND ${fenceCondition(fence)} ON CONFLICT DO NOTHING`);
  }
  listDeliveries(connectionId: string) {
    return this.db.select().from(botDeliveries).where(eq(botDeliveries.connectionId, connectionId))
      .orderBy(desc(botDeliveries.createdAt), sql`bot_deliveries.rowid DESC`).limit(200);
  }
  async getDelivery(connectionId: string, deliveryId: string) {
    return (await this.db.select().from(botDeliveries).where(and(
      eq(botDeliveries.connectionId, connectionId), eq(botDeliveries.id, deliveryId),
    )).limit(1))[0] ?? null;
  }
  deliveryParts(inboxId: string) { return this.db.select().from(botDeliveries).where(eq(botDeliveries.inboxId, inboxId)).orderBy(asc(botDeliveries.partIndex)); }
  async updateDelivery(id: string, patch: Partial<typeof botDeliveries.$inferInsert>, expectedStatus?: string, fence?: BotLeaseFence) {
    return (await this.db.update(botDeliveries).set(patch).where(and(eq(botDeliveries.id, id), expectedStatus ? eq(botDeliveries.status, expectedStatus) : undefined,
      sql`EXISTS (SELECT 1 FROM bot_inbox WHERE id = ${botDeliveries.inboxId} AND state NOT IN ('deleted', 'cancelled', 'superseded'))`,
      fence ? eq(botDeliveries.connectionId, fence.connectionId) : undefined, fenceCondition(fence))).returning())[0] ?? null;
  }
  async markInterruptedSends(connectionId: string, owner?: string | null) {
    await this.db.update(botDeliveries).set({ status: "unknown", lastError: "connection_recovered_without_receipt" })
      .where(and(eq(botDeliveries.connectionId, connectionId), eq(botDeliveries.status, "sending"),
        owner === null ? sql`EXISTS (SELECT 1 FROM bot_connections WHERE id = ${connectionId} AND lease_owner IS NULL)`
          : owner ? sql`EXISTS (SELECT 1 FROM bot_connections WHERE id = ${connectionId} AND lease_owner = ${owner})` : undefined));
  }
}
