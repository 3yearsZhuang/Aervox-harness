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
import type { AfterTurnContext, BeforeTurnResult, ServerTurnPlugin, TurnPluginContext } from "./types.js";

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
 * 通用获取插件的所有候选别名（优先主 ID，随后别名）
 */
function getPluginCandidateIds(plugin: ServerTurnPlugin, registry?: ServerTurnPluginRegistry): string[] {
  if (registry && typeof registry.getAllAliases === "function") {
    return registry.getAllAliases(plugin.id);
  }
  const aliases: string[] = plugin.aliases ?? [];
  return [plugin.id, ...aliases.filter((a: string) => a !== plugin.id)];
}

/**
 * 通用解析插件在仓储中的启用状态（按主 ID 与声明别名依次探测）
 */
async function resolvePluginEnabled(
  candidateIds: string[],
  extRepo: IExtensionRepository,
): Promise<boolean> {
  for (const id of candidateIds) {
    const record = await extRepo.getPlugin(id).catch(() => null);
    if (record) {
      return record.enabled === 1 && (record.availability ?? "available") === "available";
    }
  }
  return false;
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
  if (!extRepo) return false;
  return resolvePluginEnabled([pluginId], extRepo);
}

/**
 * 通用解析插件配置值（按主 ID 与声明别名依次探测）
 */
async function resolvePluginConfigValues(
  candidateIds: string[],
  configRepo: IPluginConfigRepository,
  tenant: LocalContext,
): Promise<Record<string, unknown> | undefined> {
  for (const id of candidateIds) {
    const model = await configRepo.getConfig(tenant, id).catch(() => null);
    if (model?.valuesJson) {
      return typeof model.valuesJson === "string"
        ? JSON.parse(model.valuesJson)
        : (model.valuesJson as Record<string, unknown>);
    }
  }
  return undefined;
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
    try {
      const candidateIds = getPluginCandidateIds(plugin, registry);
      let isEnabled = true;
      if (extRepo) {
        isEnabled = await resolvePluginEnabled(candidateIds, extRepo);
      }

      let configValues: Record<string, unknown> | undefined;
      if (isEnabled && configRepo) {
        configValues = await resolvePluginConfigValues(candidateIds, configRepo, tenant);
      }

      snapshots.set(plugin.id, { isEnabled, configValues });

      if (!isEnabled || (extRepo && !await resolvePluginEnabled(getPluginCandidateIds(plugin, registry), extRepo))) {
        continue;
      }

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
    } catch {
      // 单个插件前置切面异常隔离，不影响整个回合创建
    }
  }

  // 将快照挂载至 pluginResults 保证多版本调用零改动兼容
  (pluginResults as unknown as { __snapshots?: Map<string, PluginExecutionSnapshot> }).__snapshots = snapshots;

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
  const effectiveSnapshots =
    snapshots ??
    (pluginResults as unknown as { __snapshots?: Map<string, PluginExecutionSnapshot> })?.__snapshots;

  for (const plugin of registry.getAll()) {
    try {
      let isEnabled = true;
      let configValues: Record<string, unknown> | undefined;

      if (effectiveSnapshots?.has(plugin.id)) {
        const snap = effectiveSnapshots.get(plugin.id)!;
        isEnabled = snap.isEnabled;
        configValues = snap.configValues;
      } else {
        const candidateIds = getPluginCandidateIds(plugin, registry);
        if (extRepo) {
          isEnabled = await resolvePluginEnabled(candidateIds, extRepo);
        }

        if (isEnabled && configRepo) {
          configValues = await resolvePluginConfigValues(candidateIds, configRepo, tenant);
        }
      }

      if (!isEnabled || (extRepo && !await resolvePluginEnabled(getPluginCandidateIds(plugin, registry), extRepo))) {
        continue;
      }

      await plugin.afterTurn?.(ctx, configValues, pluginResults?.get(plugin.id));
    } catch {
      // 单个插件后置切面异常隔离，不影响回合最终完成态
    }
  }
}
