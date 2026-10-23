/** All plugin-owned durable writes revalidate the captured lifecycle identity under the writer transaction. */
import { eq } from "drizzle-orm";
import { plugins } from "@aervox/schema";
import type { AervoxDatabase } from "./client.js";
export interface PluginGenerationIdentity { pluginId: string; generation: string }
export async function assertPluginGeneration(database: Pick<AervoxDatabase, "select">, identity?: PluginGenerationIdentity): Promise<void> {
  if (!identity) return;
  const [plugin] = await database.select({ enabled: plugins.enabled, availability: plugins.availability, generation: plugins.lifecycleGeneration })
    .from(plugins).where(eq(plugins.id, identity.pluginId));
  if (!plugin || plugin.enabled !== 1 || plugin.availability !== "available" || plugin.generation !== identity.generation) throw new Error("plugin_generation_changed");
}
