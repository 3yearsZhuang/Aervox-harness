/**
 * Aervox｜思隅 @aervox/api — 服务端会话回合插件执行编排器 (Server Turn Plugin Runner)
 *
 * 统一负责：
 * 1. 插件启用状态门控检查（通过 IExtensionRepository.getPlugin(id).enabled === 1）；
 * 2. 插件配置动态拉取（通过 IPluginConfigRepository.getConfig(tenant, id)）；
 * 3. 编排并收集各插件的 beforeTurn 提示词与状态标记；
 * 4. 在回合结束后分发 afterTurn 执行增强后处理。
 */
import type { IExtensionRepository, IPluginConfigRepository, PluginModel } from "@aervox/repositories";
import type { ServerTurnPluginRegistry } from "./registry.js";
import type { LocalContext } from "@aervox/repositories";
import type { AfterTurnContext, BeforeTurnResult, TurnPluginContext } from "./types.js";

/** 仅宿主使用：异步准备完成后、真正写入前再次验证准入。 */
export interface PluginStreamCommitControl {
  signal: AbortSignal;
  checkActive(): Promise<void>;
}

export type TurnPluginHostContext = Omit<TurnPluginContext, "signal" | "deadlineEpochMs" | "stream"> & {
  signal?: AbortSignal;
  deadlineEpochMs?: number;
  stream: Omit<TurnPluginContext["stream"], "appendEvent"> & {
    appendEvent(input: Parameters<TurnPluginContext["stream"]["appendEvent"]>[0], control?: PluginStreamCommitControl): ReturnType<TurnPluginContext["stream"]["appendEvent"]>;
  };
};

export const DEFAULT_PLUGIN_HOOK_TIMEOUT_MS = 15_000;

export interface PluginExecutionSnapshot {
  isEnabled: boolean;
  lifecycleGeneration?: string;
  configValues?: Record<string, unknown>;
}

export interface BeforeTurnExecutionResult {
  extraSections: string[];
  pluginResults: Map<string, BeforeTurnResult>;
  snapshots?: Map<string, PluginExecutionSnapshot>;
}

/**
 * 通用解析插件在仓储中的启用状态。
 *
 * fail-closed：仓储缺失、无记录、未启用或不可用一律视为不生效。
 * CR-060：无别名体系，故只按插件唯一 id 探测（避免同一插件按多 id 生效导致判据分叉）。
 */
async function resolvePluginRecord(
  pluginId: string,
  extRepo?: IExtensionRepository | null,
): Promise<PluginModel | null> {
  if (!extRepo) return null;
  return extRepo.getPlugin(pluginId).catch(() => null);
}

async function resolvePluginEnabled(pluginId: string, extRepo?: IExtensionRepository | null): Promise<boolean> {
  const record = await resolvePluginRecord(pluginId, extRepo);
  if (!record) return false;
  return record.enabled === 1 && (record.availability ?? "available") === "available";
}

/**
 * 插件启用门控（对外复用入口）。
 *
 * 供回合切面 Runner 之外的插件贡献消费者（如工具贡献装配）复用同一判据：
 * 插件贡献一律**按启用状态 fail-closed** —— 禁用、缺记录或不可用的插件不得生效。
 */
export async function isPluginEnabled(
  pluginId: string,
  extRepo: IExtensionRepository | null | undefined,
): Promise<boolean> {
  return resolvePluginEnabled(pluginId, extRepo);
}

/**
 * 解析插件配置值（CR-060：无别名体系，只按插件唯一 id 读取）
 */
async function resolvePluginConfigValues(
  pluginId: string,
  configRepo: IPluginConfigRepository,
  tenant: LocalContext,
): Promise<Record<string, unknown> | undefined> {
  const model = await configRepo.getConfig(tenant, pluginId).catch(() => null);
  if (!model?.valuesJson) return undefined;
  return typeof model.valuesJson === "string"
    ? JSON.parse(model.valuesJson)
    : (model.valuesJson as Record<string, unknown>);
}

