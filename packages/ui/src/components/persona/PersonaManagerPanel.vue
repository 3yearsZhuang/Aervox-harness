<script setup lang="ts">
import {computed, onMounted, ref} from 'vue'
import {ElMessage, ElMessageBox} from 'element-plus'
import {
  ChevronDown,
  Download,
  Edit3,
  Heart,
  MessageSquare,
  MoreVertical,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  Wrench,
  Zap,
} from 'lucide-vue-next'
import {
  useAervoxPersonas,
  type PersonaDto,
} from '@aervox/api-client'
import PersonaEditDialog from './PersonaEditDialog.vue'

const api = useAervoxPersonas()
const {personas, activePersona, loading, error, loadPersonas, deletePersona, activatePersona, exportPersona, importPersona} = api

const editDialogOpen = ref(false)
const editTargetId = ref<string | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const importing = ref(false)
const exportingId = ref<string | null>(null)

onMounted(() => {
  void loadPersonas()
})

const activePersonaId = computed(() => activePersona.value?.personaId ?? null)

function openCreate() {
  editTargetId.value = null
  editDialogOpen.value = true
}

function openEdit(persona: PersonaDto) {
  editTargetId.value = persona.id
  editDialogOpen.value = true
}

function triggerImport() {
  fileInput.value?.click()
}

async function handleFileSelected(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return

  importing.value = true
  try {
    const arrayBuffer = await file.arrayBuffer()
    const bytes = new Uint8Array(arrayBuffer)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!)
    }
    const base64 = btoa(binary)
    await importPersona(base64, 'error')
    ElMessage.success('人格包已导入')
    await loadPersonas()
  } catch (e) {
    const msg = e instanceof Error ? e.message : '导入人格包失败'
    if (msg.includes('409') || msg.includes('SKILL_CONFLICT')) {
      try {
        await ElMessageBox.confirm('部分技能已存在，是否覆盖既有技能并继续导入？', '导入冲突', {
          confirmButtonText: '覆盖并导入',
          cancelButtonText: '取消',
          type: 'warning',
        })
        // 用户确认覆盖
        const arrayBuffer = await file.arrayBuffer()
        const bytes = new Uint8Array(arrayBuffer)
        let binary = ''
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]!)
        }
        const base64 = btoa(binary)
        await importPersona(base64, 'replace')
        ElMessage.success('已覆盖并成功导入人格')
        await loadPersonas()
      } catch {
        // cancel
      }
    } else {
      ElMessage.error(msg)
    }
  } finally {
    importing.value = false
    if (target) target.value = ''
  }
}

async function handleExport(persona: PersonaDto) {
  exportingId.value = persona.id
  try {
    const res = await exportPersona(persona.id)
    const bin = atob(res.bundleBase64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i)
    }
    const blob = new Blob([bytes], {type: 'application/zip'})
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = res.fileName || `${persona.name}.persona.zip`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    ElMessage.success('已导出人格包')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '导出失败')
  } finally {
    exportingId.value = null
  }
}

async function handleActivate(persona: PersonaDto) {
  try {
    await activatePersona(persona.id)
    ElMessage.success(`已切换当前人格为「${persona.name}」`)
    await loadPersonas()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '激活人格失败')
  }
}

