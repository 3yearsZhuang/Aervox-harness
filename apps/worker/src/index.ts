/**
 * Aervox｜思隅 @aervox/worker — 后台任务入口
 *
 * 规则依据：docs/reference/DATABASE.md §14 + ADR-004 + ADR-011。
 *
 * 调度模型：每类任务独立节拍器（interval），互不阻塞：
 * - 独立频率：每任务可用 WORKER_INTERVAL_<NAME>_MS 覆盖；默认 tick 未改时使用任务级默认频率，显式自定义 tick 仍作为全局回退；
 * - 不重叠：上一轮未结束则跳过本轮（防任务自重叠/堆积），而非排队串行；
 * - 隔离失败：单任务抛错只记录自身日志，不拖垮其它任务与后续轮次。
 */
import { createDatabase,
  initDatabaseSchema,
  SqliteAgentInboxRepository,
  SqliteConversationRepository,
  SqliteExtensionRepository,
  SqliteOutboxRepository,
  SqlitePlatformRepository,
  SqliteDiaryRepository,
  SqliteLLMConfigRepository,
  SqlitePrivacyRepository,
  SqliteLearningRepository,
  SqliteMemoryCompactionRepository,
  SqliteMemoryEmbeddingRepository,
  SqliteMemoryRepository,
  SqlitePersonaRepository,
  SqliteProactiveIntelligenceRepository,
  SqliteProactiveBudgetRepository,
  SqliteProactiveProfileRepository,
  SqliteProactiveSituationRepository,
  SqlitePerceptionEventRepository,
  SqliteSkillRegistryRepository,
  createProactiveVaultDatabase,
  loadProactiveVaultCipher,
} from "@aervox/repositories";
import { loadWorkerConfig } from "@aervox/config";
import { registerWorkerShutdown } from "./shutdown.js";
import { createServer } from "node:http";
import { createStandardLogger } from "@aervox/observability";
import { createReplayProvider, HostToolRuntime } from "@aervox/core";
import { resolveEmbeddingProvider, resolveModelProvider, createHostToolProvider, createSqliteMemoryRecall } from "@aervox/host-agent";
import { runOutboxCycle } from "./outbox-worker.js";
import { createTurnConsumerHandler } from "./turn-consumer.js";
import { runReviewNotificationCycle } from "./review-notifier.js";
import { runDiaryGenerationCycle } from "./diary-generator.js";
import { runDeletionCycle } from "./deletion-worker.js";
import { runCompactionMarkerCycle } from "./compaction-marker.js";
import { runEmbeddingMigrationCycle } from "./embedding-migration.js";
import { runAttemptRecoveryCycle } from "./attempt-recovery.js";
import { runInboxExpiryCycle } from "./inbox-expiry.js";
import { createRuleBasedProactiveDistiller } from "./proactive/distiller.js";
import { runProactiveProfileCycle } from "./proactive/profile-worker.js";
import { runProactiveIntelligenceCycle } from "./proactive/intelligence-worker.js";
import { resolveWorkerTaskInterval } from "./task-scheduling.js";

// 集中类型化配置（WORKER_ID / WORKER_TICK_MS / WORKER_INTERVAL_<NAME>_MS；启动期校验）
const config = loadWorkerConfig();
const unsupportedProactiveFlags = [...config.proactiveFeatureFlags]
  .filter((flag) => !["situation_projection", "proactive_dsl", "attention_budget", "proactive_persona", "perception_events"].includes(flag));
if (unsupportedProactiveFlags.length > 0) {
  throw new Error(
    `[config] CR-033 runtime slices are not wired yet; refusing no-op flags: ${unsupportedProactiveFlags.join(",")}`,
  );
}
if (config.proactiveFeatureFlags.has("proactive_dsl") && !config.proactiveFeatureFlags.has("situation_projection")) {
  throw new Error("[config] AERVOX_PROACTIVE_DSL requires AERVOX_PROACTIVE_SITUATION_PROJECTION");
}
if (config.proactiveFeatureFlags.has("attention_budget") && !config.proactiveFeatureFlags.has("proactive_dsl")) {
  throw new Error("[config] AERVOX_PROACTIVE_ATTENTION_BUDGET requires AERVOX_PROACTIVE_DSL");
}
if (config.proactiveFeatureFlags.has("perception_events") && !config.proactiveFeatureFlags.has("situation_projection")) {
  throw new Error("[config] AERVOX_PROACTIVE_PERCEPTION_EVENTS requires AERVOX_PROACTIVE_SITUATION_PROJECTION");
}
const logger = createStandardLogger({
  level: config.logLevel,
  format: config.logFormat,
  defaultFields: { service: "worker", workerId: config.workerId },
});

const { db, client } = await createDatabase();
await initDatabaseSchema(client);
const { db: proactiveDb, client: proactiveClient } = await createProactiveVaultDatabase();
await initDatabaseSchema(proactiveClient);
const proactiveCipher = await loadProactiveVaultCipher();

const workerId = config.workerId;
const defaultTickMs = config.tickMs;

const outboxRepo = new SqliteOutboxRepository(db);
const platformRepo = new SqlitePlatformRepository(db);
const conversationRepo = new SqliteConversationRepository(db);
const llmConfigRepo = new SqliteLLMConfigRepository(db);
const toolRuntime = new HostToolRuntime();
const hostToolProvider = createHostToolProvider(toolRuntime, conversationRepo);

const privacyRepo = new SqlitePrivacyRepository(db);
const embeddingRepo = new SqliteMemoryEmbeddingRepository(db);
const embeddingProvider = resolveEmbeddingProvider(process.env);
const memoryRecall = createSqliteMemoryRecall({
  db,
  client,
  embeddingProvider,
  consentCheck: (purpose, scope) => privacyRepo.hasActiveConsent({ workspaceId: "local", subjectUserId: "local" }, purpose, scope),
});

