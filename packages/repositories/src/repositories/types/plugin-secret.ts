/**
 * Aervox｜思隅 @aervox/repositories — plugin-secret 仓储类型（自 types.ts 机械拆分）
 */
import type { LocalContext } from "../../local-context.js";

export interface IPluginSecretRepository {
  put(
    ctx: LocalContext,
    entry: { pluginId: string; fieldKey: string; value: unknown },
  ): Promise<void>;
  getState(
    ctx: LocalContext,
    pluginId: string,
    fieldKey: string,
  ): Promise<{ configured: boolean }>;
  listStates(
    ctx: LocalContext,
    pluginId: string,
  ): Promise<Array<{ fieldKey: string; configured: boolean }>>;
  delete(
    ctx: LocalContext,
    pluginId: string,
    fieldKey: string,
  ): Promise<void>;
  deleteAllForPlugin(pluginId: string): Promise<void>;
}
