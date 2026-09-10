/**
 * Aervox｜思隅 @aervox/repositories — plugin-secret 仓储类型（自 types.ts 机械拆分）
 */
import type { LocalContext } from "../../local-context.js";

export interface IPluginSecretRepository {
  put(
    tenant: LocalContext,
    entry: { pluginId: string; fieldKey: string; value: unknown },
  ): Promise<void>;
  getState(
    tenant: LocalContext,
    pluginId: string,
    fieldKey: string,
  ): Promise<{ configured: boolean }>;
  listStates(
    tenant: LocalContext,
    pluginId: string,
  ): Promise<Array<{ fieldKey: string; configured: boolean }>>;
  delete(
    tenant: LocalContext,
    pluginId: string,
    fieldKey: string,
  ): Promise<void>;
  deleteAllForPlugin(pluginId: string): Promise<void>;
}
