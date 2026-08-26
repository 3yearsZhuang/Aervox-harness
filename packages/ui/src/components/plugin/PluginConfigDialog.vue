<script setup lang="ts">
import {ref, watch} from 'vue'
import {ElMessage} from 'element-plus'
import type {PluginConfigField} from '@aervox/contracts'
import {useAervoxPlugins, type PluginSummaryDto} from '@aervox/api-client'
import PluginConfigForm from './PluginConfigForm.vue'

const props = defineProps<{
  open: boolean
  plugin: PluginSummaryDto | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'saved'): void
}>()

const api = useAervoxPlugins()
const fields = ref<PluginConfigField[]>([])
const values = ref<Record<string, unknown>>({})
const secretFields = ref<Record<string, {configured: boolean}>>({})
const secretValues = ref<Record<string, string | null>>({})
const revision = ref(0)
const loading = ref(false)
const saving = ref(false)
const issues = ref<Array<{key: string; code: string; message: string}>>([])

watch(
  () => props.open,
  async (open) => {
    if (!open || !props.plugin) return
    issues.value = []
    loading.value = true
    try {
      const [schema, config] = await Promise.all([
        api.getConfigSchema(props.plugin.id),
        api.getConfig(props.plugin.id),
      ])
      fields.value = schema.fields
      values.value = config.values ?? {}
      secretFields.value = config.secretFields ?? {}
      secretValues.value = {}
      revision.value = config.revision ?? 0
    } catch (e) {
      ElMessage.error(e instanceof Error ? e.message : '读取插件配置失败')
      emit('close')
    } finally {
      loading.value = false
    }
  },
)

function updateValue(key: string, value: unknown): void {
  values.value = {...values.value, [key]: value}
}

function updateSecret(key: string, value: string | null): void {
  secretValues.value = {...secretValues.value, [key]: value}
}

async function save(): Promise<void> {
  if (!props.plugin) return
  saving.value = true
  issues.value = []
  try {
    const snapshot = await api.saveConfig(props.plugin.id, {
      revision: revision.value,
      values: values.value,
      secretValues: secretValues.value,
    })
    revision.value = snapshot.revision
    values.value = snapshot.values ?? {}
    secretFields.value = snapshot.secretFields ?? {}
    secretValues.value = {}
    ElMessage.success('配置已保存')
    emit('saved')
  } catch (e) {
    const message = e instanceof Error ? e.message : '保存失败'
    if (message.includes('REVISION_CONFLICT') || message.includes('409')) {
      ElMessage.error('配置已被其他设备修改，请重新打开后重试')
    } else {
      ElMessage.error(message)
    }
  } finally {
    saving.value = false
  }
}

async function reset(): Promise<void> {
  if (!props.plugin) return
  if (!window.confirm('恢复默认值将清空全部插件配置（含密钥），确定继续吗？')) return
  saving.value = true
  try {
    const snapshot = await api.resetConfig(props.plugin.id)
    revision.value = snapshot.revision
    values.value = snapshot.values ?? {}
    secretFields.value = snapshot.secretFields ?? {}
    secretValues.value = {}
    ElMessage.success('已恢复默认配置')
    emit('saved')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '重置失败')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="open"
    :title="`${plugin?.id ?? ''} 配置`"
    class="plugin-config-dialog"
    width="min(680px, calc(100vw - 28px))"
    align-center
    @close="emit('close')"
    @closed="emit('close')"
  >
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
      <el-button :disabled="saving" @click="reset">恢复默认</el-button>
      <el-button @click="emit('close')">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.plugin-config-dialog :deep(.el-dialog__body) { max-height: 66vh; overflow-y: auto; }
.pcfg-loading { padding: 30px 0; text-align: center; color: var(--text-muted); font-size: 12px; }
.pcfg-issues { padding: 16px; border-radius: 10px; background: var(--danger-soft); }
.pcfg-issue { margin: 0 0 6px; color: var(--danger); font-size: 11px; }
</style>
