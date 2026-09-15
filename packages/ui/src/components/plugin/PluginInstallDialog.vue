<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from '../../utils/element'
import { PackagePlus } from 'lucide-vue-next'
import { useAervoxPlugins } from '@aervox/api-client'
import { AervoxDialog, AervoxButton } from '../../primitives'
import { validatePluginInstallForm } from './plugin-install-form'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'installed'): void
}>()

const api = useAervoxPlugins()

const pluginId = ref('')
const publisher = ref('')
const version = ref('')
const rawPermissions = ref('[]')
const rawTools = ref('')
const rawSkills = ref('')
const saving = ref(false)

function resetForm() {
  pluginId.value = ''
  publisher.value = ''
  version.value = ''
  rawPermissions.value = '[]'
  rawTools.value = ''
  rawSkills.value = ''
}

async function handleInstall(): Promise<void> {
  const result = validatePluginInstallForm({
    id: pluginId.value,
    publisher: publisher.value,
    version: version.value,
    rawPermissions: rawPermissions.value,
    rawTools: rawTools.value,
    rawSkills: rawSkills.value,
  })
  if (!result.ok) {
    ElMessage.warning(result.message)
    return
  }

  saving.value = true
  try {
    await api.installPlugin({ ...result.payload, installSource: 'manual' })
    ElMessage.success('插件安装成功')
    resetForm()
    emit('installed')
    emit('close')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '安装插件失败')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <AervoxDialog
    :model-value="open"
    title="安装插件"
    subtitle="登记插件声明，声明的工具与技能随安装注册（幂等）"
    :icon="PackagePlus"
    size="md"
    @close="emit('close')"
  >
    <div class="install-dialog-body">
      <div class="form-grid">
        <div class="field-block">
          <label class="field-label" for="plugin-id-input">插件唯一标识 (ID)</label>
          <input
            id="plugin-id-input"
            v-model="pluginId"
            class="input-control"
            placeholder="例如：com.example.notes"
            maxlength="128"
          />
        </div>

        <div class="field-block">
          <label class="field-label" for="plugin-publisher-input">发布者</label>
          <input
            id="plugin-publisher-input"
            v-model="publisher"
            class="input-control"
            placeholder="例如：aervox-official"
            maxlength="128"
          />
        </div>

        <div class="field-block">
          <label class="field-label" for="plugin-version-input">版本号</label>
          <input
            id="plugin-version-input"
            v-model="version"
            class="input-control"
            placeholder="例如：0.1.0"
            maxlength="64"
          />
        </div>

        <div class="field-block full-width">
          <label class="field-label" for="plugin-permissions-input">权限声明 (JSON；留空由 API 记为空数组)</label>
          <textarea
            id="plugin-permissions-input"
            v-model="rawPermissions"
            class="textarea-control"
            rows="3"
            spellcheck="false"
            placeholder='["fs.read", "net.fetch"]'
          />
        </div>

        <div class="field-block full-width">
          <label class="field-label" for="plugin-tools-input">声明工具 (JSON 数组；安装时按「插件ID.工具名」注册)</label>
          <textarea
            id="plugin-tools-input"
            v-model="rawTools"
            class="textarea-control"
            rows="5"
            spellcheck="false"
            placeholder='例：[{"name": "search_notes", "description": "检索学习笔记", "category": "search", "safetyLevel": "read_only"}]'
          />
        </div>

        <div class="field-block full-width">
          <label class="field-label" for="plugin-skills-input">声明技能 (JSON 数组；每项含 name 与 content/SKILL.md 全文)</label>
          <textarea
            id="plugin-skills-input"
            v-model="rawSkills"
            class="textarea-control"
            rows="5"
            spellcheck="false"
            placeholder='例：[{"name": "note-taking", "content": "---\ndescription: 记笔记\n---\n…"}]'
          />
        </div>
      </div>
    </div>

    <template #footer>
      <AervoxButton variant="secondary" @click="emit('close')">取消</AervoxButton>
      <AervoxButton
        variant="primary"
        :icon="PackagePlus"
        :loading="saving"
        @click="handleInstall"
      >
        安装插件
      </AervoxButton>
    </template>
  </AervoxDialog>
</template>

<style scoped>

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 14px;
}
.full-width {
  grid-column: 1 / -1;
}
.field-block {
  display: grid;
  gap: 5px;
}
.field-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
}
.input-control {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 12px;
}
.input-control:focus,
.textarea-control:focus {
  outline: none;
  border-color: var(--accent);
}
.textarea-control {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  resize: vertical;
}
.install-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.btn-submit {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  border: none;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}
.btn-submit:hover:not(:disabled) {
  opacity: 0.9;
  transform: translateY(-1px);
}
.btn-submit:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
