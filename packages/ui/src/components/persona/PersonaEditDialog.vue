<script setup lang="ts">
import {computed, ref, watch} from 'vue'
import {ElMessage} from 'element-plus'
import {Heart, Wrench, Zap} from 'lucide-vue-next'
import {
  useAervoxPersonas,
  type SkillItemDto,
  type ToolItemDto,
} from '@aervox/api-client'

const props = defineProps<{
  open: boolean
  personaId: string | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'saved'): void
}>()

const api = useAervoxPersonas()

const name = ref('')
const description = ref('')
const systemPromptAppend = ref('')
const expectedRevision = ref(1)
const loading = ref(false)
const saving = ref(false)

const availableTools = ref<ToolItemDto[]>([])
const availableSkills = ref<SkillItemDto[]>([])

const useAllTools = ref(true)
const selectedToolIds = ref<string[]>([])

const useAllSkills = ref(true)
const selectedSkillNames = ref<string[]>([])

const isEdit = computed(() => !!props.personaId)

const selectedToolsCount = computed(() => {
  if (useAllTools.value) return availableTools.value.length
  return selectedToolIds.value.length
})

const selectedSkillsCount = computed(() => {
  if (useAllSkills.value) return availableSkills.value.length
  return selectedSkillNames.value.length
})

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return
    loading.value = true
    try {
      const [tools, skills] = await Promise.all([
        api.loadAvailableTools(),
        api.loadAvailableSkills(),
      ])
      availableTools.value = tools
      availableSkills.value = skills

      if (props.personaId) {
        const detail = await api.getPersonaDetail(props.personaId)
        name.value = detail.persona.name
        description.value = detail.persona.description ?? ''
        if (detail.revision) {
          expectedRevision.value = detail.revision.revision
          systemPromptAppend.value = detail.revision.config.systemPromptAppend
          if (detail.revision.config.allowedMcpToolIds === undefined) {
            useAllTools.value = true
            selectedToolIds.value = []
          } else {
            useAllTools.value = false
            selectedToolIds.value = [...detail.revision.config.allowedMcpToolIds]
          }

          if (detail.revision.config.allowedSkillNames === undefined) {
            useAllSkills.value = true
            selectedSkillNames.value = []
          } else {
            useAllSkills.value = false
            selectedSkillNames.value = [...detail.revision.config.allowedSkillNames]
          }
        }
      } else {
        // 创建模式默认值
        name.value = ''
        description.value = ''
        systemPromptAppend.value = ''
        expectedRevision.value = 1
        useAllTools.value = true
        selectedToolIds.value = []
        useAllSkills.value = true
        selectedSkillNames.value = []
      }
    } catch (e) {
      ElMessage.error(e instanceof Error ? e.message : '加载人格配置失败')
      emit('close')
    } finally {
      loading.value = false
    }
  },
)

function toggleTool(toolId: string) {
  if (useAllTools.value) {
    useAllTools.value = false
    selectedToolIds.value = availableTools.value.map((t) => t.id).filter((id) => id !== toolId)
    return
  }
  const idx = selectedToolIds.value.indexOf(toolId)
  if (idx >= 0) {
    selectedToolIds.value.splice(idx, 1)
  } else {
    selectedToolIds.value.push(toolId)
  }
}

function toggleAllTools() {
  useAllTools.value = !useAllTools.value
  if (useAllTools.value) {
    selectedToolIds.value = []
  } else {
    selectedToolIds.value = availableTools.value.map((t) => t.id)
  }
}

function toggleSkill(skillName: string) {
  if (useAllSkills.value) {
    useAllSkills.value = false
    selectedSkillNames.value = availableSkills.value.map((s) => s.name).filter((n) => n !== skillName)
    return
  }
  const idx = selectedSkillNames.value.indexOf(skillName)
  if (idx >= 0) {
    selectedSkillNames.value.splice(idx, 1)
  } else {
    selectedSkillNames.value.push(skillName)
  }
}

function toggleAllSkills() {
  useAllSkills.value = !useAllSkills.value
  if (useAllSkills.value) {
    selectedSkillNames.value = []
  } else {
    selectedSkillNames.value = availableSkills.value.map((s) => s.name)
  }
}

function isToolSelected(toolId: string) {
  return useAllTools.value || selectedToolIds.value.includes(toolId)
}

function isSkillSelected(skillName: string) {
  return useAllSkills.value || selectedSkillNames.value.includes(skillName)
}

