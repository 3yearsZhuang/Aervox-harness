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
import type { AfterTurnContext, BeforeTurnResult, TurnPluginContext } from "./types.js";

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
      let isEnabled = true;
      if (extRepo) {
        const record = await extRepo.getPlugin(plugin.id).catch(() => null);
        if (record) {
          isEnabled = record.enabled === 1;
        } else if (plugin.id === "focus-mode") {
          const legacy = await extRepo.getPlugin("study-mode").catch(() => null);
          isEnabled = legacy ? legacy.enabled === 1 : false;
        } else if (plugin.id === "study-mode") {
          const modern = await extRepo.getPlugin("focus-mode").catch(() => null);
          isEnabled = modern ? modern.enabled === 1 : false;
        } else {
          isEnabled = false;
        }
      }

      let configValues: Record<string, unknown> | undefined;
      if (isEnabled && configRepo) {
        let model = await configRepo.getConfig(ctx.tenant, plugin.id).catch(() => null);
        if (!model?.valuesJson && plugin.id === "focus-mode") {
          model = await configRepo.getConfig(ctx.tenant, "study-mode").catch(() => null);
        } else if (!model?.valuesJson && plugin.id === "study-mode") {
          model = await configRepo.getConfig(ctx.tenant, "focus-mode").catch(() => null);
        }
        if (model?.valuesJson) {
          configValues =
            typeof model.valuesJson === "string"
              ? JSON.parse(model.valuesJson)
              : (model.valuesJson as Record<string, unknown>);
        }
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
        if (extRepo) {
          const record = await extRepo.getPlugin(plugin.id).catch(() => null);
          if (record) {
            isEnabled = record.enabled === 1;
          } else if (plugin.id === "focus-mode") {
            const legacy = await extRepo.getPlugin("study-mode").catch(() => null);
            isEnabled = legacy ? legacy.enabled === 1 : false;
          } else if (plugin.id === "study-mode") {
            const modern = await extRepo.getPlugin("focus-mode").catch(() => null);
            isEnabled = modern ? modern.enabled === 1 : false;
          } else {
            isEnabled = false;
          }
        }

        if (isEnabled && configRepo) {
          let model = await configRepo.getConfig(ctx.tenant, plugin.id).catch(() => null);
          if (!model?.valuesJson && plugin.id === "focus-mode") {
            model = await configRepo.getConfig(ctx.tenant, "study-mode").catch(() => null);
          } else if (!model?.valuesJson && plugin.id === "study-mode") {
            model = await configRepo.getConfig(ctx.tenant, "focus-mode").catch(() => null);
          }
          if (model?.valuesJson) {
            configValues =
              typeof model.valuesJson === "string"
                ? JSON.parse(model.valuesJson)
                : (model.valuesJson as Record<string, unknown>);
          }
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
