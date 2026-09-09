/**
 * Aervox｜思隅 @aervox/repositories — plugin-config 仓储类型（自 types.ts 机械拆分）
 */
import type { PluginConfigModel, PluginConfigSaveInput } from "./extension.js";
import type { TenantContext } from "../../tenant.js";

export interface IPluginConfigRepository {
  getConfig(
    tenant: TenantContext,
    pluginId: string,
  ): Promise<PluginConfigModel | null>;
  saveConfig(
    tenant: TenantContext,
    input: PluginConfigSaveInput,
  ): Promise<{ saved: PluginConfigModel; conflict: boolean }>;
  resetConfig(
    tenant: TenantContext,
    pluginId: string,
    schemaVersion: number,
    defaults: Record<string, unknown>,
  ): Promise<PluginConfigModel>;
  deleteConfigsForPlugin(pluginId: string): Promise<void>;
}
