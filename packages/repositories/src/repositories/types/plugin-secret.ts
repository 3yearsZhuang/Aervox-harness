/**
 * Aervox｜思隅 @aervox/repositories — plugin-secret 仓储类型（自 types.ts 机械拆分）
 */
import type { TenantContext } from "../../tenant.js";

export interface IPluginSecretRepository {
  put(
    tenant: TenantContext,
    entry: { pluginId: string; fieldKey: string; value: unknown },
  ): Promise<void>;
  getState(
    tenant: TenantContext,
    pluginId: string,
    fieldKey: string,
  ): Promise<{ configured: boolean }>;
  listStates(
    tenant: TenantContext,
    pluginId: string,
  ): Promise<Array<{ fieldKey: string; configured: boolean }>>;
  delete(
    tenant: TenantContext,
    pluginId: string,
    fieldKey: string,
  ): Promise<void>;
  deleteAllForPlugin(pluginId: string): Promise<void>;
}