async function save() {
  const trimmedName = name.value.trim()
  const trimmedPrompt = systemPromptAppend.value.trim()

  if (!trimmedName) {
    ElMessage.warning('请输入人格名称')
    return
  }
  if (!trimmedPrompt) {
    ElMessage.warning('请输入系统提示词')
    return
  }

  saving.value = true
  try {
    const config = {
      systemPromptAppend: trimmedPrompt,
      allowedSkillNames: useAllSkills.value ? undefined : selectedSkillNames.value,
      allowedMcpToolIds: useAllTools.value ? undefined : selectedToolIds.value,
    }

    if (props.personaId) {
      await api.updatePersona(props.personaId, {
        expectedRevision: expectedRevision.value,
        name: trimmedName,
        description: description.value.trim(),
        config,
      })
      ElMessage.success('人格已更新')
    } else {
      await api.createPersona({
        name: trimmedName,
        description: description.value.trim(),
        config,
      })
      ElMessage.success('人格已创建')
    }
    emit('saved')
    emit('close')
  } catch (e) {
    const message = e instanceof Error ? e.message : '保存失败'
    if (message.includes('409') || message.includes('REVISION_CONFLICT')) {
      ElMessage.error('人格版本发生冲突，请重新打开后重试')
    } else {
      ElMessage.error(message)
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="open"
    class="persona-edit-dialog"
    width="min(860px, calc(100vw - 28px))"
    align-center
    :append-to-body="true"
    @close="emit('close')"
  >
    <template #header>
      <div class="dialog-header-wrap">
        <span class="heading-icon-wrap"><Heart :size="18" /></span>
        <div class="dialog-header-text">
          <strong>{{ isEdit ? '编辑人格' : '创建新人格' }}</strong>
          <small>{{ isEdit ? '更新人格提示词、能力与工具配置' : '配置新人格的核心设定与可用能力' }}</small>
        </div>
      </div>
    </template>

    <div v-if="loading" class="dialog-loading">正在加载人格配置…</div>
    <div v-else class="persona-form-grid">
      <!-- 左侧：基础信息与系统提示词 -->
      <div class="form-column left-column">
        <div class="field-block">
          <label class="field-label" for="persona-name">人格名称 / ID</label>
          <input
            id="persona-name"
            v-model="name"
            class="persona-input"
            placeholder="例如：Momoiairi"
            maxlength="64"
          />
        </div>

        <div class="field-block flex-grow">
          <label class="field-label" for="persona-prompt">系统提示词</label>
          <textarea
            id="persona-prompt"
            v-model="systemPromptAppend"
            class="persona-textarea"
            rows="9"
            placeholder="在此输入角色的核心设定、口吻风格、交互习惯与背景故事…"
          />
        </div>

        <div class="field-block">
          <label class="field-label" for="persona-desc">自定义描述（可选）</label>
          <input
            id="persona-desc"
            v-model="description"
            class="persona-input"
            placeholder="角色简述，便于在列表中快速辨别"
            maxlength="200"
          />
        </div>
      </div>

      <!-- 右侧：人格能力选择（工具与技能） -->
      <div class="form-column right-column">
        <div class="ability-heading">
          <strong>人格能力</strong>
          <small>按来源选择这个人格可使用的工具与技能</small>
        </div>

        <!-- 工具块 -->
        <div class="ability-card">
          <div class="ability-card-header" @click="toggleAllTools">
            <label class="checkbox-label" @click.stop>
              <input
                type="checkbox"
                :checked="useAllTools"
                @change="toggleAllTools"
              />
              <span class="header-title"><Wrench :size="15" /><strong>工具</strong></span>
            </label>
            <span class="ability-counter">{{ selectedToolsCount }}/{{ availableTools.length }}</span>
          </div>
          <div class="ability-card-body">
            <p v-if="availableTools.length === 0" class="ability-empty">暂无可用工具</p>
            <div v-else class="item-list">
              <label
                v-for="tool in availableTools"
                :key="tool.id"
                class="ability-item-row"
                :class="{selected: isToolSelected(tool.id)}"
              >
                <input
                  type="checkbox"
                  :checked="isToolSelected(tool.id)"
                  @change="toggleTool(tool.id)"
                />
                <div class="item-info">
                  <strong>{{ tool.name }}</strong>
                  <small>{{ tool.description || '无描述' }}</small>
                </div>
              </label>
            </div>
          </div>
        </div>

        <!-- 技能块 -->
        <div class="ability-card">
          <div class="ability-card-header" @click="toggleAllSkills">
            <label class="checkbox-label" @click.stop>
              <input
                type="checkbox"
                :checked="useAllSkills"
                @change="toggleAllSkills"
              />
              <span class="header-title"><Zap :size="15" /><strong>技能</strong></span>
            </label>
            <span class="ability-counter">{{ selectedSkillsCount }}/{{ availableSkills.length }}</span>
          </div>
          <div class="ability-card-body">
            <p v-if="availableSkills.length === 0" class="ability-empty">暂无可用技能</p>
            <div v-else class="item-list">
              <label
                v-for="skill in availableSkills"
                :key="skill.name"
                class="ability-item-row"
                :class="{selected: isSkillSelected(skill.name)}"
              >
                <input
                  type="checkbox"
                  :checked="isSkillSelected(skill.name)"
                  @change="toggleSkill(skill.name)"
                />
                <div class="item-info">
                  <strong>{{ skill.name }}</strong>
                  <small>{{ skill.description || '无描述' }}</small>
                </div>
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="dialog-footer">
        <button type="button" class="btn-secondary" @click="emit('close')">取消</button>
        <button type="button" class="btn-primary" :disabled="saving" @click="save">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.persona-edit-dialog {
  --el-dialog-bg-color: var(--bg-main);
  border-radius: 16px;
  overflow: hidden;
}

.persona-edit-dialog :deep(.el-dialog__header) {
  margin: 0;
  padding: 16px 22px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-main);
}

.dialog-header-wrap {
  display: flex;
  align-items: center;
  gap: 12px;
}

.heading-icon-wrap {
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  background: var(--accent-soft);
  color: var(--accent);
}

.dialog-header-text {
  display: grid;
  gap: 2px;
}

.dialog-header-text strong {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
}

.dialog-header-text small {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.4;
}

.persona-edit-dialog :deep(.el-dialog__body) {
  max-height: 72vh;
  overflow-y: auto;
  padding: 20px 24px;
}

.dialog-loading {
  padding: 40px 0;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.persona-form-grid {
  display: grid;
  grid-template-columns: 1.15fr 1fr;
  gap: 20px;
}

@media (max-width: 720px) {
  .persona-form-grid {
    grid-template-columns: 1fr;
  }
}

.form-column {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.flex-grow {
  flex: 1;
}

.field-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}

.persona-input {
  width: 100%;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-input, var(--bg-soft));
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.persona-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}

.persona-textarea {
  width: 100%;
  min-height: 160px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-input, var(--bg-soft));
  color: var(--text-primary);
  font-size: 12px;
  line-height: 1.5;
  outline: none;
  resize: vertical;
  box-sizing: border-box;
  font-family: inherit;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.persona-textarea:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}

.ability-heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ability-heading strong {
  font-size: 13px;
  color: var(--text-primary);
}

.ability-heading small {
  font-size: 11px;
  color: var(--text-muted);
}

.ability-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-soft);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.ability-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 12px;
  background: color-mix(in srgb, var(--border) 25%, var(--bg-soft));
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  user-select: none;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 12px;
}

