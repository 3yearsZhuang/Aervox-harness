/**
 * Aervox｜思隅 @aervox/api — DSH 进程外 Adapter 准入解析与整 Turn 执行（ADR-010 阶段 6f）
 *
 * AERVOX_LOOP_DRIVER=dsh 时由 runLoopTurnOnce 调用；执行语义（claim/事件映射/
 * finalize）在 @aervox/host-agent 的 runAdapterTurn：
 * - 宿主实例缓存已准入 stdio handle（逐 Turn ping-pong 复用，不重复 spawn）
 *   与 probe 失败的禁用态（后续 Turn 快速失败，不重复准入探测）；
 * - 准入：probeDSHReference（submodule gitlink 固定 SHA + MIT 白名单），未就绪不 spawn；
 * - repoRoot：启动配置显式指定优先，缺省从启动工作目录向上查找含
 *   reference/deepseek-harness 的目录（monorepo dev 的 API cwd 可能为 apps/api）；
 * - runner 环境经 stdio spawn 继承进程 env（DEEPSEEK_API_KEY / DSH_LLM_BASE_URL /
 *   DSH_MODEL_ID），端口层自带握手准入、单 Turn 超时、kill switch 与失败自动禁用。
 *
 * 机械拆分自 agent-executor.ts（B 档第三步，零行为变更）：
 * failTurnWithError 与 runDshAdapterTurn（整 Turn 交已准入 DSH Adapter 执行）
 * 逐字节迁移至本文件。
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createDSHAdapterDriver, runAdapterTurn, type SqliteExecutionStore } from "@aervox/host-agent";
import { awaitWithSignal, type AdapterDriverPort } from "@aervox/core";
import type { LocalContext, SqliteConversationRepository } from "@aervox/repositories";

export interface DshTurnAdapterOverrides {
  /** 测试注入：显式仓库根（跳过 cwd 向上查找与环境变量） */
  repoRoot?: string;
  /** 测试注入：透传给 runner 的额外环境（如 DSH_LLM_BASE_URL 指向本地兼容端点） */
  env?: Record<string, string>;
}

export type ResolvedDshTurnAdapter =
  | { ok: true; driver: AdapterDriverPort; close: () => Promise<void> }
  | { ok: false; reason: string };

export interface DshTurnAdapterResolver {
  resolve(): Promise<ResolvedDshTurnAdapter>;
  close(): Promise<void>;
}

/** Resolve once from the composition-time working directory, never from a later process.cwd(). */
function findRepoRoot(workingDirectory: string): string | undefined {
  let dir = workingDirectory;
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(dir, "reference", "deepseek-harness"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** A host owns one admitted process and one disabled cache, including startup/close races. */
export function createDshTurnAdapterResolver(
  options: DshTurnAdapterOverrides & { workingDirectory: string },
  createDriver: typeof createDSHAdapterDriver = createDSHAdapterDriver,
): DshTurnAdapterResolver {
  const repoRoot = options.repoRoot ? resolve(options.workingDirectory, options.repoRoot) : findRepoRoot(options.workingDirectory);
  const env = options.env ? { ...options.env } : undefined;
  let cached: Promise<ResolvedDshTurnAdapter> | undefined;
  let closed = false;
  return {
    resolve() {
      if (closed) return Promise.resolve({ ok: false, reason: "dsh_resolver_closed" });
      cached ??= (async (): Promise<ResolvedDshTurnAdapter> => {
        if (!repoRoot) return { ok: false, reason: "dsh_repo_root_not_found: 未找到 reference/deepseek-harness" };
        const { probe, handle } = await createDriver({ repoRoot, env });
        if (!probe.ready || !handle) return { ok: false, reason: `dsh_probe_failed: ${probe.reason ?? "unknown"}` };
        if (closed) { await handle.close(); return { ok: false, reason: "dsh_resolver_closed" }; }
        return { ok: true, driver: handle.driver, close: handle.close };
      })();
      return cached;
    },
    async close() {
      if (closed) return;
      closed = true;
      const result = await cached;
      if (result?.ok) await result.close();
    },
  };
}

/** Explicit standalone probe seam; production keeps its resolver on ConversationHost. */
export async function resolveDshTurnAdapter(options: DshTurnAdapterOverrides): Promise<ResolvedDshTurnAdapter> {
  if (!options.repoRoot) return { ok: false, reason: "dsh_explicit_repo_root_required" };
  return createDshTurnAdapterResolver({ ...options, workingDirectory: options.repoRoot }).resolve();
}

/** 迁移期接线：把 Loop 未完成/配置失败写为 error 事件 + Failed 终态（不抛到 HTTP 层） */
export async function failTurnWithError(
  store: SqliteExecutionStore,
  turnId: string,
  attemptId: string,
  message: string,
  code = "MODEL_UNAVAILABLE",
  expectedFencingToken = 0,
): Promise<void> {
  await store.finalizeAttemptWithEvent({
    turnId, attemptId, status: "Failed", expectedFencingToken,
    sequence: await store.nextSequence(turnId), eventType: "error",
    eventData: { code, retryable: false, message }, safetyDecision: "approved",
  });
}

/**
 * ADR-010 阶段 6f：整 Turn 交已准入的 DSH Adapter 执行（runAdapterTurn：claim →
 * adapter 事件映射既有契约落库 → finalize；SSE 契约零改动）。
 * 终态对齐 turns 表：Completed/Interrupted/Failed 回写；skipped（claim 失败重复投递）不覆盖；
 * 准入失败（子模块缺失/固定 SHA 漂移）fail-closed 写 error 事件 + Failed，不静默回退 native。
 */
export async function runDshAdapterTurn(
  _repo: SqliteConversationRepository,
  _context: LocalContext,
  store: SqliteExecutionStore,
  input: {
    turnId: string;
    sessionId: string;
    attemptId: string;
    userMessage: string;
    systemPrompt?: string;
    preparationFencingToken?: number;
    signal?: AbortSignal;
    deadlineEpochMs?: number;
    deletionGate?: import("@aervox/core").DeletionGatePort;
  },
  onFinalized: ((status: "Completed" | "Failed" | "Interrupted") => Promise<void>) | undefined,
  resolver: DshTurnAdapterResolver,
): Promise<void> {
  const resolved = await awaitWithSignal(resolver.resolve(), input.signal);
  if (!resolved.ok) {
    await failTurnWithError(store, input.turnId, input.attemptId, resolved.reason, "ADAPTER_UNAVAILABLE", input.preparationFencingToken);
    return;
  }
  const result = await runAdapterTurn(store, resolved.driver, {
    turnId: input.turnId,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    userMessage: input.userMessage,
    systemPrompt: input.systemPrompt,
    deadlineEpochMs: input.deadlineEpochMs, signal: input.signal, deletionGate: input.deletionGate,
  });
  if (!result.committed) return;
  if (result.status === "Completed") {
    await onFinalized?.("Completed");
  } else if (result.status === "Failed" || result.status === "Interrupted" || result.status === "Cancelled") {
    if (result.status !== "Cancelled") await onFinalized?.(result.status);
  }
}
