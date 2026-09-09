/**
 * Aervox｜思隅 @aervox/api — 内置插件升级数据迁移（Issue 1）
 *
 * 显式迁移：
 * aervox-study-companion -> study-mode
 * aervox-term-explorer   -> study-mode
 * 迁移配置、secret、启用状态、技能归属和必要授权，成功后再清理旧 ID。
 */
import { inArray, eq, and } from "drizzle-orm";
import type { AervoxDatabase } from "@aervox/database";
import {
  plugins,
  pluginConfigs,
  pluginConfigSecrets,
  pluginGrants,
  skillRegistrations,
  toolRegistrations,
} from "@aervox/database";

const OLD_PLUGIN_IDS: string[] = ["aervox-study-companion", "aervox-term-explorer"];
const TARGET_PLUGIN_ID = "study-mode";

export async function migrateStudyPlugins(db: AervoxDatabase): Promise<void> {
  const oldPlugins = await db
    .select()
    .from(plugins)
    .where(inArray(plugins.id, OLD_PLUGIN_IDS));

  if (oldPlugins.length === 0) {
    return;
  }

  const now = new Date().toISOString();

  // 1. 迁移启停状态：若任一旧插件曾被用户明确停用（enabled === 0），则新插件初始化为停用
  const shouldBeDisabled = oldPlugins.some((p) => p.enabled === 0);
  const [existingTarget] = await db
    .select()
    .from(plugins)
    .where(eq(plugins.id, TARGET_PLUGIN_ID));

  if (existingTarget) {
    if (shouldBeDisabled && existingTarget.enabled !== 0) {
      await db
        .update(plugins)
        .set({ enabled: 0, updatedAt: now })
        .where(eq(plugins.id, TARGET_PLUGIN_ID));
    }
  } else {
    // 预先占位创建 target 插件，确保启停状态被继承
    await db.insert(plugins).values({
      id: TARGET_PLUGIN_ID,
      publisher: "aervox-official",
      version: "1.0.0",
      checksum: "migrated",
      installSource: "builtin",
      enabled: shouldBeDisabled ? 0 : 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  // 2. 迁移并聚合租户配置 (plugin_configs)
  const oldConfigs = await db
    .select()
    .from(pluginConfigs)
    .where(inArray(pluginConfigs.pluginId, OLD_PLUGIN_IDS));

  // 按 (workspaceId, subjectUserId) 聚合并合并
  const configsByTenant = new Map<
    string,
    {
      workspaceId: string;
      subjectUserId: string;
      values: Record<string, unknown>;
      secretKeys: Set<string>;
    }
  >();

  for (const row of oldConfigs) {
    const key = `${row.workspaceId}:${row.subjectUserId}`;
    let item = configsByTenant.get(key);
    if (!item) {
      item = {
        workspaceId: row.workspaceId,
        subjectUserId: row.subjectUserId,
        values: {},
        secretKeys: new Set<string>(),
      };
      configsByTenant.set(key, item);
    }
    const rawValues = row.valuesJson as unknown;
    if (typeof rawValues === "string") {
      try {
        const parsed = JSON.parse(rawValues) as Record<string, unknown>;
        Object.assign(item.values, parsed);
      } catch {
        // 忽略非法 json
      }
    } else if (rawValues && typeof rawValues === "object") {
      Object.assign(item.values, rawValues as Record<string, unknown>);
    }

    const rawSecrets = row.secretKeysJson as unknown;
    if (typeof rawSecrets === "string") {
      try {
        const secrets = JSON.parse(rawSecrets) as string[];
        if (Array.isArray(secrets)) {
          for (const s of secrets) item.secretKeys.add(s);
        }
      } catch {
        // 忽略
      }
    } else if (Array.isArray(rawSecrets)) {
      for (const s of rawSecrets) item.secretKeys.add(s);
    }
  }

  for (const { workspaceId, subjectUserId, values, secretKeys } of configsByTenant.values()) {
    const [existingConfig] = await db
      .select()
      .from(pluginConfigs)
      .where(
        and(
          eq(pluginConfigs.workspaceId, workspaceId),
          eq(pluginConfigs.subjectUserId, subjectUserId),
          eq(pluginConfigs.pluginId, TARGET_PLUGIN_ID),
        ),
      );

    if (existingConfig) {
      let targetValues: Record<string, unknown> = {};
      const rawTargetValues = existingConfig.valuesJson as unknown;
      if (typeof rawTargetValues === "string") {
        try {
          targetValues = JSON.parse(rawTargetValues);
        } catch {
          targetValues = {};
        }
      } else if (rawTargetValues && typeof rawTargetValues === "object") {
        targetValues = rawTargetValues as Record<string, unknown>;
      }
      // 深度补齐旧配置，不覆盖新插件已有配置
      const mergedValues = { ...values, ...targetValues };
      let targetSecrets: string[] = [];
      const rawTargetSecrets = existingConfig.secretKeysJson as unknown;
      if (typeof rawTargetSecrets === "string") {
        try {
          targetSecrets = JSON.parse(rawTargetSecrets);
        } catch {
          targetSecrets = [];
        }
      } else if (Array.isArray(rawTargetSecrets)) {
        targetSecrets = rawTargetSecrets as string[];
      }
      const mergedSecrets = Array.from(new Set([...secretKeys, ...targetSecrets]));

      await db
        .update(pluginConfigs)
        .set({
          valuesJson: mergedValues as any,
          secretKeysJson: mergedSecrets as any,
          updatedAt: now,
        })
        .where(eq(pluginConfigs.id, existingConfig.id));
    } else {
      const id = `pcfg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      await db.insert(pluginConfigs).values({
        id,
        workspaceId,
        subjectUserId,
        pluginId: TARGET_PLUGIN_ID,
        valuesJson: values as any,
        secretKeysJson: Array.from(secretKeys) as any,
        schemaVersion: 1,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  // 3. 迁移配置 Secret (plugin_config_secrets)
  const oldSecrets = await db
    .select()
    .from(pluginConfigSecrets)
    .where(inArray(pluginConfigSecrets.pluginId, OLD_PLUGIN_IDS));

  for (const sec of oldSecrets) {
    const [existingSec] = await db
      .select()
      .from(pluginConfigSecrets)
      .where(
        and(
          eq(pluginConfigSecrets.workspaceId, sec.workspaceId),
          eq(pluginConfigSecrets.subjectUserId, sec.subjectUserId),
          eq(pluginConfigSecrets.pluginId, TARGET_PLUGIN_ID),
          eq(pluginConfigSecrets.fieldKey, sec.fieldKey),
        ),
      );
    if (!existingSec) {
      await db
        .update(pluginConfigSecrets)
        .set({ pluginId: TARGET_PLUGIN_ID, updatedAt: now })
        .where(eq(pluginConfigSecrets.id, sec.id));
    } else {
      await db
        .delete(pluginConfigSecrets)
        .where(eq(pluginConfigSecrets.id, sec.id));
    }
  }

  // 4. 迁移授权数据 (plugin_grants)
  const oldGrants = await db
    .select()
    .from(pluginGrants)
    .where(inArray(pluginGrants.pluginId, OLD_PLUGIN_IDS));

  for (const grant of oldGrants) {
    const [existingGrant] = await db
      .select()
      .from(pluginGrants)
      .where(
        and(
          eq(pluginGrants.workspaceId, grant.workspaceId),
          eq(pluginGrants.subjectUserId, grant.subjectUserId),
          eq(pluginGrants.pluginId, TARGET_PLUGIN_ID),
          eq(pluginGrants.permission, grant.permission),
        ),
      );
    if (!existingGrant) {
      await db
        .update(pluginGrants)
        .set({ pluginId: TARGET_PLUGIN_ID, updatedAt: now })
        .where(eq(pluginGrants.id, grant.id));
    } else {
      await db.delete(pluginGrants).where(eq(pluginGrants.id, grant.id));
    }
  }

  // 5. 迁移技能和工具注册
  await db
    .update(skillRegistrations)
    .set({ pluginId: TARGET_PLUGIN_ID })
    .where(inArray(skillRegistrations.pluginId, OLD_PLUGIN_IDS));

  await db
    .update(toolRegistrations)
    .set({ pluginId: TARGET_PLUGIN_ID })
    .where(inArray(toolRegistrations.pluginId, OLD_PLUGIN_IDS));

  // 6. 清理旧插件记录（至此已迁移完成）
  await db.delete(pluginConfigs).where(inArray(pluginConfigs.pluginId, OLD_PLUGIN_IDS));
  await db.delete(pluginConfigSecrets).where(inArray(pluginConfigSecrets.pluginId, OLD_PLUGIN_IDS));
  await db.delete(pluginGrants).where(inArray(pluginGrants.pluginId, OLD_PLUGIN_IDS));
  await db.delete(plugins).where(inArray(plugins.id, OLD_PLUGIN_IDS));
}