.checkbox-label input,
.ability-item-row input {
  accent-color: var(--accent);
  cursor: pointer;
}

.header-title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-primary);
}

.ability-counter {
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.ability-card-body {
  max-height: 150px;
  overflow-y: auto;
  padding: 6px 8px;
}

.ability-empty {
  padding: 16px 0;
  text-align: center;
  color: var(--text-muted);
  font-size: 11px;
  margin: 0;
}

.item-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ability-item-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s ease;
}

.ability-item-row:hover {
  background: var(--bg-hover);
}

.ability-item-row.selected {
  background: color-mix(in srgb, var(--accent) 12%, var(--bg-soft));
}

.item-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.item-info strong {
  font-size: 11.5px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-info small {
  font-size: 10.5px;
  color: var(--text-muted);
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.dialog-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 4px 0 0;
}

.btn-secondary {
  padding: 8px 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-soft);
  color: var(--text-secondary);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-secondary:hover {
  border-color: var(--border-strong, var(--accent));
  color: var(--text-primary);
  background: var(--bg-hover);
}

.btn-primary {
  padding: 8px 20px;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 2px 8px color-mix(in srgb, var(--accent) 28%, transparent);
  transition: background-color 0.15s ease, box-shadow 0.15s ease;
}

.btn-primary:hover {
  background: var(--accent-hover);
  box-shadow: 0 4px 12px color-mix(in srgb, var(--accent) 34%, transparent);
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
