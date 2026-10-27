import { computed, onScopeDispose, ref, watch } from 'vue';
import type { PluginConfigField, PluginConfigSnapshot } from '@aervox/contracts';
import { aervoxConfirm } from '@aervox/ui/primitives';
import { useDialogPrompts, useMaterial3 } from '@aervox/ui/material3';
import type { useAervoxPlugins } from '@aervox/api-client';

/** Configuration drafts, revisions and secrets belong to one open plugin generation. */
export function usePluginConfigEditor(options: {
  owner: () => { open: boolean; pluginId?: string; hasConfig: boolean };
  api: Pick<ReturnType<typeof useAervoxPlugins>, 'getConfigSchema' | 'getConfig' | 'saveConfig' | 'resetConfig'>;
  onSaved: (reset: boolean) => void;
  onError: (message: string, loading: boolean) => void;
}) {
  const material3 = useMaterial3();
  const dialogPrompts = useDialogPrompts(undefined, computed(() => options.owner().open));
  const fields = ref<PluginConfigField[]>([]);
  const values = ref<Record<string, unknown>>({});
  const secretFields = ref<Record<string, { configured: boolean }>>({});
  const secretValues = ref<Record<string, string | null>>({});
  const revision = ref(0);
  const loading = ref(false);
  const saving = ref(false);
  const ready = ref(false);
  const error = ref<string | null>(null);
  const issues = ref<Array<{ key: string; code: string; message: string }>>([]);
  let generation = 0;
  const current = (owner: { generation: number; pluginId: string }) => {
    const state = options.owner();
    return generation === owner.generation && state.open && state.pluginId === owner.pluginId;
  };
  const snapshot = (data: PluginConfigSnapshot) => {
    revision.value = data.revision;
    values.value = data.values ?? {};
    secretFields.value = data.secretFields ?? {};
    secretValues.value = {};
  };
  const clear = () => {
    fields.value = []; values.value = {}; secretFields.value = {}; secretValues.value = {};
    revision.value = 0; loading.value = false; saving.value = false; ready.value = false;
    issues.value = []; error.value = null;
  };
  watch(() => { const owner = options.owner(); return [owner.open, owner.pluginId, owner.hasConfig] as const; },
    async ([open, pluginId, hasConfig], _, onCleanup) => {
      const owner = {generation: ++generation, pluginId: pluginId ?? ''};
      clear();
      onCleanup(() => { ++generation; clear(); });
      if (!open || !pluginId || !hasConfig) return;
      loading.value = true;
      try {
        const [schema, config] = await Promise.all([options.api.getConfigSchema(pluginId), options.api.getConfig(pluginId)]);
        if (!current(owner)) return;
        fields.value = schema.fields;
        snapshot(config); ready.value = true;
      } catch (cause) {
        if (current(owner)) {
          error.value = cause instanceof Error ? cause.message : '读取插件配置失败';
          options.onError(error.value, true);
        }
      } finally { if (current(owner)) loading.value = false; }
    }, {immediate: true});
  onScopeDispose(() => { ++generation; clear(); });

  const capture = () => {
    const state = options.owner();
    return state.open && state.pluginId && ready.value && !loading.value && !saving.value
      ? {generation, pluginId: state.pluginId} : undefined;
  };
  const fail = (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : '保存失败';
    error.value = message.includes('REVISION_CONFLICT') || message.includes('409')
      ? '配置已被其他设备修改，请重新打开后重试' : message;
    options.onError(error.value, false);
  };
  async function save(): Promise<void> {
    const owner = capture(); if (!owner) return;
    // Send a plain snapshot: edits made during the write cannot alter its payload.
    const input = structuredClone({revision: revision.value, values: JSON.parse(JSON.stringify(values.value)) as Record<string, unknown>, secretValues: {...secretValues.value}});
    saving.value = true; issues.value = []; error.value = null;
    try {
      const result = await options.api.saveConfig(owner.pluginId, input);
      if (current(owner)) { snapshot(result); options.onSaved(false); }
    } catch (cause) { if (current(owner)) fail(cause); }
    finally { if (current(owner)) saving.value = false; }
  }
  async function reset(): Promise<void> {
    const owner = capture(); if (!owner) return;
    const title = '恢复默认配置？';
    const message = '恢复默认值将清空全部插件配置（含密钥），确定继续吗？';
    const confirmed = material3
      ? await dialogPrompts.confirm(message, title, {type: 'warning', confirmButtonText: '恢复默认', closeOnClickModal: false}).then(() => true, () => false)
      : await aervoxConfirm({title, message, variant: 'danger', confirmText: '恢复默认'});
    if (!confirmed || !current(owner) || saving.value) return;
    saving.value = true; error.value = null;
    try {
      const result = await options.api.resetConfig(owner.pluginId);
      if (current(owner)) { snapshot(result); options.onSaved(true); }
    } catch (cause) { if (current(owner)) fail(cause); }
    finally { if (current(owner)) saving.value = false; }
  }
  return {fields, values, secretFields, secretValues, revision, loading, saving, ready, error, issues, save, reset,
    updateValue(key: string, value: unknown) { values.value = {...values.value, [key]: value}; },
    updateSecret(key: string, value: string | null) { secretValues.value = {...secretValues.value, [key]: value}; },
  };
}
