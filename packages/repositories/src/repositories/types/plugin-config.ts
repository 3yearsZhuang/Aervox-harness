/**
 * Aervox｜思隅 @aervox/repositories — plugin-config 仓储类型（自 types.ts 机械拆分）
 */
import type { PluginConfigModel, PluginConfigSaveInput } from "./extension.js";
import type { LocalContext } from "../../local-context.js";
import type { PluginConfigAccessQuery, PluginConfigSchemaResponse } from "@aervox/contracts";

export interface IPluginConfigRepository {
  getConfig(
    ctx: LocalContext,
    pluginId: string,
    access?: PluginConfigAccessQuery,
    expectedSchema?: PluginConfigSchemaResponse,
  ): Promise<PluginConfigModel | null>;
  /** Revalidate a Page response after asynchronous work without loading configuration values again. */
  assertPageConfigAccess(
    pluginId: string,
    access: PluginConfigAccessQuery,
    expectedSchema?: PluginConfigSchemaResponse,
  ): Promise<void>;
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
    pageIdentity?: Pick<PluginConfigAccessQuery, "expectedPageId" | "expectedPageGeneration">,
  ): Promise<PluginConfigModel>;
  deleteConfigsForPlugin(pluginId: string): Promise<void>;
}
