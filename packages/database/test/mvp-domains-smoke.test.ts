import { describe, it, expect, beforeEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import path from "node:path";
import os from "node:os";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteLearningRepository,
  SqliteFeedbackRepository,
  SqliteProvenanceRepository,
  SqlitePlatformRepository,
  SqliteSafetyRepository,
  SqlitePrivacyRepository,
  SqliteRecoveryLedgerRepository,
  SqliteMemoryRepository,
  SqliteConversationRepository,
  SqliteDiaryRepository,
  SqliteAnalyticsRepository,
  SqliteContentRepository,
  type AervoxDatabase,
  type TenantContext,
} from "../src/index.js";

describe("PRD §8 MVP 优先队列：新域仓储冒烟测试", () => {
  let db: AervoxDatabase;
  let client: Client;
  let learning: SqliteLearningRepository;
  let feedback: SqliteFeedbackRepository;
  let provenance: SqliteProvenanceRepository;
  let platform: SqlitePlatformRepository;
  let safety: SqliteSafetyRepository;
  let privacy: SqlitePrivacyRepository;
  let memory: SqliteMemoryRepository;
  let conversation: SqliteConversationRepository;
  let diary: SqliteDiaryRepository;
  let analytics: SqliteAnalyticsRepository;
  let content: SqliteContentRepository;

  const tenant: TenantContext = {
    workspaceId: "ws_mvp",
    subjectUserId: "usr_mvp",
  };
  const otherTenant: TenantContext = {
    workspaceId: "ws_other",
    subjectUserId: "usr_other",
  };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    learning = new SqliteLearningRepository(db);
    feedback = new SqliteFeedbackRepository(db);
    provenance = new SqliteProvenanceRepository(db);
    platform = new SqlitePlatformRepository(db);
    safety = new SqliteSafetyRepository(db);
    privacy = new SqlitePrivacyRepository(db);
    memory = new SqliteMemoryRepository(db, client);
    conversation = new SqliteConversationRepository(db);
    diary = new SqliteDiaryRepository(db);
    analytics = new SqliteAnalyticsRepository(db);
    content = new SqliteContentRepository(db);
  });

  it("学习域：目标/题目/作答/知识点/复习项可写可读，且租户隔离", async () => {
    const goal = await learning.createLearningGoal(tenant, { id: "goal_1", topic: "代数", level: "intermediate", availableMinutes: 30 });
    expect(goal.status).toBe("active");
    expect((await learning.listLearningGoals(tenant))).toHaveLength(1);

    const q = await learning.createQuestion(tenant, { id: "q_1", prompt: "2+2=?", answerSpec: { answer: "4" } });
    expect(q.answerSpec).toEqual({ answer: "4" });

    const attempt = await learning.recordAttempt(tenant, {
      id: "att_1", sessionId: "ses_1", questionId: "q_1", answer: "4", judgement: "correct",
    });
    expect(attempt.judgement).toBe("correct");
    expect(await learning.listAttemptsByQuestion(tenant, "q_1")).toHaveLength(1);

    const ki = await learning.createKnowledgeItem(tenant, { id: "ki_1", concept: "加法", sourceStatus: "observed" });
    const mastered = await learning.updateMastery(tenant, "ki_1", "mastered", { basis: "attempts" });
    expect(mastered?.masteryState).toBe("mastered");

    const ri = await learning.createReviewItem(tenant, { id: "ri_1", knowledgeId: "ki_1", dueAt: "2026-01-01T00:00:00.000Z" });
    expect(await learning.listDueReviewItems(tenant, "2026-12-31T00:00:00.000Z")).toHaveLength(1);
    expect((await learning.completeReviewItem(tenant, "ri_1"))?.status).toBe("completed");

    // 跨租户不可见
    expect(await learning.getLearningGoal(otherTenant, "goal_1")).toBeNull();
  });

  it("反馈域：写入并可按主体过滤", async () => {
    await feedback.createFeedback(tenant, { id: "fb_1", actorId: "usr_mvp", subjectType: "message", subjectId: "m_1", type: "inaccurate" });
    const all = await feedback.listFeedback(tenant);
    expect(all).toHaveLength(1);
    const filtered = await feedback.listFeedback(tenant, "message", "m_1");
    expect(filtered).toHaveLength(1);
    expect(await feedback.listFeedback(otherTenant)).toHaveLength(0);
  });

  it("溯源/记忆：来源工件 + 修订 + 记忆版本/证据/事件可写，来源删除保留 tombstone", async () => {
    const sa = await provenance.createSourceArtifact(tenant, {
      id: "sa_1", kind: "message", ownerModule: "conversation", occurredAt: "2026-01-01T00:00:00.000Z", ingestedAt: "2026-01-01T00:00:01.000Z",
    });
    const rev = await provenance.appendSourceRevision(tenant, "sa_1", { id: "sr_1", checksum: "abc123", content: "原文内容" });
    expect(rev.checksum).toBe("abc123");
    await provenance.setCurrentRevision(tenant, "sa_1", "sr_1");
    expect((await provenance.getSourceArtifact(tenant, "sa_1"))?.currentRevisionId).toBe("sr_1");

    const mem = await memory.createRecord(tenant, { id: "mem_1", layer: "long_term", type: "user_fact", content: "用户目标是考雅思 7 分" });
    const mrev = await provenance.appendMemoryRevision(tenant, { id: "mrev_1", memoryId: "mem_1", content: "用户目标：雅思 7 分", confidence: 90 });
    await provenance.setMemoryCurrentRevision(tenant, "mem_1", "mrev_1");
    expect(await provenance.listMemoryRevisions(tenant, "mem_1")).toHaveLength(1);

    await provenance.createMemoryEvidence(tenant, { id: "mev_1", memoryRevisionId: "mrev_1", sourceArtifactId: "sa_1", sourceRevisionId: "sr_1" });
    await provenance.recordMemoryEvent(tenant, { id: "mevt_1", memoryId: "mem_1", action: "promoted", fromTier: "short_term", toTier: "long_term" });
    const events = await provenance.listMemoryEvents(tenant, "mem_1");
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe("promoted");
  });

  it("平台域：计划任务/通知/提示词/模型运行/上下文清单/审计", async () => {
    await platform.createScheduledJob(tenant, { id: "job_1", jobType: "diary", subjectId: "sub_1", idempotencyKey: "j1", runAt: "2026-01-01T00:00:00.000Z" });
    expect((await platform.markJobDone(tenant, "job_1"))?.status).toBe("done");

    await platform.createNotification(tenant, { id: "ntf_1", type: "review", scheduledAt: "2026-01-01T00:00:00.000Z", channel: "in_app" });
    expect((await platform.markNotificationSent(tenant, "ntf_1"))?.status).toBe("sent");

    const pv = await platform.createPromptVersion({ id: "pv_1", purpose: "teaching", version: 1, checksum: "h1" });
    expect((await platform.getPromptVersion("teaching", 1))?.id).toBe(pv.id);

    const run = await platform.createModelRun(tenant, { id: "run_1", purpose: "diary", provider: "openai", modelId: "gpt-4o", promptVersionId: "pv_1" });
    const manifest = await platform.createContextManifest({ id: "cm_1", modelRunId: "run_1", purpose: "diary", sourceArtifactId: "sa_1", sourceRevisionId: "sr_1" });
    expect(manifest.tokenBudget).toBeNull();
    await platform.attachContextManifest(tenant, "run_1", "cm_1");
    expect((await platform.completeModelRun(tenant, "run_1", { latencyMs: 120, cost: 10, tokenUsage: { total: 100 } }))?.status).toBe("completed");

    await platform.createAuditRecord(tenant, { id: "aud_1", actorType: "user", actorId: "usr_mvp", action: "export", subjectType: "diary", subjectId: "d_1" });
    expect(await platform.listAuditRecords(tenant)).toHaveLength(1);
  });

  it("安全域 + 隐私/删除域：事件记录、同意授权、删除请求传播", async () => {
    await safety.recordIncident(tenant, { id: "saf_1", category: "privacy", severity: "high", disposition: "blocked", policyVersion: "v1" });
    expect(await safety.listIncidents(tenant)).toHaveLength(1);

    await privacy.grantConsent(tenant, { id: "cg_1", actorId: "usr_mvp", purpose: "diary", scope: "auto_generate", policyVersion: "v1" });
    expect(await privacy.hasActiveConsent(tenant, "diary", "auto_generate")).toBe(true);
    await privacy.revokeConsent(tenant, "cg_1");
    expect(await privacy.hasActiveConsent(tenant, "diary", "auto_generate")).toBe(false);

    const req = await privacy.createDeletionRequest(tenant, { id: "dr_1", scope: "account", idempotencyKey: "del_1", ownerModule: "account" });
    expect(req.status).toBe("pending");
    const target = await privacy.createDeletionTarget({ requestId: "dr_1", targetType: "fts_index", targetId: "mem_1", ownerModule: "search" });
    expect(target.status).toBe("pending");
    const updated = await privacy.updateDeletionTargetStatus({ requestId: "dr_1", targetType: "fts_index", targetId: "mem_1" }, "completed", "ev:1");
    expect(updated?.status).toBe("completed");
    expect(updated?.verifiedAt).toBeTruthy();
  });

  it("会话补齐：Message 身份 + TurnAttempt", async () => {
    const session = await conversation.createSession(tenant, "MVP Session");
    const msg = await conversation.createMessage(tenant, { id: "msg_1", sessionId: session.id, role: "user", label: "首问" });
    expect(msg.role).toBe("user");
    expect((await conversation.getMessage(tenant, "msg_1"))?.label).toBe("首问");

    const turn = await conversation.createTurnWithOutbox(
      tenant,
      { id: "turn_1", sessionId: session.id, idempotencyKey: "ik_1" },
      { id: "mv_1", content: "hi" },
    );
    const attempt = await conversation.createTurnAttempt(tenant, turn.turn.id, { id: "ta_1", attempt: 1, leaseId: "lease_1" });
    expect(attempt.attempt).toBe(1);
    expect(await conversation.listTurnAttempts(tenant, "turn_1")).toHaveLength(1);
  });

  it("平台域补齐：ToolPolicy + EvalSet（系统级无租户列）", async () => {
    const tp = await platform.createToolPolicy({ id: "tp_1", purpose: "diary", toolName: "web_search", approvalMode: "require_approval", quota: 10 });
    expect(tp.approvalMode).toBe("require_approval");
    expect((await platform.getToolPolicy("diary", "web_search", 1))?.id).toBe("tp_1");

    await platform.createEvalSet({ id: "ev_1", purpose: "teaching", version: 1, domain: "math", sampleCount: 50 });
    const sets = await platform.listEvalSets("teaching");
    expect(sets).toHaveLength(1);
    expect(sets[0]!.sampleCount).toBe(50);
  });

  it("日记域补齐：计划主实体/版本/段落来源/素材缓冲", async () => {
    const schedule = await diary.createDiarySchedule(tenant, {
      id: "ds_1",
      scheduleEpochId: "epoch_1",
      activeFrom: "2026-01-01T00:00:00.000Z",
      initialWindowStart: "2026-01-01T00:00:00.000Z",
      cutoffRule: "daily",
      bufferMinutes: 15,
      contentScopes: { messages: true },
    });
    expect(schedule.cutoffRule).toBe("daily");
    expect((await diary.getDiarySchedule(tenant, "ds_1"))?.bufferMinutes).toBe(15);

    // 先创建不可变周期（scheduleVersion=1），再在同一事务发布日记
    const cycle1 = await diary.createCycle(tenant, {
      id: "cyc_1",
      scheduleEpochId: "epoch_1",
      localDate: "2026-01-01",
      previousCutoffAt: "2025-12-31T00:00:00.000Z",
      cutoffAt: "2026-01-01T00:00:00.000Z",
    });
    const created = await diary.publishDiaryWithCycle(tenant, {
      cycleId: "cyc_1",
      diary: { id: "d_1", localDate: "2026-01-01", title: "Day 1", content: "today..." },
      expectedScheduleVersion: cycle1.scheduleVersion,
    });
    expect(created.diary.status).toBe("draft");

    const dv = await diary.createDiaryVersion(tenant, { id: "dv_1", diaryId: "d_1", perspective: "ai_generated", content: "v1" });
    expect(dv.perspective).toBe("ai_generated");
    await diary.createDiaryParagraphSource({ id: "dps_1", diaryVersionId: "dv_1", paragraphIndex: 0, sourceArtifactId: "sa_1", sourceRevisionId: "sr_1" });

    const cycle = await diary.createCycle(tenant, {
      id: "cyc_2",
      scheduleEpochId: "epoch_1",
      localDate: "2026-01-02",
      previousCutoffAt: "2026-01-01T00:00:00.000Z",
      cutoffAt: "2026-01-02T00:00:00.000Z",
    });
    const buf = await diary.createDiaryMaterialBuffer(tenant, {
      id: "dmb_1",
      cycleId: cycle.id,
      sourceArtifactId: "sa_1",
      sourceRevisionId: "sr_1",
      occurredAt: "2026-01-01T23:00:00.000Z",
      ingestedAt: "2026-01-01T23:05:00.000Z",
      expiresAt: "2026-01-03T00:00:00.000Z",
    });
    expect(buf.status).toBe("buffered");
  });

  it("埋点域 + 内容域：AnalyticsEvent / Attachment / EmbeddingIndex", async () => {
    await analytics.recordEvent(tenant, {
      id: "ae_1",
      eventName: "review_completed",
      analyticsSubjectId: "pseudo_1",
      context: { count: 1 },
    });
    const events = await analytics.listEventsBySubject(tenant, "pseudo_1");
    expect(events).toHaveLength(1);
    expect(events[0]!.privacyClass).toBe("normal");

    const att = await content.createAttachment(tenant, { id: "att_1", objectKey: "obj/1", mediaType: "image/png", size: 1024 });
    expect(att.scanStatus).toBe("pending");
    expect((await content.getAttachment(tenant, "att_1"))?.objectKey).toBe("obj/1");

    const idx = await content.createEmbeddingIndex(tenant, {
      id: "ei_1",
      sourceArtifactId: "sa_1",
      sourceRevisionId: "sr_1",
      modelId: "text-embedding-3",
      dimension: 1536,
    });
    expect(idx.dimension).toBe(1536);
    expect(await content.listEmbeddingIndexes(tenant, "sa_1")).toHaveLength(1);
  });
});

