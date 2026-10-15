import { eq, and, notInArray } from "drizzle-orm";
import { plugins, pluginConfigs, pluginPages, toolRegistrations, skillRegistrations } from "@aervox/schema";
import type { AervoxDatabase } from "../../client.js";
import { withSessionLock } from "../../session-lock.js";
import { SqliteExtensionRepository } from "./extension-repository.js";
import { SqliteToolRegistryRepository } from "./tool-registry-repository.js";
import { SqliteSkillRegistryRepository } from "./skill-registry-repository.js";
import { SqlitePluginPageRepository } from "./plugin-config-repository.js";

export interface PluginInstallation {
  plugin: Parameters<SqliteExtensionRepository["createPlugin"]>[0];
  generation: string;
  expectedGeneration: string | null;
  expectedChecksum: string | null;
  expectedConfigRevision: number;
  expectedSchema: unknown;
  tools: Array<Parameters<SqliteToolRegistryRepository["registerTool"]>[0]>;
  skills: Array<Parameters<SqliteSkillRegistryRepository["registerSkill"]>[0]>;
  pages: Array<Parameters<SqlitePluginPageRepository["upsertPage"]>[0]>;
  config?: { expectedRevision: number; values: Record<string, unknown>; orphanedValues: Record<string, unknown> };
}

export class PluginInstallationConflictError extends Error {
  readonly code = "PLUGIN_INSTALL_CONFLICT";
  constructor(message: string) { super(message); this.name = "PluginInstallationConflictError"; }
}

/** A single SQLite commit selects already durable files. No filesystem I/O or grant/Secret writes. */
export class SqlitePluginInstallationRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async activate(input: PluginInstallation) {
    const id = input.plugin.id;
    return withSessionLock(`plugin-config:${id}`, () => this.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(plugins).where(eq(plugins.id, id));
      if ((existing?.bundleGeneration ?? null) !== input.expectedGeneration
        || (existing?.checksum ?? null) !== input.expectedChecksum) throw new PluginInstallationConflictError("Plugin changed during preparation; inspect it again");
      if (JSON.stringify(existing?.configSchemaJson ?? null) !== JSON.stringify(input.expectedSchema ?? null)) {
        throw new PluginInstallationConflictError("Configuration schema changed during preparation; inspect it again");
      }
      const [currentConfig] = await tx.select().from(pluginConfigs).where(eq(pluginConfigs.pluginId, id));
      if ((currentConfig?.revision ?? 0) !== input.expectedConfigRevision) throw new PluginInstallationConflictError("Configuration changed during preparation; inspect it again");
      const database = tx as unknown as AervoxDatabase;
      const extension = new SqliteExtensionRepository(database);
      const tools = new SqliteToolRegistryRepository(database);
      const skills = new SqliteSkillRegistryRepository(database);
      const pages = new SqlitePluginPageRepository(database);
      for (const tool of input.tools) {
        const [owner] = await tx.select().from(toolRegistrations).where(eq(toolRegistrations.id, tool.id));
        if (owner && (owner.pluginId !== id || owner.builtin === 1)) throw new Error("plugin_tool_owner_conflict");
      }
      // Do not delete/recreate the plugin: grants, revocations, Secrets and user intent survive.
      await extension.createPlugin({ ...input.plugin, enabled: existing?.enabled ?? 1 });
      await tx.update(plugins).set({ bundleGeneration: input.generation, availability: "available" }).where(eq(plugins.id, id));
      const toolIds = input.tools.map(tool => tool.id);
      await tx.delete(toolRegistrations).where(and(eq(toolRegistrations.pluginId, id),
        ...(toolIds.length ? [notInArray(toolRegistrations.id, toolIds)] : [])));
      for (const tool of input.tools) await tools.registerTool(tool);
      const skillIds = input.skills.map(skill => skill.id);
      await tx.delete(skillRegistrations).where(and(eq(skillRegistrations.pluginId, id),
        ...(skillIds.length ? [notInArray(skillRegistrations.id, skillIds)] : [])));
      for (const skill of input.skills) await skills.registerSkill(skill);
      await tx.delete(pluginPages).where(eq(pluginPages.pluginId, id));
      for (const page of input.pages) await pages.upsertPage(page);
      if (input.config) {
        const [config] = await tx.select().from(pluginConfigs).where(eq(pluginConfigs.pluginId, id));
        if (!config || config.revision !== input.config.expectedRevision) throw new PluginInstallationConflictError("Configuration changed during preparation; inspect it again");
        await tx.update(pluginConfigs).set({
          valuesJson: input.config.values, orphanedValuesJson: input.config.orphanedValues,
          revision: config.revision + 1, updatedAt: new Date().toISOString(),
        }).where(and(eq(pluginConfigs.pluginId, id), eq(pluginConfigs.revision, config.revision)));
      }
      if (existing?.enabled === 0) {
        await tools.setToolsEnabledByPlugin(id, false);
        await skills.setSkillsActiveByPlugin(id, false);
      }
      return (await extension.getPlugin(id))!;
    }));
  }
}