/**
 * Runner 的宿主依赖。
 * `tenant` 是宿主侧概念（用于读取插件配置），**不进入插件上下文**——插件经窄端口
 * 工作，不感知本地上下文（CR-060）。
 */
export interface TurnPluginRunnerDeps {
  tenant: LocalContext;
  extRepo?: IExtensionRepository | null;
  configRepo?: IPluginConfigRepository | null;
  /** 每次 Hook 的等待上限，默认 15 秒，上限 60 秒；不是进程内硬终止。 */
  hookTimeoutMs?: number;
  /**
   * 单个插件切面异常的上报出口。缺省落到 `console.warn`——切面异常必须留痕，
   * 不得静默吞掉（否则插件失效在生产中不可观测）。
   */
  onPluginError?: (pluginId: string, phase: "beforeTurn" | "afterTurn", error: unknown) => void;
}

function waitForSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("plugin_hook_cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Each invocation owns its ports. Late results and calls cannot outlive that invocation. */
async function runHook<C extends TurnPluginHostContext, T>(
  pluginId: string, ctx: C, deps: TurnPluginRunnerDeps,
  execute: (context: C & TurnPluginContext, checkActive: () => Promise<void>, lifecycleGeneration: string) => Promise<T>,
  expectedGeneration?: string,
): Promise<T> {
  const timeout = deps.hookTimeoutMs ?? DEFAULT_PLUGIN_HOOK_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 60_000) throw new Error("invalid_plugin_hook_timeout");
  if (ctx.deadlineEpochMs !== undefined && !Number.isFinite(ctx.deadlineEpochMs)) throw new Error("invalid_plugin_hook_deadline");
  const deadlineEpochMs = Math.min(Date.now() + timeout, ctx.deadlineEpochMs ?? Infinity);
  const controller = new AbortController();
  const signal = controller.signal;
  let lifecycleGeneration = expectedGeneration;
  const onAbort = () => controller.abort(ctx.signal?.reason ?? new Error("plugin_hook_cancelled"));
  ctx.signal?.addEventListener("abort", onAbort, { once: true });
  if (ctx.signal?.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(new Error("plugin_hook_timeout")), Math.max(0, deadlineEpochMs - Date.now()));
  const assertActive = () => {
    if (Date.now() >= deadlineEpochMs && !signal.aborted) controller.abort(new Error("plugin_hook_timeout"));
    signal.throwIfAborted();
  };
  const checkActive = async () => {
    assertActive();
    const record = await waitForSignal(resolvePluginRecord(pluginId, deps.extRepo), signal);
    assertActive();
    if (!record || record.enabled !== 1 || (record.availability ?? "available") !== "available"
      || typeof record.lifecycleGeneration !== "string" || !record.lifecycleGeneration) {
      controller.abort(new Error("plugin_hook_unavailable"));
      signal.throwIfAborted();
    }
    if (lifecycleGeneration !== undefined && lifecycleGeneration !== record!.lifecycleGeneration) {
      controller.abort(new Error("plugin_hook_generation_changed"));
      signal.throwIfAborted();
    }
    lifecycleGeneration = record!.lifecycleGeneration;
  };
  const call = async <V>(operation: () => Promise<V>): Promise<V> => {
    await checkActive();
    const value = await waitForSignal(operation(), signal);
    await checkActive();
    return value;
  };
  const scopedContext = {
    ...ctx, signal, deadlineEpochMs,
    stream: {
      readEvents: (turnId: string, fromSequence: number) => call(() => ctx.stream.readEvents(turnId, fromSequence)),
      appendEvent: (input: Parameters<TurnPluginContext["stream"]["appendEvent"]>[0]) => call(() => ctx.stream.appendEvent(input, { signal, checkActive })),
    },
    llm: ctx.llm ? {
      generate: (prompt: string, options?: Parameters<NonNullable<TurnPluginContext["llm"]>["generate"]>[1]) => call(() => {
        const operationSignal = options?.signal ? AbortSignal.any([signal, options.signal]) : signal;
        operationSignal.throwIfAborted();
        return waitForSignal(ctx.llm!.generate(prompt, { ...options, signal: operationSignal }), operationSignal);
      }),
    } : ctx.llm,
  } as C & TurnPluginContext;
  try {
    assertActive();
    return await waitForSignal((async () => {
      await checkActive();
      const result = await execute(scopedContext, checkActive, lifecycleGeneration!);
      await checkActive();
      return result;
    })(), signal);
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", onAbort);
    controller.abort(new Error("plugin_hook_finished"));
  }
}

