<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from '../../utils/element'
import {
  Play,
  Plus,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Trash2,
  Wrench,
} from 'lucide-vue-next'
import { useAervoxTools, type ToolRegistrationDto } from '@aervox/api-client'
import ToolCallDialog from './ToolCallDialog.vue'
import McpRegisterDialog from './McpRegisterDialog.vue'
import McpPresetServers from './McpPresetServers.vue'

const emit = defineEmits<{
  'change': []
}>()

const api = useAervoxTools()
const { tools, loading, error, loadTools, setToolEnabled, unregisterTool } = api

const callDialogOpen = ref(false)
const registerDialogOpen = ref(false)
const selectedTool = ref<ToolRegistrationDto | null>(null)
const busyToolId = ref<string | null>(null)

type ToolFilter = 'pure' | 'plugin' | 'all'
const filterMode = ref<ToolFilter>('pure')

function isPluginTool(tool: ToolRegistrationDto): boolean {
  return Boolean(tool.pluginId && !tool.pluginId.startsWith('mcp:'))
}

const displayTools = computed(() => {
  if (filterMode.value === 'pure') {
    return tools.value.filter((t) => !isPluginTool(t))
  }
  if (filterMode.value === 'plugin') {
    return tools.value.filter(isPluginTool)
  }
  return tools.value
})

const pureToolCount = computed(() => tools.value.filter((t) => !isPluginTool(t)).length)
const pluginToolCount = computed(() => tools.value.filter(isPluginTool).length)

onMounted(() => {
  void loadTools()
})

function isToolEnabled(tool: ToolRegistrationDto): boolean {
  return tool.enabled === 1 || tool.enabled === true
}

function isBuiltin(tool: ToolRegistrationDto): boolean {
  return tool.builtin === 1 || tool.builtin === true
}

function getSafetyLabel(level?: string): { label: string; class: string } {
  switch (level) {
    case 'read_only':
      return { label: '只读安全', class: 'safety-read-only' }
    case 'privileged':
      return { label: '特权保护', class: 'safety-privileged' }
    case 'write_with_approval':
    default:
      return { label: '需授权写', class: 'safety-approval' }
  }
}

async function toggleEnabled(tool: ToolRegistrationDto): Promise<void> {
  const next = !isToolEnabled(tool)
  busyToolId.value = tool.id
  try {
    await setToolEnabled(tool.id, next)
    emit('change')
    ElMessage.success(`已${next ? '启用' : '停用'}工具「${tool.name}」`)
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '切换工具状态失败')
  } finally {
    busyToolId.value = null
  }
}

function openCallDialog(tool: ToolRegistrationDto): void {
  selectedTool.value = tool
  callDialogOpen.value = true
}