const turnConsumer = createTurnConsumerHandler({
  repo: conversationRepo,
  provider: () => resolveModelProvider(process.env, { llmConfigRepo }),
  tools: hostToolProvider,
  memoryRecall,
});
const diaryRepo = new SqliteDiaryRepository(db);
const learningRepo = new SqliteLearningRepository(db);
const compactionRepo = new SqliteMemoryCompactionRepository(db);
const memoryRepo = new SqliteMemoryRepository(db, client);
const personaRepo = new SqlitePersonaRepository(db);
const inboxRepo = new SqliteAgentInboxRepository(db);
const extensionRepo = new SqliteExtensionRepository(db);
const skillRegistryRepo = new SqliteSkillRegistryRepository(db);
const proactiveRepo = new SqliteProactiveProfileRepository(proactiveDb, proactiveCipher);
const proactiveIntelligenceRepo = new SqliteProactiveIntelligenceRepository(proactiveDb, proactiveCipher);
const proactiveSituationRepo = new SqliteProactiveSituationRepository(proactiveDb, proactiveCipher);
const proactiveBudgetRepo = new SqliteProactiveBudgetRepository(proactiveDb);
const perceptionRepo = new SqlitePerceptionEventRepository(proactiveDb);
const proactiveDistiller = createRuleBasedProactiveDistiller();

import { WorkerHost } from "./worker-host.js";

const host = new WorkerHost({
  workerId,
  defaultTickMs,
  intervalOverrides: config.intervalOverrides,
  logger,
  enableIpc: true,
});

host
  .registerJob({
    name: "outbox",
    run: () =>
      runOutboxCycle({
        outboxRepo,
        platformRepo,
        workerId,
        handlers: {
          "turn.created": turnConsumer,
          "agent.turn.requested": turnConsumer,
        },
      }),
  })
  .registerJob({
    name: "review",
    run: () => runReviewNotificationCycle({ db, platformRepo, learningRepo, workerId }),
  })
  .registerJob({
    name: "diary",
    run: () => runDiaryGenerationCycle({ db, diaryRepo, llmConfigRepo, platformRepo, outboxRepo, workerId }),
  })
  .registerJob({
    name: "deletion",
    run: () => runDeletionCycle({ db, privacyRepo, platformRepo, workerId }),
  })
  .registerJob({
    name: "compaction",
    run: () => runCompactionMarkerCycle({ outboxRepo, compactionRepo, workerId }),
  })
  .registerJob({
    name: "embedding",
    run: () => runEmbeddingMigrationCycle({ db, client, embeddingRepo, provider: embeddingProvider, workerId }),
  })
  .registerJob({
    name: "attempt-recovery",
    run: () => runAttemptRecoveryCycle({ db, client, workerId, provider: createReplayProvider(), privacyRepo }),
  })
  .registerJob({
    name: "inbox-expiry",
    run: () => runInboxExpiryCycle({ inboxRepo }),
  })
  .registerJob({
    name: "proactive-profile",
    run: async () => {
      const result = await runProactiveProfileCycle({
        db: proactiveDb,
        repo: proactiveRepo,
        distiller: proactiveDistiller,
        workerId,
      });
      if (result.failed > 0) {
        logger.warn({
          event: "worker.task.warning",
          message: `proactive-profile failed=${result.failed}`,
          fields: { task: "proactive-profile", failed: result.failed },
        });
      }
      return result.distilled + result.purged;
    },
  })
  .registerJob({
    name: "proactive-intelligence",
    run: async () => {
      const result = await runProactiveIntelligenceCycle({
        db: proactiveDb,
        profileRepo: proactiveRepo,
        intelligenceRepo: proactiveIntelligenceRepo,
        situationRepo: proactiveSituationRepo,
        budgetRepo: proactiveBudgetRepo,
        personaRepo,
        memoryRepo,
        perceptionRepo,
        proactiveFeatureFlags: config.proactiveFeatureFlags,
        platformRepo,
        workerId,
        // CR-032：插件化主动调度依赖（插件声明/感知源授权 + 关怀话术组合器 + 插件 SKILL.md）
        extensionRepo,
        llmConfigRepo,
        skillRegistry: skillRegistryRepo,
      });
      return result.timeline + result.projects + result.workflows + result.triggers +
        result.verifications + result.conflicts + result.preparations + result.attention +
        result.drift + result.relationships + result.scenes + result.reviews +
        result.dispatches + result.projections + result.budgetReceipts + result.perceptionEvents;
    },
  });

host.start();

// An optional loopback readiness endpoint is owned by the deployment supervisor.
// It exposes no database, credentials, task data or mutation surface.
const healthPort = process.env.AERVOX_WORKER_HEALTH_PORT ? Number(process.env.AERVOX_WORKER_HEALTH_PORT) : undefined;
const healthServer = healthPort === undefined ? undefined : createServer((request, response) => {
  if (request.method !== "GET" || request.url !== "/health") { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "content-type": "application/json" }); response.end('{"status":"ok","role":"worker"}');
});
if (healthServer) {
  if (!Number.isSafeInteger(healthPort) || healthPort! < 1024 || healthPort! > 65535) throw new Error("Invalid Worker health port");
  await new Promise<void>((resolve, reject) => {
    healthServer.once("error", reject); healthServer.listen(healthPort, "127.0.0.1", resolve);
  });
}

registerWorkerShutdown({ host, clients: [client, proactiveClient], healthServer, logger });
