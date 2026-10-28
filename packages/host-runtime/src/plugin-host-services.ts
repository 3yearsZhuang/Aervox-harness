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
  PluginConfigurationPort,
  PluginHostServices,
  PluginLearningFactPort,
  PluginSessionPort,
} from "@aervox/host-plugin-api";
import type { PluginConfigService } from "./modules/ecosystem/plugins/index.js";
import { PluginConfigError } from "./shared/errors.js";
import {
  SqliteConversationRepository,
  SqliteLearningRepository,
  type AervoxDatabase,
  type LocalContext,
} from "@aervox/repositories";

/** Public configuration failures contain stable codes and safe messages, never repository diagnostics. */
export class PluginConfigurationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export class PluginConfigurationConflictError extends PluginConfigurationError {
  constructor() { super(409, "plugin_configuration_conflict", "Plugin configuration or lifecycle changed; reload before saving"); }
}

type ConfigurationService = Pick<PluginConfigService, "getOrdinaryConfig" | "saveConfig" | "getOrdinaryConfigValues">;

function configurationFailure(error: unknown): never {
  if (error instanceof Error && error.message === "plugin_generation_changed") throw new PluginConfigurationConflictError();
  if (error instanceof PluginConfigError) {
    if (error.status === 400) throw new PluginConfigurationError(400, "plugin_configuration_invalid", "Invalid plugin configuration");
    if (error.status === 404 || error.status === 409) throw new PluginConfigurationConflictError();
  }
  throw error;
}

function createConfigurationPort(
  ctx: LocalContext,
  control: PluginHostServiceControl,
  getService: () => ConfigurationService | undefined,
): PluginConfigurationPort {
  // Copy the host-authored identity so callers cannot retarget a previously issued port.
  const { pluginId, generation } = control.pluginGeneration!;
  const active = async () => { await control.checkActive(); control.signal?.throwIfAborted(); };
  const service = () => {
    const current = getService();
    if (!current) throw new PluginConfigurationError(503, "plugin_configuration_unavailable", "Plugin configuration service unavailable");
    return current;
  };
  return {
    async read() {
      try {
        await active();
        const current = service();
        const snapshot = await current.getOrdinaryConfig(ctx, pluginId, generation);
        await active();
        // Admission can await or reenter schema registration. Filter afterwards against a
        // single current plugin row that also rechecks the captured lifecycle identity.
        const values = await current.getOrdinaryConfigValues(pluginId, snapshot.values, generation);
        control.signal?.throwIfAborted();
        return { revision: snapshot.revision, values, lifecycleGeneration: generation };
      } catch (error) { return configurationFailure(error); }
    },
    async save(input) {
      if (!input || typeof input.values !== "object" || input.values === null || Array.isArray(input.values)
        || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
        || typeof input.expectedLifecycleGeneration !== "string" || !input.expectedLifecycleGeneration) {
        throw new PluginConfigurationError(400, "plugin_configuration_invalid", "Invalid plugin configuration expectations");
      }
      if (input.expectedLifecycleGeneration !== generation) throw new PluginConfigurationConflictError();
      try {
        await active();
        const current = service();
        const snapshot = await current.saveConfig(ctx, pluginId, {
          revision: input.expectedRevision, values: input.values, expectedLifecycleGeneration: generation,
        });
        // The writer's receipt already contains only the ordinary values validated against
        // its committed schema. Do not refilter it with a different schema or recheck
        // admission after commit: either could misrepresent a successful write as lost data.
        return { revision: snapshot.revision, values: snapshot.values, lifecycleGeneration: generation };
      } catch (error) { return configurationFailure(error); }
    },
  };
}

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
  getConfigurationService?: () => ConfigurationService | undefined,
): (ctx: LocalContext, control?: PluginHostServiceControl) => PluginHostServices {
  const conversationRepo = new SqliteConversationRepository(db);
  const learningRepo = new SqliteLearningRepository(db);

  return (ctx, control) => ({
    sessions: createSessionPort(conversationRepo, ctx, control),
    learningFacts: createLearningFactPort(learningRepo, ctx, control),
    configuration: control?.pluginGeneration && getConfigurationService
      ? createConfigurationPort(ctx, control, getConfigurationService) : undefined,
  });
}
