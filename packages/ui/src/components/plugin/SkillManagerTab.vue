<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  BookOpen,
  FileText,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  Zap,
} from 'lucide-vue-next'
import { useAervoxSkills, type SkillDto } from '@aervox/api-client'
import SkillContentDialog from './SkillContentDialog.vue'

const api = useAervoxSkills()
const { skills, loading, error, loadSkills, setSkillActive, installSkillZip, deleteSkill } = api

const contentDialogOpen = ref(false)
const selectedSkill = ref<SkillDto | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const busySkillId = ref<string | null>(null)

onMounted(() => {
  void loadSkills()
})

function isSkillActive(skill: SkillDto): boolean {
  return skill.active === 1 || skill.active === true
}

function isSkillReadonly(skill: SkillDto): boolean {
  return skill.readonly === 1 || skill.readonly === true || skill.source === 'plugin'
}

function getSourceLabel(source: string): string {
  switch (source) {
    case 'local':
      return '本地安装'
    case 'plugin':
      return '插件内置'
    case 'ai_authored':
      return 'AI 创设'
    default:
      return source || '系统'
  }
}

async function toggleActive(skill: SkillDto): Promise<void> {
  const nextActive = !isSkillActive(skill)
  busySkillId.value = skill.id || skill.name
  try {
    await setSkillActive(skill.id || skill.name, nextActive)
    ElMessage.success(`已${nextActive ? '启用' : '停用'}技能「${skill.name}」`)
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '切换技能状态失败')
  } finally {
    busySkillId.value = null
  }
}

function openContent(skill: SkillDto): void {
  selectedSkill.value = skill
  contentDialogOpen.value = true
}

