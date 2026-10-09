<script setup lang="ts">
import { AervoxCard, AervoxButton, AervoxSegmentedControl } from '../../primitives';
import { computed, onMounted, ref } from 'vue'
import {
  ShoppingBag,
  Download,
  CheckCircle2,
  RefreshCw,
  Search,
  Package,
  Zap,
  Wrench,
  Layout,
  Radar,
  SlidersHorizontal,
} from 'lucide-vue-next'
import { useAervoxPlugins, type PluginMarketItemDto } from '@aervox/api-client'
import { ElMessage } from '../../utils/element'

const emit = defineEmits<{
  (e: 'installed'): void
}>()

const api = useAervoxPlugins()
const marketItems = ref<PluginMarketItemDto[]>([])
const loading = ref(false)
const searchQuery = ref('')
const selectedFilter = ref<'all' | 'proactive' | 'skills' | 'tools' | 'pages'>('all')
const actionBusy = ref<string | null>(null)

async function loadMarket(): Promise<void> {
  loading.value = true
  try {
    marketItems.value = await api.listMarket()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '获取插件集市列表失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadMarket()
})

const filteredItems = computed(() => {
  return marketItems.value.filter((item) => {
    // 搜索过滤
    const q = searchQuery.value.trim().toLowerCase()
    if (q) {
      const matchName = item.displayName.toLowerCase().includes(q)
      const matchId = item.id.toLowerCase().includes(q)
      const matchDesc = (item.description || '').toLowerCase().includes(q)
      if (!matchName && !matchId && !matchDesc) return false
    }

    // 能力分类过滤
    if (selectedFilter.value === 'proactive') {
      return item.capabilities.sensorsCount > 0 || item.capabilities.triggersCount > 0
    }
    if (selectedFilter.value === 'skills') {
      return item.capabilities.skillsCount > 0
    }
    if (selectedFilter.value === 'tools') {
      return item.capabilities.toolsCount > 0
    }
    if (selectedFilter.value === 'pages') {
      return item.capabilities.pagesCount > 0
    }
    return true
  })
})

async function handleInstall(item: PluginMarketItemDto): Promise<void> {
  actionBusy.value = item.id
  try {
    await api.installFromMarket(item.id)
    ElMessage.success(`插件「${item.displayName || item.id}」已成功安装`)
    await loadMarket()
    emit('installed')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '安装插件失败')
  } finally {
    actionBusy.value = null
  }
}

async function handleExport(item: PluginMarketItemDto): Promise<void> {
  actionBusy.value = `export:${item.id}`
  try {
    await api.downloadPackage(item.id)
    ElMessage.success(`插件安装包已导出下载`)
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '导出分发包失败')
  } finally {
    actionBusy.value = null
  }
}
const filterOptions = computed(() => [
  { value: 'all', label: `全部 (${marketItems.value.length})` },
  { value: 'proactive', label: '主动智能' }, { value: 'skills', label: '技能扩展' },
  { value: 'tools', label: '工具/MCP' }, { value: 'pages', label: '扩展页面' },
])
</script>

