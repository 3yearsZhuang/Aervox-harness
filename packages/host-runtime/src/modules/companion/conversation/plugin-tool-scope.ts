import type { IExtensionRepository } from "@aervox/repositories";
import type { PluginHostServiceControl } from "../../../plugin-host-services.js";

/** A tool declaration belongs to one enabled lifecycle generation, including its writes. */
export function createPluginToolScope(
  repo: Pick<IExtensionRepository, "getPlugin">, pluginId: string, generation: string, parent?: AbortSignal,
): PluginHostServiceControl & { active(): Promise<boolean>; dispose(): void } {
  const controller = new AbortController();
  const abortParent = () => controller.abort(parent?.reason ?? new Error("turn_cancelled"));
  parent?.addEventListener("abort", abortParent, { once: true });
  if (parent?.aborted) abortParent();
  let checking = false;
  let disposed = false;
  const checkActive = async () => {
    controller.signal.throwIfAborted();
    const plugin = await repo.getPlugin(pluginId);
    if (disposed || !plugin || plugin.enabled !== 1 || (plugin.availability ?? "available") !== "available"
      || plugin.lifecycleGeneration !== generation) controller.abort(new Error("plugin_generation_changed"));
    controller.signal.throwIfAborted();
  };
  const timer = setInterval(() => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    void checkActive().catch(error => controller.abort(error)).finally(() => { checking = false; });
  }, 50);
  timer.unref();
  return {
    signal: controller.signal, checkActive, pluginGeneration: { pluginId, generation },
    async active() { try { await checkActive(); return true; } catch { return false; } },
    dispose() {
      disposed = true; clearInterval(timer); parent?.removeEventListener("abort", abortParent);
      controller.abort(new Error("plugin_tool_scope_finished"));
    },
  };
}