async function handleDelete(skill: SkillDto): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定要删除技能「${skill.name}」吗？删除后不可恢复。`,
      '删除技能确认',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning',
      },
    )
    busySkillId.value = skill.id || skill.name
    await deleteSkill(skill.id || skill.name)
    ElMessage.success('技能已删除')
  } catch (e) {
    if (e !== 'cancel') {
      ElMessage.error(e instanceof Error ? e.message : '删除技能失败')
    }
  } finally {
    busySkillId.value = null
  }
}

function triggerUpload(): void {
  fileInput.value?.click()
}

async function handleFileSelected(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return

  uploading.value = true
  try {
    const arrayBuffer = await file.arrayBuffer()
    const bytes = new Uint8Array(arrayBuffer)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!)
    }
    const base64 = btoa(binary)
    await installSkillZip(base64, { overwrite: false })
    ElMessage.success('技能包安装成功')
  } catch (e) {
    const msg = e instanceof Error ? e.message : '安装技能失败'
    if (msg.includes('409') || msg.includes('exists') || msg.includes('冲突')) {
      try {
        await ElMessageBox.confirm(
          '存在同名技能，是否覆盖已有技能并继续安装？',
          '技能冲突',
          {
            confirmButtonText: '覆盖并安装',
            cancelButtonText: '取消',
            type: 'warning',
          },
        )
        const arrayBuffer = await file.arrayBuffer()
        const bytes = new Uint8Array(arrayBuffer)
        let binary = ''
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]!)
        }
        const base64 = btoa(binary)
        await installSkillZip(base64, { overwrite: true })
        ElMessage.success('已覆盖并成功安装技能')
      } catch {
        // user cancelled
      }
    } else {
      ElMessage.error(msg)
    }
  } finally {
    uploading.value = false
    if (target) target.value = ''
  }
}
</script>

<template>
  <div class="skill-manager-tab">
    <div class="tab-toolbar">
      <div class="tab-summary">
        <span>已注册 <strong>{{ skills.length }}</strong> 个技能指令包</span>
      </div>
      <div class="tab-actions">
        <input
          ref="fileInput"
          type="file"
          accept=".zip"
          style="display: none"
          @change="handleFileSelected"
        />
        <button
          type="button"
          class="btn-primary-action"
          :disabled="uploading"
          @click="triggerUpload"
        >
          <Upload :size="15" />
          <span>{{ uploading ? '安装中…' : '上传技能 (ZIP)' }}</span>
        </button>
      </div>
    </div>

    <div v-if="loading" class="tab-loading">加载技能列表中…</div>
    <p v-else-if="error" class="tab-empty">{{ error }}</p>
    <p v-else-if="skills.length === 0" class="tab-empty">
      暂无可用的技能包。点击右上角「上传技能」安装符合 Anthropic Skills 规范的 ZIP 包。
    </p>

    <div v-else class="skill-list">
      <article
        v-for="skill in skills"
        :key="skill.id || skill.name"
        class="skill-card"
        :class="{ inactive: !isSkillActive(skill) }"
      >
        <span class="skill-card-icon">
          <Zap :size="18" />
        </span>
        <div class="skill-card-main">
          <div class="skill-card-header">
            <strong class="skill-title">{{ skill.name }}</strong>
            <span class="skill-badge" :class="`badge-${skill.source || 'local'}`">
              {{ getSourceLabel(skill.source) }}
            </span>
            <span v-if="isSkillReadonly(skill)" class="skill-badge badge-readonly">只读保护</span>
          </div>
          <p class="skill-desc">{{ skill.description || '暂无描述' }}</p>
        </div>
        <div class="skill-card-actions">
          <button
            type="button"
            class="settings-switch skill-toggle"
            :class="{ checked: isSkillActive(skill) }"
            :disabled="busySkillId === (skill.id || skill.name)"
            :aria-label="`${isSkillActive(skill) ? '停用' : '启用'} ${skill.name}`"
            @click="toggleActive(skill)"
          />
          <button
            type="button"
            class="skill-action-btn"
            title="查看 SKILL.md 正文"
            @click="openContent(skill)"
          >
            <FileText :size="14" />
            <span>说明</span>
          </button>
          <button
            v-if="!isSkillReadonly(skill)"
            type="button"
            class="skill-action-btn btn-danger"
            title="删除技能"
            :disabled="busySkillId === (skill.id || skill.name)"
            @click="handleDelete(skill)"
          >
            <Trash2 :size="14" />
          </button>
        </div>
      </article>
    </div>

    <SkillContentDialog
      :open="contentDialogOpen"
      :skill="selectedSkill"
      @close="contentDialogOpen = false"
    />
  </div>
</template>

<style scoped>
.skill-manager-tab {
  display: grid;
  gap: 14px;
}
.tab-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.tab-summary {
  font-size: 11px;
  color: var(--text-muted);
}
.tab-summary strong {
  color: var(--text-primary);
}
.btn-primary-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  border: none;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.btn-primary-action:hover:not(:disabled) {
  opacity: 0.9;
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(78, 119, 209, 0.25);
}
.btn-primary-action:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.tab-loading,
.tab-empty {
  padding: 26px 0;
  text-align: center;
  color: var(--text-muted);
  font-size: 11px;
}
.skill-list {
  display: grid;
  gap: 10px;
}
.skill-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-soft);
  transition: all 0.22s ease;
}
.skill-card:hover {
  border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
  background: color-mix(in srgb, var(--bg-soft) 85%, var(--accent-soft));
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(15, 20, 32, 0.05);
}
.skill-card.inactive {
  opacity: 0.72;
}
.skill-card-icon {
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent);
}
.skill-card-main {
  min-width: 0;
  flex: 1;
  display: grid;
  gap: 3px;
}
.skill-card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.skill-title {
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 600;
}
.skill-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 9px;
  background: var(--bg-input);
  color: var(--text-secondary);
  border: 1px solid var(--border);
}
.badge-plugin {
  background: color-mix(in srgb, #8b5cf6 15%, transparent);
  color: #8b5cf6;
  border-color: color-mix(in srgb, #8b5cf6 30%, transparent);
}
.badge-local {
  background: color-mix(in srgb, #10b981 15%, transparent);
  color: #10b981;
  border-color: color-mix(in srgb, #10b981 30%, transparent);
}
.badge-ai_authored {
  background: color-mix(in srgb, #f59e0b 15%, transparent);
  color: #f59e0b;
  border-color: color-mix(in srgb, #f59e0b 30%, transparent);
}
.badge-readonly {
  background: color-mix(in srgb, #6b7280 15%, transparent);
  color: var(--text-muted);
}
.skill-desc {
  margin: 0;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skill-card-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.skill-toggle {
  width: 40px;
  height: 22px;
  flex: 0 0 40px;
}
.skill-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s ease;
}
.skill-action-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
  transform: translateY(-1px);
}
.btn-danger:hover:not(:disabled) {
  border-color: var(--danger, #ef4444);
  color: var(--danger, #ef4444);
  background: color-mix(in srgb, #ef4444 12%, transparent);
}
.skill-action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
