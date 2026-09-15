import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { auditRecords, notifications } from "@aervox/schema";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteLearningRepository,
  SqlitePlatformRepository,
  type AervoxDatabase,
  type LocalContext,
} from "@aervox/repositories";
import type { Client } from "@libsql/client";
import { runReviewNotificationCycle } from "../src/review-notifier.js";

describe("Worker 复习到期提醒", () => {
  const tenant: LocalContext = { workspaceId: "local", subjectUserId: "local" };
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let learningRepo: SqliteLearningRepository;
  let platformRepo: SqlitePlatformRepository;

  beforeEach(async () => {
    const result = await createInMemoryDatabase();
    db = result.db;
    client = result.client;
    cleanup = result.cleanup;
    await initDatabaseSchema(client);
    learningRepo = new SqliteLearningRepository(db);
    platformRepo = new SqlitePlatformRepository(db);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
  });

  async function seedDueItems(): Promise<void> {
    await learningRepo.createKnowledgeItem(tenant, { id: "knowledge_a", concept: "导数" });
    await learningRepo.createKnowledgeItem(tenant, { id: "knowledge_b", concept: "极限" });
    await learningRepo.createReviewItem(tenant, {
      id: "review_a",
      knowledgeId: "knowledge_a",
      dueAt: "2020-01-01T00:00:00.000Z",
    });
    await learningRepo.createReviewItem(tenant, {
      id: "review_b",
      knowledgeId: "knowledge_b",
      dueAt: "2020-01-01T00:00:00.000Z",
    });
    await learningRepo.createKnowledgeRelation(tenant, {
      id: "relation_ab",
      fromKnowledgeId: "knowledge_a",
      toKnowledgeId: "knowledge_b",
      relationType: "prerequisite",
      confidence: 80,
    });
  }

  it("批量读取关系并在重复扫描时保持通知与审计幂等", async () => {
    await seedDueItems();
    const batchRelations = vi.spyOn(learningRepo, "listKnowledgeRelationsForKnowledgeIds");
    const singleRelations = vi.spyOn(learningRepo, "listKnowledgeRelations");
    const context = { db, platformRepo, learningRepo, workerId: "worker-review-test" };

    expect(await runReviewNotificationCycle(context)).toBe(2);
    expect(batchRelations).toHaveBeenCalledTimes(1);
    expect(singleRelations).not.toHaveBeenCalled();

    const firstNotifications = await db.select().from(notifications);
    const firstAudits = await db
      .select()
      .from(auditRecords)
      .where(eq(auditRecords.action, "review.due.notified"));
    expect(firstNotifications).toHaveLength(2);
    expect(firstAudits).toHaveLength(2);
    const auditForA = firstAudits.find((record) => record.subjectId === "review_a");
    expect(auditForA?.metadata).toMatchObject({
      knowledgeId: "knowledge_a",
      dueAt: "2020-01-01T00:00:00.000Z",
      relatedKnowledgeIds: ["knowledge_b"],
    });

    expect(await runReviewNotificationCycle(context)).toBe(2);
    expect(await db.select().from(notifications)).toHaveLength(2);
    expect(
      await db
        .select()
        .from(auditRecords)
        .where(eq(auditRecords.action, "review.due.notified")),
    ).toHaveLength(2);
    expect(batchRelations).toHaveBeenCalledTimes(2);
  });

  it("通知已写入但审计失败时，下一轮只补写缺失审计", async () => {
    await seedDueItems();
    const createAudit = platformRepo.createAuditRecordIdempotent.bind(platformRepo);
    let failOnce = true;
    vi.spyOn(platformRepo, "createAuditRecordIdempotent").mockImplementation(async (context, record) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("simulated audit failure");
      }
      return createAudit(context, record);
    });
    const workerContext = { db, platformRepo, learningRepo, workerId: "worker-review-test" };

    await expect(runReviewNotificationCycle(workerContext)).rejects.toThrow("simulated audit failure");
    expect(await db.select().from(notifications)).toHaveLength(1);
    expect(
      await db
        .select()
        .from(auditRecords)
        .where(eq(auditRecords.action, "review.due.notified")),
    ).toHaveLength(0);

    await expect(runReviewNotificationCycle(workerContext)).resolves.toBe(2);
    expect(await db.select().from(notifications)).toHaveLength(2);
    expect(
      await db
        .select()
        .from(auditRecords)
        .where(eq(auditRecords.action, "review.due.notified")),
    ).toHaveLength(2);
  });
});
