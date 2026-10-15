/**
 * Aervox｜思隅 @aervox/api — 服务端会话回合插件执行编排器 (Server Turn Plugin Runner)
 *
 * 统一负责：
 * 1. 插件启用状态门控检查（通过 IExtensionRepository.getPlugin(id).enabled === 1）；
 * 2. 插件配置动态拉取（通过 IPluginConfigRepository.getConfig(tenant, id)）；
 * 3. 编排并收集各插件的 beforeTurn 提示词与状态标记；
 * 4. 在回合结束后分发 afterTurn 执行增强后处理。
 */
import type { IExtensionRepository, IPluginConfigRepository } from "@aervox/repositories";
import type { ServerTurnPluginRegistry } from "./registry.js";
import type { LocalContext } from "@aervox/repositories";
import type { AfterTurnContext, BeforeTurnResult, TurnPluginContext } from "./types.js";

export interface PluginExecutionSnapshot {
  isEnabled: boolean;
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
async function resolvePluginEnabled(
  pluginId: string,
  extRepo?: IExtensionRepository | null,
): Promise<boolean> {
  if (!extRepo) return false;
  const record = await extRepo.getPlugin(pluginId).catch(() => null);
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
  /**
   * 单个插件切面异常的上报出口。缺省落到 `console.warn`——切面异常必须留痕，
   * 不得静默吞掉（否则插件失效在生产中不可观测）。
   */
  onPluginError?: (pluginId: string, phase: "beforeTurn" | "afterTurn", error: unknown) => void;
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
  ctx: TurnPluginContext,
  deps: TurnPluginRunnerDeps,
): Promise<BeforeTurnExecutionResult> {
  const { tenant, extRepo, configRepo } = deps;
  const extraSections: string[] = [];
  const pluginResults = new Map<string, BeforeTurnResult>();
  const snapshots = new Map<string, PluginExecutionSnapshot>();

  for (const plugin of registry.getAll()) {
    // 门控与工具贡献、插件端点同一判据：仓储缺失/缺记录/未启用/不可用一律不执行（fail-closed）
    const isEnabled = await resolvePluginEnabled(plugin.id, extRepo);

    let configValues: Record<string, unknown> | undefined;
    if (isEnabled && configRepo) {
      configValues = await resolvePluginConfigValues(plugin.id, configRepo, tenant).catch(() => undefined);
    }

    snapshots.set(plugin.id, { isEnabled, configValues });
    if (!isEnabled) continue;

    try {
      const res = await plugin.beforeTurn?.(ctx, configValues);
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
  ctx: AfterTurnContext,
  deps: TurnPluginRunnerDeps,
  pluginResults?: Map<string, BeforeTurnResult>,
  snapshots?: Map<string, PluginExecutionSnapshot>,
): Promise<void> {
  const { tenant, extRepo, configRepo } = deps;

  for (const plugin of registry.getAll()) {
    let isEnabled: boolean;
    let configValues: Record<string, unknown> | undefined;

    if (snapshots?.has(plugin.id)) {
      // 复用前置切面快照：同一回合内启停与配置判定保持一致，避免重复读库
      const snap = snapshots.get(plugin.id)!;
      isEnabled = snap.isEnabled;
      configValues = snap.configValues;
    } else {
      isEnabled = await resolvePluginEnabled(plugin.id, extRepo);
      if (isEnabled && configRepo) {
        configValues = await resolvePluginConfigValues(plugin.id, configRepo, tenant).catch(() => undefined);
      }
    }

    if (!isEnabled) continue;

    try {
      await plugin.afterTurn?.(ctx, configValues, pluginResults?.get(plugin.id));
    } catch (error) {
      // 单个插件后置切面异常隔离，不影响回合最终完成态（但必须留痕）
      reportPluginError(deps, plugin.id, "afterTurn", error);
    }
  }
}