async function handleDelete(tool: ToolRegistrationDto): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定注销工具「${tool.name}」(${tool.id}) 吗？`,
      '注销工具确认',
      {
        confirmButtonText: '注销',
        cancelButtonText: '取消',
        type: 'warning',
      },
    )
    busyToolId.value = tool.id
    await unregisterTool(tool.id)
    emit('change')
    ElMessage.success('工具已注销')
  } catch (e) {
    if (e !== 'cancel') {
      ElMessage.error(e instanceof Error ? e.message : '注销工具失败')
    }
  } finally {
    busyToolId.value = null
  }
}

function handleRegistered(): void {
  emit('change')
  void loadTools()
}

function handlePresetChanged(): void {
  emit('change')
  void loadTools()
}
</script>

<template>
  <div class="mcp-tools-tab">
    <div class="tab-toolbar">
      <div class="tab-filters">
        <button
          type="button"
          class="filter-pill-btn"
          :class="{ active: filterMode === 'pure' }"
          @click="filterMode = 'pure'"
        >
          系统与独立 MCP ({{ pureToolCount }})
        </button>
        <button
          v-if="pluginToolCount > 0"
          type="button"
          class="filter-pill-btn"
          :class="{ active: filterMode === 'plugin' }"
          @click="filterMode = 'plugin'"
        >
          插件专属工具 ({{ pluginToolCount }})
        </button>
        <button
          type="button"
          class="filter-pill-btn"
          :class="{ active: filterMode === 'all' }"
          @click="filterMode = 'all'"
        >
          全部 ({{ tools.length }})
        </button>
      </div>
      <div class="tab-actions">
        <button
          type="button"
          class="btn-primary-action"
          @click="registerDialogOpen = true"
        >
          <Plus :size="15" />
          <span>注册 MCP 工具</span>
        </button>
      </div>
    </div>

    <!-- 提示横幅 -->
    <div v-if="filterMode === 'pure' && pluginToolCount > 0" class="tab-hint-banner">
      <Wrench :size="14" />
      <span>当前仅管理系统内置与独立 MCP 服务端点。另有 <strong>{{ pluginToolCount }}</strong> 个插件专属工具已归由对应「插件」设置统一管理。</span>
    </div>
    <div v-else-if="filterMode === 'plugin'" class="tab-hint-banner">
      <Wrench :size="14" />
      <span>以下为各扩展插件内置声明的专属工具，其生命周期随插件统一管理，建议在对应插件设置中调试与启停。</span>
    </div>

    <McpPresetServers @changed="handlePresetChanged" />

    <div v-if="loading" class="tab-loading">加载工具注册表中…</div>
    <p v-else-if="error" class="tab-empty">{{ error }}</p>
    <p v-else-if="displayTools.length === 0" class="tab-empty">
      {{ filterMode === 'pure' ? '暂无可用的系统或独立 MCP 工具。点击右上角「注册 MCP 工具」登记新的外部端点。' : '当前筛选下暂无可展示的工具。' }}
    </p>

    <div v-else class="tool-list">
      <article
        v-for="tool in displayTools"
        :key="tool.id"
        class="tool-card"
        :class="{ inactive: !isToolEnabled(tool) }"
      >
        <span class="tool-card-icon">
          <Wrench :size="18" />
        </span>
        <div class="tool-card-main">
          <div class="tool-card-header">
            <strong class="tool-title">{{ tool.name }}</strong>
            <code class="tool-id-code">{{ tool.id }}</code>
            <span class="tool-badge badge-category">{{ tool.category || 'system' }}</span>
            <span class="tool-badge" :class="getSafetyLabel(tool.safetyLevel).class">
              {{ getSafetyLabel(tool.safetyLevel).label }}
            </span>
            <span v-if="isBuiltin(tool)" class="tool-badge badge-builtin">系统内置</span>
            <span v-else-if="tool.pluginId?.startsWith('mcp:')" class="tool-badge badge-mcp-server">
              MCP: {{ tool.pluginId.slice(4) }}
            </span>
            <span v-else-if="tool.pluginId" class="tool-badge badge-plugin">
              插件: {{ tool.pluginId }}
            </span>
          </div>
          <p class="tool-desc">{{ tool.description || '暂无描述' }}</p>
        </div>
        <div class="tool-card-actions">
          <button
            type="button"
            class="settings-switch tool-toggle"
            :class="{ checked: isToolEnabled(tool) }"
            :disabled="busyToolId === tool.id"
            :aria-label="`${isToolEnabled(tool) ? '停用' : '启用'} ${tool.name}`"
            @click="toggleEnabled(tool)"
          />
          <button
            type="button"
            class="tool-action-btn"
            title="调试测试调用"
            :disabled="!isToolEnabled(tool)"
            @click="openCallDialog(tool)"
          >
            <Terminal :size="14" />
            <span>调试</span>
          </button>
          <button
            v-if="!isBuiltin(tool)"
            type="button"
            class="tool-action-btn btn-danger"
            title="注销工具"
            :disabled="busyToolId === tool.id"
            @click="handleDelete(tool)"
          >
            <Trash2 :size="14" />
          </button>
        </div>
      </article>
    </div>

    <ToolCallDialog
      :open="callDialogOpen"
      :tool="selectedTool"
      @close="callDialogOpen = false"
    />
    <McpRegisterDialog
      :open="registerDialogOpen"
      @close="registerDialogOpen = false"
      @registered="handleRegistered"
    />
  </div>
</template>

<style scoped>
.mcp-tools-tab {
  display: grid;
  gap: 14px;
}
.tab-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.tab-filters {
  display: flex;
  gap: 4px;
  background: var(--bg-input, rgba(0, 0, 0, 0.04));
  padding: 3px;
  border-radius: 8px;
}
.filter-pill-btn {
  border: none;
  background: transparent;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}
.filter-pill-btn:hover {
  color: var(--text-primary);
}
.filter-pill-btn.active {
  background: var(--button-bg, #fff);
  color: var(--accent, #409eff);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}
.tab-hint-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--bg-hover, rgba(0, 0, 0, 0.03));
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.4;
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
.tab-loading,
.tab-empty {
  padding: 26px 0;
  text-align: center;
  color: var(--text-muted);
  font-size: 11px;
}
.tool-list {
  display: grid;
  gap: 10px;
}
.tool-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-soft);
  transition: all 0.22s ease;
}
.tool-card:hover {
  border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
  background: color-mix(in srgb, var(--bg-soft) 85%, var(--accent-soft));
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(15, 20, 32, 0.05);
}
.tool-card.inactive {
  opacity: 0.72;
}
.tool-card-icon {
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent);
}
.tool-card-main {
  min-width: 0;
  flex: 1;
  display: grid;
  gap: 3px;
}
.tool-card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.tool-title {
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 600;
}
.tool-id-code {
  font-size: 10px;
  padding: 1px 4px;
  background: var(--bg-input);
  border-radius: 4px;
  color: var(--text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.tool-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 9px;
  border: 1px solid transparent;
}
.badge-category {
  background: var(--bg-input);
  color: var(--text-secondary);
  border-color: var(--border);
}
.safety-read-only {
  background: color-mix(in srgb, #10b981 15%, transparent);
  color: #10b981;
  border-color: color-mix(in srgb, #10b981 30%, transparent);
}
.safety-approval {
  background: color-mix(in srgb, #f59e0b 15%, transparent);
  color: #f59e0b;
  border-color: color-mix(in srgb, #f59e0b 30%, transparent);
}
.safety-privileged {
  background: color-mix(in srgb, #ef4444 15%, transparent);
  color: #ef4444;
  border-color: color-mix(in srgb, #ef4444 30%, transparent);
}
.badge-builtin {
  background: color-mix(in srgb, #6b7280 15%, transparent);
  color: var(--text-muted);
}
.badge-mcp-server {
  background: color-mix(in srgb, #06b6d4 15%, transparent);
  color: #0891b2;
  border-color: color-mix(in srgb, #06b6d4 30%, transparent);
}
.badge-plugin {
  background: color-mix(in srgb, #8b5cf6 15%, transparent);
  color: #8b5cf6;
  border-color: color-mix(in srgb, #8b5cf6 30%, transparent);
}
.tool-desc {
  margin: 0;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-card-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tool-toggle {
  width: 40px;
  height: 22px;
  flex: 0 0 40px;
}
.tool-action-btn {
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
.tool-action-btn:hover:not(:disabled) {
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
.tool-action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