async function handleDelete(persona: PersonaDto) {
  try {
    await ElMessageBox.confirm(`确定删除人格「${persona.name}」吗？删除后将无法恢复。`, '删除确认', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
    await deletePersona(persona.id)
    ElMessage.success('人格已删除')
    await loadPersonas()
  } catch {
    // cancelled or error handled
  }
}

function formatDate(isoString: string): string {
  try {
    const d = new Date(isoString)
    if (isNaN(d.getTime())) return isoString
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  } catch {
    return isoString
  }
}
</script>

<template>
  <div class="persona-manager">
    <!-- 顶部标题与操作栏（对齐全局标题设计） -->
    <div class="persona-header">
      <div class="persona-title-group">
        <span class="heading-icon-wrap"><Heart :size="18" /></span>
        <div class="header-titles">
          <strong>人格设定</strong>
          <small>管理人格角色设定</small>
        </div>
      </div>

      <div class="header-actions">
        <input
          ref="fileInput"
          type="file"
          accept=".zip,.persona.zip"
          style="display: none"
          @change="handleFileSelected"
        />

        <el-dropdown trigger="click" @command="(cmd: string) => cmd === 'create' ? openCreate() : triggerImport()">
          <button type="button" class="btn-create-persona">
            <Plus :size="16" />
            <span>创建人格</span>
            <ChevronDown :size="14" />
          </button>
          <template #dropdown>
            <el-dropdown-menu class="persona-dropdown-menu">
              <el-dropdown-item command="create">
                <Plus :size="14" class="menu-icon" />创建新人格
              </el-dropdown-item>
              <el-dropdown-item command="import">
                <Upload :size="14" class="menu-icon" />导入人格
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </div>

    <!-- 人格卡片列表（对齐图 1 / 图 2） -->
    <div v-if="loading" class="persona-loading">加载人格设定…</div>
    <p v-else-if="error" class="persona-error">{{ error }}</p>
    <p v-else-if="personas.length === 0" class="persona-empty">
      暂无自定义人格角色。点击右上角「创建人格」或「导入人格」开始配置。
    </p>

    <div v-else class="persona-card-grid">
      <article
        v-for="persona in personas"
        :key="persona.id"
        class="persona-card"
        :class="{active: persona.id === activePersonaId}"
      >
        <div class="card-top-row">
          <div class="card-title-group">
            <strong class="persona-name">{{ persona.name }}</strong>
            <span v-if="persona.id === activePersonaId" class="active-badge">
              <Sparkles :size="12" />当前激活
            </span>
          </div>

          <!-- 更多操作下拉菜单（对齐图 2） -->
          <el-dropdown trigger="click" :teleported="true">
            <button type="button" class="card-more-btn" aria-label="更多操作">
              <MoreVertical :size="16" />
            </button>
            <template #dropdown>
              <el-dropdown-menu class="card-dropdown-menu">
                <el-dropdown-item @click="openEdit(persona)">
                  <Edit3 :size="14" class="menu-icon" />编辑
                </el-dropdown-item>
                <el-dropdown-item
                  v-if="persona.id !== activePersonaId"
                  @click="handleActivate(persona)"
                >
                  <Sparkles :size="14" class="menu-icon" />设为当前人格
                </el-dropdown-item>
                <el-dropdown-item
                  :disabled="exportingId === persona.id"
                  @click="handleExport(persona)"
                >
                  <Download :size="14" class="menu-icon" />导出
                </el-dropdown-item>
                <el-dropdown-item divided class="danger-item" @click="handleDelete(persona)">
                  <Trash2 :size="14" class="menu-icon" />删除
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>

        <!-- 描述与提示词预览 -->
        <p class="persona-description">
          {{ persona.description || '暂无描述信息' }}
        </p>

        <!-- 标签徽章栏（对齐图 1） -->
        <div class="persona-badges">
          <span class="badge-tag">
            <MessageSquare :size="12" />
            <span>设定就绪</span>
          </span>
          <span class="badge-tag">
            <Wrench :size="12" />
            <span>使用可用工具</span>
          </span>
          <span class="badge-tag">
            <Zap :size="12" />
            <span>系统技能就绪</span>
          </span>
        </div>

        <!-- 创建时间 -->
        <div class="card-footer">
          <small>创建时间: {{ formatDate(persona.createdAt) }}</small>
        </div>
      </article>
    </div>

    <!-- 编辑/创建弹窗（对齐图 4） -->
    <PersonaEditDialog
      :open="editDialogOpen"
      :persona-id="editTargetId"
      @close="editDialogOpen = false"
      @saved="loadPersonas"
    />
  </div>
</template>

<style scoped>
.persona-manager {
  display: grid;
  gap: 16px;
}

.persona-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 15px;
  border-bottom: 1px solid var(--border);
}

.persona-title-group {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
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

.header-titles {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.header-titles strong {
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 700;
}

.header-titles small {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.4;
}

.btn-create-persona {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 7px 14px;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 2px 8px color-mix(in srgb, var(--accent) 28%, transparent);
  transition: background-color 0.15s ease, transform 0.12s ease, box-shadow 0.15s ease;
}

.btn-create-persona:hover {
  background: var(--accent-hover);
  box-shadow: 0 4px 12px color-mix(in srgb, var(--accent) 36%, transparent);
}

.menu-icon {
  margin-right: 6px;
}

.persona-loading,
.persona-empty,
.persona-error {
  padding: 36px 0;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}

.persona-error {
  color: var(--danger, #ef4444);
}

.persona-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}

.persona-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-soft);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.persona-card:hover {
  border-color: var(--border-strong, var(--accent));
}

.persona-card.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1.5px var(--accent);
  background: color-mix(in srgb, var(--accent-soft) 30%, var(--bg-soft));
}

.card-top-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.card-title-group {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.persona-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.active-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 6px;
  background: var(--accent-soft);
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 32%, transparent);
  font-size: 10.5px;
  font-weight: 600;
}

.card-more-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}

.card-more-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.persona-description {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 35px;
}

.persona-badges {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.badge-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--border) 45%, var(--bg-soft));
  color: var(--text-secondary);
  font-size: 11.5px;
}

.card-footer {
  padding-top: 4px;
  border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
}

.card-footer small {
  font-size: 11px;
  color: var(--text-muted);
}

.danger-item {
  color: var(--danger, #ef4444) !important;
}
</style>