function reportPluginError(
  deps: TurnPluginRunnerDeps,
  pluginId: string,
  phase: "beforeTurn" | "afterTurn",
  error: unknown,
): void {
  if (deps.onPluginError) {
    deps.onPluginError(pluginId, phase, error);
    return;
  }
  console.warn(`[turn-plugins] 插件 ${pluginId} 的 ${phase} 执行失败，已隔离：`, error);
}

export async function executeBeforeTurnPlugins(
  registry: ServerTurnPluginRegistry,
  ctx: TurnPluginHostContext,
  deps: TurnPluginRunnerDeps,
): Promise<BeforeTurnExecutionResult> {
  const { tenant, configRepo } = deps;
  const extraSections: string[] = [];
  const pluginResults = new Map<string, BeforeTurnResult>();
  const snapshots = new Map<string, PluginExecutionSnapshot>();

  for (const plugin of registry.getAll()) {
    if (ctx.signal?.aborted) break;
    snapshots.set(plugin.id, { isEnabled: false });
    try {
      const res = await runHook(plugin.id, ctx, deps, async (scoped, checkActive, lifecycleGeneration) => {
        const configValues = configRepo ? await resolvePluginConfigValues(plugin.id, configRepo, tenant).catch(() => undefined) : undefined;
        await checkActive();
        snapshots.set(plugin.id, { isEnabled: true, configValues, lifecycleGeneration });
        return plugin.beforeTurn?.(scoped, configValues);
      });
      if (res) {
        pluginResults.set(plugin.id, res);
        if (res.extraSections && res.extraSections.length > 0) {
          for (const s of res.extraSections) {
            if (s && s.trim().length > 0) {
              extraSections.push(s.trim());
            }
          }
        }
      }
    } catch (error) {
      snapshots.set(plugin.id, { isEnabled: false });
      // 单个插件前置切面异常隔离，不影响整个回合创建（但必须留痕）
      reportPluginError(deps, plugin.id, "beforeTurn", error);
    }
  }

  return {
    extraSections,
    pluginResults,
    snapshots,
  };
}

export async function executeAfterTurnPlugins(
  registry: ServerTurnPluginRegistry,
  ctx: TurnPluginHostContext & Pick<AfterTurnContext, "status">,
  deps: TurnPluginRunnerDeps,
  pluginResults?: Map<string, BeforeTurnResult>,
  snapshots?: Map<string, PluginExecutionSnapshot>,
): Promise<void> {
  const { tenant, configRepo } = deps;

  for (const plugin of registry.getAll()) {
    if (ctx.signal?.aborted) break;
    const snapshot = snapshots?.get(plugin.id);
    // 配置保留本回合快照；启用状态必须重验，前置未准入的插件不在后置阶段新激活。
    if (snapshot && (!snapshot.isEnabled || !snapshot.lifecycleGeneration)) continue;
    try {
      await runHook(plugin.id, ctx, deps, async (scoped, checkActive) => {
        const configValues = snapshot ? snapshot.configValues
          : configRepo ? await resolvePluginConfigValues(plugin.id, configRepo, tenant).catch(() => undefined) : undefined;
        await checkActive();
        await plugin.afterTurn?.(scoped, configValues, pluginResults?.get(plugin.id));
      }, snapshot?.lifecycleGeneration);
    } catch (error) {
      // 单个插件后置切面异常隔离，不影响回合最终完成态（但必须留痕）
      reportPluginError(deps, plugin.id, "afterTurn", error);
    }
  }
}
