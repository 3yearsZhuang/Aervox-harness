import { beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import {
  createInMemoryDatabase,
  createProactiveVaultCipher,
  initDatabaseSchema,
  SqliteProactiveIntelligenceRepository,
  type AervoxDatabase,
} from "../src/index.js";

const ctx = {workspaceId: "ws_intel", subjectUserId: "usr_intel"} as const;
const other = {workspaceId: "ws_other", subjectUserId: "usr_other"} as const;

describe("proactive intelligence repository", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteProactiveIntelligenceRepository;

  beforeEach(async () => {
    const database = await createInMemoryDatabase();
    db = database.db;
    client = database.client;
    await initDatabaseSchema(client);
    repo = new SqliteProactiveIntelligenceRepository(
      db,
      createProactiveVaultCipher(new Uint8Array(32).fill(6), "intelligence-test"),
    );
  });

  it("persists the twelve intelligence surfaces with local-only models", async () => {
    const timeline = await repo.createTimelineEvent(ctx, {
      id: "timeline_1", revisionId: "profile_1", sourceGrantId: "source_1",
      sourceKey: "aervox.operation", eventType: "tool.opened", subjectKey: "project:alpha",
      title: "Opened the Alpha workspace", summary: "Deep work began", payload: {tool: "editor"},
      privacyClass: "private", projectId: "project_1", relationshipId: null,
      checksum: "timeline-checksum-1", occurredAt: "2026-08-29T08:00:00.000Z",
    });
    expect(timeline.title).toContain("Alpha");

    await repo.upsertProject(ctx, {
      id: "project_1", revisionId: "profile_1", title: "Alpha", objective: "Ship Alpha",
      description: "Private project", status: "active", priority: 80, confidence: 90,
      dueAt: "2026-09-10T00:00:00.000Z", lastActivityAt: timeline.occurredAt,
      sourceTimelineIds: [timeline.id],
    });
    await repo.upsertRelationship(ctx, {
      id: "relationship_1", revisionId: "profile_1", relationshipType: "collaborator",
      displayName: "Alice", notes: "Prefers concise updates", confidence: 85,
      lastInteractionAt: timeline.occurredAt, sourceGrantIds: ["source_1"],
    });
    await repo.createCommitment(ctx, {
      id: "commitment_1", revisionId: "profile_1", projectId: "project_1",
      relationshipId: "relationship_1", content: "Send Alpha update", status: "open",
      importance: 90, dueAt: "2026-08-30T09:00:00.000Z", sourceTimelineId: timeline.id,
    });
    await repo.upsertWorkflow(ctx, {
      id: "workflow_1", revisionId: "profile_1", name: "Prepare Alpha workspace",
      description: "Open editor and task board", state: "candidate", trigger: {weekday: true},
      steps: [{tool: "editor.open"}, {tool: "tasks.open"}], evidenceCount: 3,
      successCount: 0, failureCount: 0, lastObservedAt: timeline.occurredAt,
    });
    await repo.upsertTriggerRule(ctx, {
      id: "rule_1", revisionId: "profile_1", name: "Prepare before commitment",
      triggerType: "commitment_due", condition: {minutesBefore: 30}, action: {kind: "prepare"},
      enabled: true, cooldownSeconds: 1800, quietHours: {start: "22:00", end: "07:00"},
      lastTriggeredAt: null,
    });
    await repo.recordTriggerEvent(ctx, {
      id: "trigger_1", revisionId: "profile_1", ruleId: "rule_1", triggerType: "commitment_due",
      cause: {commitmentId: "commitment_1"}, decision: "prepared", reason: "due_soon",
    });
    await repo.upsertActionVerification(ctx, {
      id: "verification_1", actionId: "action_1", expected: {fileExists: true},
      observed: {fileExists: true}, status: "verified", attemptCount: 1,
      verifiedAt: "2026-08-29T08:01:00.000Z",
    });
    await repo.createClaimConflict(ctx, {
      id: "conflict_1", revisionId: "profile_1", primaryClaimId: "claim_1",
      conflictingClaimId: "claim_2", reason: "same subject has different preferred time",
    });
    await repo.createPreparation(ctx, {
      id: "preparation_1", revisionId: "profile_1", projectId: "project_1",
      commitmentId: "commitment_1", title: "Alpha briefing", bundle: {timelineIds: [timeline.id]},
    });
    await repo.createAttentionState(ctx, {
      id: "attention_1", revisionId: "profile_1", windowStart: "2026-08-29T08:00:00.000Z",
      windowEnd: "2026-08-29T09:00:00.000Z", focusScore: 72, fatigueScore: 28,
      contextSwitches: 3, recommendation: "Continue deep work", evidence: [timeline.id],
    });
    await repo.createDriftSignal(ctx, {
      id: "drift_1", revisionId: "profile_1", signalType: "project_stalled", projectId: "project_1",
      expected: {activeDays: 5}, actual: {activeDays: 1}, severity: 70,
      explanation: "Alpha activity is below the declared plan",
    });
    await repo.createScene(ctx, {
      id: "scene_1", revisionId: "profile_1", sceneType: "desktop_work",
      applicationId: "editor", payload: {windows: 2}, checksum: "scene-checksum-1",
    });
    await repo.upsertReview(ctx, {
      id: "review_1", revisionId: "profile_1", periodType: "daily",
      periodStart: "2026-08-29", periodEnd: "2026-08-29", summary: "Focused on Alpha",
      metrics: {focusMinutes: 60}, recommendations: ["Continue Alpha tomorrow"],
    });

    const exported = await repo.exportSnapshot(ctx);
    expect(exported.timeline).toHaveLength(1);
    expect(exported.projects).toHaveLength(1);
    expect(exported.commitments).toHaveLength(1);
    expect(exported.relationships).toHaveLength(1);
    expect(exported.workflows).toHaveLength(1);
    expect(exported.triggerRules).toHaveLength(1);
    expect(exported.triggerEvents).toHaveLength(1);
    expect(exported.verifications).toHaveLength(1);
    expect(exported.conflicts).toHaveLength(1);
    expect(exported.preparations).toHaveLength(1);
    expect(exported.attentionStates).toHaveLength(1);
    expect(exported.driftSignals).toHaveLength(1);
    expect(exported.scenes).toHaveLength(1);
    expect(exported.reviews).toHaveLength(1);
    expect((await repo.listTimeline(other)).length).toBe(1);
  });

  it("encrypts connector credentials and supports Home Assistant plus Xiaomi health", async () => {
    const ha = await repo.upsertConnection(ctx, {
      id: "conn_ha", revisionId: "profile_1", provider: "home_assistant",
      displayName: "Home", endpoint: "http://127.0.0.1:8123", authType: "llat",
      credential: {accessToken: "ha-secret-token"}, scopes: ["read", "call_service"],
      settings: {entityAllowlist: ["light.study"]},
    });
    expect(ha.hasCredential).toBe(true);
    await repo.upsertHomeEntity(ctx, {
      id: "entity_1", connectionId: ha.id, entityId: "light.study", domain: "light",
      displayName: "Study Light", allowedOps: ["read", "turn_on", "turn_off"],
      state: {state: "off"}, enabled: true,
    });

    const health = await repo.upsertConnection(ctx, {
      id: "conn_mi", revisionId: "profile_1", provider: "xiaomi_health",
      displayName: "Mi Fitness", endpoint: "https://health.example.test", authType: "oauth2",
      credential: {accessToken: "mi-secret-token", refreshToken: "mi-refresh"},
      scopes: ["steps", "sleep"], settings: {dailyPath: "/v1/daily"},
    });
    await repo.upsertHealthSample(ctx, {
      id: "health_steps", connectionId: health.id, metric: "steps", localDate: "2026-08-29",
      value: 8123, unit: "count", sensitivity: "low", metadata: {device: "band"},
    });
    await repo.upsertHealthSample(ctx, {
      id: "health_sleep", connectionId: health.id, metric: "sleep_minutes", localDate: "2026-08-29",
      value: 421, unit: "minute", sensitivity: "medium", metadata: {quality: 82},
    });

    const secret = await repo.getConnectionSecret(ctx, "conn_mi");
    expect(secret?.credential).toMatchObject({accessToken: "mi-secret-token"});
    expect((await repo.listHomeEntities(ctx, ha.id, true))[0]).toMatchObject({entityId: "light.study"});
    expect((await repo.listHealthSamples(ctx, {connectionId: health.id}))).toHaveLength(2);
    const raw = await client.execute("SELECT credential_json FROM proactive_external_connections WHERE id = 'conn_mi'");
    expect(String(raw.rows[0]?.credential_json)).toMatch(/^avxenc:v1:/);
    expect(String(raw.rows[0]?.credential_json)).not.toContain("mi-secret-token");
    expect((await repo.listConnections(ctx))[0]).not.toHaveProperty("credential");
  });

  it("批量时间线写入按 checksum 幂等，并准确返回新增行", async () => {
    const inputs = [0, 1, 2].map((index) => ({
      id: `timeline_batch_${index}`,
      revisionId: "profile_batch",
      sourceGrantId: null,
      sourceKey: "aervox.operation",
      eventType: "tool.opened",
      subjectKey: `project:${index}`,
      title: `Project ${index}`,
      summary: null,
      payload: {index},
      privacyClass: "private",
      projectId: null,
      relationshipId: null,
      checksum: `timeline-batch-${index}`,
      occurredAt: `2026-08-29T0${index}:00:00.000Z`,
    }));

    await expect(repo.createTimelineEvents(ctx, inputs)).resolves.toHaveLength(3);
    // 重跑同一批只应命中唯一 checksum，不产生重复行或虚增新增计数。
    await expect(repo.createTimelineEvents(ctx, inputs)).resolves.toHaveLength(0);
    await expect(repo.listTimeline(ctx, {limit: 10})).resolves.toHaveLength(3);
    // 冲突目标限定为 checksum；主键冲突但 checksum 不同不能被静默吞掉。
    await expect(repo.createTimelineEvent(ctx, {
      ...inputs[0]!,
      checksum: "timeline-batch-conflicting-checksum",
    })).rejects.toThrow();
  });

  it("批量冲突写入按 claim pair 幂等，并返回实际插入数", async () => {
    const inputs = [
      {id: "conflict_batch_1", revisionId: "profile_batch", primaryClaimId: "claim_a", conflictingClaimId: "claim_b", reason: "different"},
      {id: "conflict_batch_2", revisionId: "profile_batch", primaryClaimId: "claim_a", conflictingClaimId: "claim_c", reason: "different"},
      // 同一 pair 在同一批次内重复，唯一索引应只保留一行。
      {id: "conflict_batch_duplicate", revisionId: "profile_batch", primaryClaimId: "claim_a", conflictingClaimId: "claim_b", reason: "duplicate"},
    ];

    await expect(repo.createClaimConflicts(ctx, inputs)).resolves.toBe(2);
    await expect(repo.createClaimConflicts(ctx, inputs)).resolves.toBe(0);
    await expect(repo.listClaimConflicts(ctx)).resolves.toHaveLength(2);
    await expect(repo.countClaimConflicts(ctx, "open", "profile_batch")).resolves.toBe(2);
    // 同样不能把主键冲突误判为 claim pair 幂等。
    await expect(repo.createClaimConflict(ctx, {
      id: "conflict_batch_1",
      revisionId: "profile_batch",
      primaryClaimId: "claim_x",
      conflictingClaimId: "claim_y",
      reason: "different pair",
    })).rejects.toThrow();
  });
});
