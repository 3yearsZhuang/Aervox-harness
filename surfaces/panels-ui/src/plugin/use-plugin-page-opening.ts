import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { pluginPageGenerationSchema } from '@aervox/contracts';
import type { PluginPageDto, PluginSummaryDto, useAervoxPlugins } from '@aervox/api-client';

type PluginPageOpeningApi = Pick<ReturnType<typeof useAervoxPlugins>, 'plugins' | 'error' | 'loadPlugins' | 'listPages'>;

/** Explicit opens acquire fresh identities; stale responses cannot revive a closed owner. */
export function usePluginPageOpening(options: {
  api: PluginPageOpeningApi;
  owner?: () => string | null;
  onError(message: string): void;
}) {
  const open = ref(false);
  const targetPlugin = ref<PluginSummaryDto | null>(null);
  const targetPage = ref<PluginPageDto | null>(null);
  const busy = ref<string | null>(null);
  let attempt = 0;
  let controller: AbortController | undefined;

  function close(): void {
    ++attempt;
    controller?.abort();
    controller = undefined;
    open.value = false;
    busy.value = null;
  }

  async function select(pluginId: string, pageId?: string): Promise<void> {
    const owner = options.owner?.();
    if (owner === null) return;
    const currentAttempt = ++attempt;
    controller?.abort();
    const current = new AbortController();
    controller = current;
    const owns = () => attempt === currentAttempt && !current.signal.aborted && options.owner?.() === owner;
    open.value = false;
    busy.value = pluginId;
    try {
      // Flush the old dialog's close before any asynchronous identity lookup.
      await nextTick();
      if (!owns()) return;
      await options.api.loadPlugins();
      if (!owns()) return;
      if (options.api.error.value) throw new Error('plugin_list_unavailable');
      const plugin = options.api.plugins.value.find(candidate => candidate.id === pluginId);
      if (!plugin || plugin.enabled !== 1 || plugin.availability !== 'available'
        || !pluginPageGenerationSchema.safeParse(plugin.lifecycleGeneration).success) throw new Error('plugin_unavailable');
      const pages = await options.api.listPages(plugin.id, plugin.lifecycleGeneration, current.signal);
      if (!owns()) return;
      const page = pageId === undefined ? pages[0] : pages.find(candidate => candidate.id === pageId);
      if (!page || !pluginPageGenerationSchema.safeParse(page.pageGeneration).success) throw new Error('page_unavailable');
      targetPlugin.value = plugin;
      targetPage.value = page;
      open.value = true;
    } catch {
      if (owns()) options.onError('无法打开插件页面，请刷新后重试。');
    } finally {
      if (owns()) busy.value = null;
    }
  }

  function refresh(): void {
    if (targetPlugin.value && targetPage.value) void select(targetPlugin.value.id, targetPage.value.id);
  }

  if (options.owner) watch(options.owner, close, { flush: 'sync' });
  onBeforeUnmount(close);
  return { open, targetPlugin, targetPage, busy, select, refresh, close };
}
