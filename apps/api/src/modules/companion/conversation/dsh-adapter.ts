/**
 * Aervox｜思隅 @aervox/api — DSH 进程外 Adapter 准入解析与整 Turn 执行（ADR-010 阶段 6f）
 *
 * AERVOX_LOOP_DRIVER=dsh 时由 runLoopTurnOnce 调用；执行语义（claim/事件映射/
 * finalize）在 @aervox/host-agent 的 runAdapterTurn：
 * - lazy 单例：进程内缓存已准入 stdio handle（逐 Turn ping-pong 复用，不重复 spawn）
 *   与 probe 失败的禁用态（后续 Turn 快速失败，不重复准入探测）；
 * - 准入：probeDSHReference（submodule gitlink 固定 SHA + MIT 白名单），未就绪不 spawn；
 * - repoRoot：AERVOX_DSH_REPO_ROOT 显式指定优先，缺省从 cwd 向上查找含
 *   reference/deepseek-harness 的目录（monorepo dev 的 API cwd 可能为 apps/api）；
 * - runner 环境经 stdio spawn 继承进程 env（DEEPSEEK_API_KEY / DSH_LLM_BASE_URL /
 *   DSH_MODEL_ID），端口层自带握手准入、单 Turn 超时、kill switch 与失败自动禁用。
 *
 * 机械拆分自 agent-executor.ts（B 档第三步，零行为变更）：
 * failTurnWithError 与 runDshAdapterTurn（整 Turn 交已准入 DSH Adapter 执行）
 * 逐字节迁移至本文件。
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createDSHAdapterDriver, runAdapterTurn, type SqliteExecutionStore } from "@aervox/host-agent";
import type { AdapterDriverPort } from "@aervox/agent-loop";
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

let cached: ResolvedDshTurnAdapter | undefined;

/** 从 cwd 向上查找含 reference/deepseek-harness 的仓库根（有界 8 层） */
function findRepoRootFromCwd(): string | undefined {
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(dir, "reference", "deepseek-harness"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * 解析已准入的 DSH Adapter（进程内缓存）。
 * 禁用态/成功态都缓存：准入失败重启进程才重试，与配置启动期校验语义一致。
 */
export async function resolveDshTurnAdapter(
  overrides: DshTurnAdapterOverrides = {},
): Promise<ResolvedDshTurnAdapter> {
  if (cached) return cached;
  const repoRoot =
    overrides.repoRoot ?? process.env.AERVOX_DSH_REPO_ROOT?.trim() ?? findRepoRootFromCwd();
  if (!repoRoot) {
    cached = {
      ok: false,
      reason:
        "dsh_repo_root_not_found: 未找到 reference/deepseek-harness（git submodule update --init 后重试，或设置 AERVOX_DSH_REPO_ROOT）",
    };
    return cached;
  }
  const { probe, handle } = await createDSHAdapterDriver({ repoRoot, env: overrides.env });
  if (!probe.ready || !handle) {
    cached = { ok: false, reason: `dsh_probe_failed: ${probe.reason ?? "unknown"}` };
    return cached;
  }
  cached = { ok: true, driver: handle.driver, close: handle.close };
  return cached;
}

/** 测试专用：清空缓存（含禁用态），下轮 Turn 重新准入 */
export function resetDshTurnAdapterForTests(): void {
  cached = undefined;
}

/** 迁移期接线：把 Loop 未完成/配置失败写为 error 事件 + Failed 终态（不抛到 HTTP 层） */
export async function failTurnWithError(
  store: SqliteExecutionStore,
  turnId: string,
  attemptId: string,
  message: string,
  code = "MODEL_UNAVAILABLE",
): Promise<void> {
  await store.appendEvent({
    turnId,
    attemptId,
    sequence: await store.nextSequence(turnId),
    eventType: "error",
    data: {
      code,
      retryable: false,
      message,
      lastSequence: Math.max(0, (await store.nextSequence(turnId)) - 1),
    },
    safetyDecision: "approved",
    // B1：Attempt 未被 claim（fencing=0）；携带期望值使事件写入走 fencing CAS（抢占后自然被拒）
    expectedFencingToken: 0,
  }).catch(() => undefined);
  await store.finalizeAttempt({ turnId, attemptId, status: "Failed" }).catch(() => undefined);
}

/**
 * ADR-010 阶段 6f：整 Turn 交已准入的 DSH Adapter 执行（runAdapterTurn：claim →
 * adapter 事件映射既有契约落库 → finalize；SSE 契约零改动）。
 * 终态对齐 turns 表：Completed/Interrupted/Failed 回写；skipped（claim 失败重复投递）不覆盖；
 * 准入失败（子模块缺失/固定 SHA 漂移）fail-closed 写 error 事件 + Failed，不静默回退 native。
 */
export async function runDshAdapterTurn(
  repo: SqliteConversationRepository,
  tenant: LocalContext,
  store: SqliteExecutionStore,
  input: {
    turnId: string;
    sessionId: string;
    attemptId: string;
    userMessage: string;
    systemPrompt?: string;
  },
  onFinalized?: (status: "Completed" | "Failed" | "Interrupted") => Promise<void>,
): Promise<void> {
  const resolved = await resolveDshTurnAdapter();
  if (!resolved.ok) {
    await failTurnWithError(store, input.turnId, input.attemptId, resolved.reason, "ADAPTER_UNAVAILABLE");
    await repo.updateTurnStatus(tenant, input.turnId, "Failed").catch(() => undefined);
    return;
  }
  const result = await runAdapterTurn(store, resolved.driver, {
    turnId: input.turnId,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    userMessage: input.userMessage,
    systemPrompt: input.systemPrompt,
  });
  if (result.status === "Completed") {
    await repo.updateTurnStatus(tenant, input.turnId, "Completed");
    await onFinalized?.("Completed");
  } else if (result.status === "Failed" || result.status === "Interrupted") {
    await repo.updateTurnStatus(tenant, input.turnId, result.status).catch(() => undefined);
    await onFinalized?.(result.status);
  }
}
