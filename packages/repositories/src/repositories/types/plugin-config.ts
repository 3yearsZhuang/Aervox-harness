/**
 * Aervox｜思隅 @aervox/repositories — plugin-config 仓储类型（自 types.ts 机械拆分）
 */
import type { PluginConfigModel, PluginConfigSaveInput } from "./extension.js";
import type { LocalContext } from "../../local-context.js";

export interface IPluginConfigRepository {
  getConfig(
    tenant: LocalContext,
    pluginId: string,
  ): Promise<PluginConfigModel | null>;
  saveConfig(
    tenant: LocalContext,
    input: PluginConfigSaveInput,
  ): Promise<{ saved: PluginConfigModel; conflict: boolean }>;
  resetConfig(
    tenant: LocalContext,
    pluginId: string,
    schemaVersion: number,
    defaults: Record<string, unknown>,
  ): Promise<PluginConfigModel>;
  deleteConfigsForPlugin(pluginId: string): Promise<void>;
}
