<script setup lang="ts">
import {ElMessage} from '@aervox/ui/utils/element'
import {Puzzle} from 'lucide-vue-next'
import {useAervoxPlugins, type PluginSummaryDto} from '@aervox/api-client'
import {AervoxDialog, AervoxButton} from '@aervox/ui/primitives'
import PluginConfigForm from './PluginConfigForm.vue'
import {usePluginConfigEditor} from './use-plugin-config-editor'

const props = defineProps<{
  open: boolean
  plugin: PluginSummaryDto | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'saved'): void
}>()

const api = useAervoxPlugins()
const {fields, values, secretFields, secretValues, revision, loading, saving, ready, error, issues, save, reset, updateValue, updateSecret} = usePluginConfigEditor({
  owner: () => ({open: props.open, pluginId: props.plugin?.id, hasConfig: Boolean(props.plugin?.configSchemaJson)}),
  api,
  onSaved(reset) { ElMessage.success(reset ? '已恢复默认配置' : '配置已保存'); emit('saved') },
  onError(message, loading) { ElMessage.error(message); if (loading) emit('close') },
})
</script>

<template>
  <AervoxDialog
    :model-value="open"
    :title="`${plugin?.id ?? ''} 配置`"
    subtitle="管理插件运行参数与密钥"
    :icon="Puzzle"
    size="md"
    @close="emit('close')"
  >
    <p v-if="error" role="alert">{{ error }}</p>
    <div v-if="loading" class="pcfg-loading">加载配置…</div>
    <div v-else-if="issues.length > 0" class="pcfg-issues">
      <p v-for="issue in issues" :key="issue.key" class="pcfg-issue">{{ issue.key }}: {{ issue.message }}</p>
    </div>
    <PluginConfigForm
      v-else
      :fields="fields"
      :values="values"
      :secret-fields="secretFields"
      :secret-values="secretValues"
      @update-value="updateValue"
      @update-secret="updateSecret"
    />
    <template #footer>
      <AervoxButton variant="secondary" :disabled="saving || !ready" @click="reset">恢复默认</AervoxButton>
      <AervoxButton variant="secondary" @click="emit('close')">取消</AervoxButton>
      <AervoxButton variant="primary" :loading="saving" :disabled="!ready || loading" @click="save">保存</AervoxButton>
    </template>
  </AervoxDialog>
</template>

<style scoped>
.pcfg-loading { padding: 30px 0; text-align: center; color: var(--text-muted); font-size: 12px; }
.pcfg-issues {
  padding: 16px;
  border-radius: 10px;
  background: var(--danger-soft);
  animation: pcfg-fade-in 0.2s ease-out;
}
.pcfg-issue { margin: 0 0 6px; color: var(--danger); font-size: 11px; }

@keyframes pcfg-fade-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>