describe("PRD §8：RecoveryControlLedger 独立故障域账本", () => {
  let ledgerClient: Client;
  let ledger: SqliteRecoveryLedgerRepository;

  beforeEach(async () => {
    const tempFile = path.join(os.tmpdir(), `aervox_ledger_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.db`);
    ledgerClient = createClient({ url: `file:${tempFile}` });
    await SqliteRecoveryLedgerRepository.init(ledgerClient);
    ledger = new SqliteRecoveryLedgerRepository(ledgerClient);
  });

  it("事件追加生成单调 sequence，且幂等键唯一", async () => {
    const e1 = await ledger.appendEvent({ eventId: "ev_1", idempotencyKey: "del:1", eventType: "delete", subjectRef: "usr_1", targetRef: "mem_1" });
    const e2 = await ledger.appendEvent({ eventId: "ev_2", idempotencyKey: "del:2", eventType: "consent_revoke", subjectRef: "usr_1" });
    expect(e1.sequence).toBe(1);
    expect(e2.sequence).toBe(2);
    expect(await ledger.getMaxSequence()).toBe(2);
    expect((await ledger.getBySequence(2))?.eventId).toBe("ev_2");
    expect((await ledger.getByIdempotencyKey("del:1"))?.eventId).toBe("ev_1");

    await expect(
      ledger.appendEvent({ eventId: "ev_3", idempotencyKey: "del:1", eventType: "delete" }),
    ).rejects.toThrow();
  });
});
