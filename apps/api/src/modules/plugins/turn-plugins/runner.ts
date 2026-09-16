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
import type { AfterTurnContext, BeforeTurnResult, ServerTurnPlugin, TurnPluginContext } from "./types.js";

export interface PluginExecutionSnapshot {
  isEnabled: boolean;
  configValues?: Record<string, unknown>;
}

export interface BeforeTurnExecutionResult {
  extraSections: string[];
  allowQuizTrigger: boolean;
  quizMode: boolean;
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
      return record.enabled === 1;
    }
  }
  return false;
}

/**
 * 通用解析插件配置值（按主 ID 与声明别名依次探测）
 */
async function resolvePluginConfigValues(
  candidateIds: string[],
  configRepo: IPluginConfigRepository,
  tenant: TurnPluginContext["tenant"],
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

export async function executeBeforeTurnPlugins(
  registry: ServerTurnPluginRegistry,
  ctx: TurnPluginContext,
  extRepo?: IExtensionRepository | null,
  configRepo?: IPluginConfigRepository | null,
): Promise<BeforeTurnExecutionResult> {
  const extraSections: string[] = [];
  let allowQuizTrigger = false;
  let quizMode = false;
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
        configValues = await resolvePluginConfigValues(candidateIds, configRepo, ctx.tenant);
      }

      snapshots.set(plugin.id, { isEnabled, configValues });

      if (!isEnabled) {
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
        if (res.allowQuizTrigger) {
          allowQuizTrigger = true;
        }
        if (res.quizMode) {
          quizMode = true;
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
    allowQuizTrigger,
    quizMode,
    pluginResults,
    snapshots,
  };
}

export async function executeAfterTurnPlugins(
  registry: ServerTurnPluginRegistry,
  ctx: AfterTurnContext,
  extRepo?: IExtensionRepository | null,
  configRepo?: IPluginConfigRepository | null,
  pluginResults?: Map<string, BeforeTurnResult>,
  snapshots?: Map<string, PluginExecutionSnapshot>,
): Promise<void> {
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
          configValues = await resolvePluginConfigValues(candidateIds, configRepo, ctx.tenant);
        }
      }

      if (!isEnabled) {
        continue;
      }

      await plugin.afterTurn?.(ctx, configValues, pluginResults?.get(plugin.id));
    } catch {
      // 单个插件后置切面异常隔离，不影响回合最终完成态
    }
  }
}