<template>
  <div class="plugin-market-tab">
    <!-- 工具栏与筛选 -->
    <div class="market-toolbar">
      <div class="search-box">
        <Search :size="15" class="search-icon" />
        <input
          v-model="searchQuery"
          type="text"
          placeholder="搜索插件名称、标识或功能说明…"
          class="aervox-field search-input"
        />
      </div>

      <AervoxSegmentedControl variant="tabs" v-model="selectedFilter" :options="filterOptions" label="插件集市筛选" />

      <AervoxButton variant="secondary" icon-only aria-label="刷新插件集市" type="button" class="btn-refresh" :disabled="loading" @click="loadMarket">
        <RefreshCw :size="14" :class="{ rotating: loading }" />
      </AervoxButton>
    </div>

    <!-- 加载态 -->
    <div v-if="loading" class="market-loading">
      加载官方与出厂插件集市中…
    </div>

    <!-- 空状态 -->
    <div v-else-if="filteredItems.length === 0" class="market-empty">
      <Package :size="32" class="empty-icon" />
      <span>未找到匹配的插件</span>
    </div>

    <!-- 插件集市卡片网格 -->
    <div v-else class="settings-list market-grid">
      <AervoxCard as="div"
        v-for="item in filteredItems"
        :key="item.id"
        class="settings-item market-card"
        :class="{ 'card-installed': item.installed }"
      >
        <div class="card-header">
          <div class="card-title-group">
            <span class="card-title">{{ item.displayName || item.id }}</span>
            <code class="card-id">{{ item.id }}</code>
          </div>
          <div class="card-status-badge">
            <span v-if="item.hasUpdate" class="aervox-badge badge badge-update">可更新</span>
            <span v-else-if="item.installed" class="aervox-badge badge badge-installed">
              <CheckCircle2 :size="11" />
              <span>已安装</span>
            </span>
            <span v-else class="aervox-badge badge badge-available">出厂预设</span>
          </div>
        </div>

        <p class="card-desc">{{ item.description || '暂无详细描述。' }}</p>

        <!-- 能力标签 -->
        <div class="capability-tags">
          <span v-if="item.capabilities.sensorsCount > 0" class="cap-pill pill-proactive">
            <Radar :size="11" />
            <span>主动感知</span>
          </span>
          <span v-if="item.capabilities.skillsCount > 0" class="cap-pill pill-skill">
            <Zap :size="11" />
            <span>技能 ({{ item.capabilities.skillsCount }})</span>
          </span>
          <span v-if="item.capabilities.toolsCount > 0" class="cap-pill pill-tool">
            <Wrench :size="11" />
            <span>工具 ({{ item.capabilities.toolsCount }})</span>
          </span>
          <span v-if="item.capabilities.pagesCount > 0" class="cap-pill pill-page">
            <Layout :size="11" />
            <span>扩展页面</span>
          </span>
          <span v-if="item.capabilities.hasConfig" class="cap-pill pill-config">
            <SlidersHorizontal :size="11" />
            <span>配置项</span>
          </span>
        </div>

        <!-- 卡片操作区 -->
        <div class="card-footer">
          <div class="footer-meta">
            <span class="meta-ver">v{{ item.version }}</span>
            <span class="meta-pub">{{ item.publisher }}</span>
          </div>

          <div class="footer-actions">
            <AervoxButton
              variant="secondary"
              size="sm"
              :icon="Download"
              :loading="actionBusy === `export:${item.id}`"
              title="导出单文件分发包 (.aervox-plugin)"
              @click="handleExport(item)"
            >
              导出
            </AervoxButton>

            <AervoxButton
              v-if="item.installed"
              variant="secondary"
              size="sm"
              :icon="RefreshCw"
              :loading="actionBusy === item.id"
              @click="handleInstall(item)"
            >
              {{ item.hasUpdate ? '升级' : '重装' }}
            </AervoxButton>
            <AervoxButton
              v-else
              variant="primary"
              size="sm"
              :icon="ShoppingBag"
              :loading="actionBusy === item.id"
              @click="handleInstall(item)"
            >
              一键安装
            </AervoxButton>
          </div>
        </div>
      </AervoxCard>
    </div>
  </div>
</template>

<style scoped>
.plugin-market-tab {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.market-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.search-box {
  position: relative;
  flex: 1;
  min-width: 200px;
}
.search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted);
}
.search-input {
  width: 100%;
  box-sizing: border-box;

}
.search-input::placeholder {
  color: var(--text-muted);
}

.rotating {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

.market-loading,
.market-empty {
  padding: 36px 16px;
  text-align: center;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.5;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.market-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}

.market-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: border-color 0.22s ease, background-color 0.22s ease, transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.22s ease;
}
.market-card:hover {
  transform: translateY(-1px);
}
.card-installed {
  border-left: 3px solid #10b981;
}

.card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.card-title-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.card-id {
  font-size: 10px;
  padding: 1px 5px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.card-status-badge .badge {
  font-size: 10px;
  padding: 2px 7px;
  border-radius: 6px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.badge-installed {
  background: color-mix(in srgb, #10b981 14%, transparent);
  color: #10b981;
  border: 1px solid color-mix(in srgb, #10b981 28%, transparent);
}
.badge-update {
  background: color-mix(in srgb, #f59e0b 14%, transparent);
  color: #f59e0b;
  border: 1px solid color-mix(in srgb, #f59e0b 28%, transparent);
}
.badge-available {
  background: var(--bg-input);
  color: var(--text-muted);
  border: 1px solid var(--border);
}

.card-desc {
  font-size: 11px;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.capability-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.cap-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  padding: 2px 7px;
  border-radius: 6px;
  font-weight: 500;
  border: 1px solid transparent;
}
.pill-proactive {
  background: color-mix(in srgb, #ec4899 12%, transparent);
  color: #db2777;
  border-color: color-mix(in srgb, #ec4899 24%, transparent);
}
.pill-skill {
  background: color-mix(in srgb, #f59e0b 12%, transparent);
  color: #d97706;
  border-color: color-mix(in srgb, #f59e0b 24%, transparent);
}
.pill-tool {
  background: color-mix(in srgb, #4e77d1 12%, transparent);
  color: var(--accent);
  border-color: color-mix(in srgb, #4e77d1 24%, transparent);
}
.pill-page {
  background: color-mix(in srgb, #10b981 12%, transparent);
  color: #059669;
  border-color: color-mix(in srgb, #10b981 24%, transparent);
}
.pill-config {
  background: var(--bg-input);
  color: var(--text-secondary);
  border-color: var(--border);
}

.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  margin-top: auto;
}
.footer-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-muted);
}
.meta-ver {
  font-weight: 600;
  color: var(--text-primary);
}

.footer-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>
