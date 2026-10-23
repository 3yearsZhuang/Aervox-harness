/**
 * Aervox｜思隅 @aervox/api — 插件宿主服务适配（CR-060）
 *
 * 本文件是 `@aervox/host-plugin-api` 窄端口在 API 组合根上的**唯一实现点**：
 * 把宿主自有的仓储与本地上下文适配为领域中立的窄端口，供插件在启用时消费。
 *
 * 边界（[能力组合 · 边界判定](../../docs/reference/capability-composition.md)）：
 * 学习事实真源（`packages/schema` 表结构、`packages/repositories` 仓储、
 * `packages/practice-review` 复习排期）按反向检查保留主仓；本文件只是把它们的
 * **普通消费方能力**以窄端口暴露给插件，不转移真源所有权。
 *
 * 本文件不含任何插件领域标识：插件 id、配置键与领域文案一律由插件侧声明。
 */
import { createHash } from "node:crypto";
import { awaitWithSignal, stableSerialize } from "@aervox/core";
import { createLearningAnswerService } from "./modules/learning/learning/index.js";
import type {
  HostRecord,
  PluginHostServices,
  PluginLearningFactPort,
  PluginSessionPort,
} from "@aervox/host-plugin-api";
import {
  SqliteConversationRepository,
  SqliteLearningRepository,
  type AervoxDatabase,
  type LocalContext,
} from "@aervox/repositories";

let seq = 0;
const nextId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${(++seq).toString(36)}`;

/** Exploration is one command so a failed branch cannot leave an orphan session. */
function createSessionPort(repo: SqliteConversationRepository, ctx: LocalContext, control?: PluginHostServiceControl): PluginSessionPort {
  return {
    async createExplorationBranch(input) {
      await control?.checkActive();
      control?.signal?.throwIfAborted();
      const branch = await repo.createExplorationBranch(ctx, {
        id: input.id, idempotencyKey: input.idempotencyKey, parentSessionId: input.parentSessionId,
        childSessionId: input.childSessionId, title: input.title,
        branchReason: input.reason, pluginGeneration: control?.pluginGeneration,
      });
      if (!branch) throw new Error("parent_session_not_found");
      return { id: branch.id, childSessionId: branch.childSessionId };
    },
  };
}

/**
 * 学习事实端口：作答判定落库与练习报告读写。
 *
 * 报告行按 `HostRecord` 不透明转发（插件不解析字段）；题目与作答记录经仓储既有
 * 派生逻辑进入错题本，本文件不做额外写入。
 */
function createLearningFactPort(
  repo: SqliteLearningRepository,
  ctx: LocalContext,
  control?: PluginHostServiceControl,
): PluginLearningFactPort {
  const answers = createLearningAnswerService(repo);
  const call = async <T>(operation: () => Promise<T>): Promise<T> => {
    await control?.checkActive(); control?.signal?.throwIfAborted();
    const value = await awaitWithSignal(operation(), control?.signal);
    await control?.checkActive(); control?.signal?.throwIfAborted();
    return value;
  };
  return {
    async recordJudgedAnswer(input) {
      await control?.checkActive();
      control?.signal?.throwIfAborted();
      const key = input.idempotencyKey ?? createHash("sha256").update(stableSerialize(input)).digest("hex");
      const idempotencyKey = `${control?.pluginGeneration?.pluginId ?? "host"}:${input.turnId}:${key}`;
      const legacyIdempotencyKey = control?.pluginGeneration || !input.source ? undefined : `${input.source}:${input.turnId}:${key}`;
      const { attempt } = await answers.recordAnswer(ctx, { ...input, kind: "judged-question", idempotencyKey, legacyIdempotencyKey, pluginGeneration: control?.pluginGeneration });
      return { questionId: attempt.questionId, attemptId: attempt.id, judgement: input.judgement, enteredMistakeNotebook: attempt.judgement === "incorrect" };
    },

    // 报告行按不透明载荷转发：展开为普通记录，插件侧不解析字段（真源仍在宿主）
    writeReport: draft => call(async (): Promise<HostRecord> =>
      ({ ...(await repo.createPracticeReport(ctx, { ...draft, id: nextId("rpt"), pluginGeneration: control?.pluginGeneration })) })),

    readReport: reportId => call(async (): Promise<HostRecord | null> => {
      const row = await repo.getPracticeReport(ctx, reportId);
      return row ? { ...row } : null;
    }),

    listReports: sessionId => call(async (): Promise<HostRecord[]> =>
      (await repo.listPracticeReports(ctx, sessionId)).map((row) => ({ ...row }))),

    resetInference: sessionId => call(async (): Promise<HostRecord> =>
      ({ ...(await repo.resetMasteryInference(ctx, sessionId, control?.pluginGeneration)) })),
  };
}

/**
 * 构造宿主服务工厂：按当前本地上下文产出插件可见的窄端口集合。
 * 插件不得缓存跨上下文实例，故宿主按 request / turn 粒度调用本工厂。
 */
export interface PluginHostServiceControl {
  signal?: AbortSignal;
  checkActive(): Promise<void>;
  pluginGeneration?: { pluginId: string; generation: string };
}
export function createPluginHostServicesFactory(
  db: AervoxDatabase,
): (ctx: LocalContext, control?: PluginHostServiceControl) => PluginHostServices {
  const conversationRepo = new SqliteConversationRepository(db);
  const learningRepo = new SqliteLearningRepository(db);

  return (ctx, control) => ({
    sessions: createSessionPort(conversationRepo, ctx, control),
    learningFacts: createLearningFactPort(learningRepo, ctx, control),
  });
}
