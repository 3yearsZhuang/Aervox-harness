/**
 * Aervox｜思隅 @aervox/repositories — plugin-config 仓储类型（自 types.ts 机械拆分）
 */
import type { PluginConfigModel, PluginConfigSaveInput } from "./extension.js";
import type { LocalContext } from "../../local-context.js";

export interface IPluginConfigRepository {
  getConfig(
    ctx: LocalContext,
    pluginId: string,
  ): Promise<PluginConfigModel | null>;
  saveConfig(
    ctx: LocalContext,
    input: PluginConfigSaveInput,
  ): Promise<{ saved: PluginConfigModel; conflict: false } | { saved: PluginConfigModel | null; conflict: true }>;
  resetConfig(
    ctx: LocalContext,
    pluginId: string,
    schemaVersion: number,
    defaults: Record<string, unknown>,
    expectedSchema: unknown,
    expectedLifecycleGeneration: string,
    expectedRevision: number,
    /** Optional Page identity; checked with config.write before any config or Secret mutation. */
    pageExpectation?: Pick<PluginConfigSaveInput, "expectedPageId" | "expectedPageGeneration">,
  ): Promise<PluginConfigModel>;
  deleteConfigsForPlugin(pluginId: string): Promise<void>;
}
