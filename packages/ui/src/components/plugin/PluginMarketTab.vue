<script setup lang="ts">
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
import { AervoxButton } from '../../primitives'

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
          class="search-input"
        />
      </div>

      <div class="filter-segments" role="radiogroup">
        <button
          type="button"
          class="filter-seg-btn"
          :class="{ active: selectedFilter === 'all' }"
          @click="selectedFilter = 'all'"
        >
          全部 ({{ marketItems.length }})
        </button>
        <button
          type="button"
          class="filter-seg-btn"
          :class="{ active: selectedFilter === 'proactive' }"
          @click="selectedFilter = 'proactive'"
        >
          主动智能
        </button>
        <button
          type="button"
          class="filter-seg-btn"
          :class="{ active: selectedFilter === 'skills' }"
          @click="selectedFilter = 'skills'"
        >
          技能扩展
        </button>
        <button
          type="button"
          class="filter-seg-btn"
          :class="{ active: selectedFilter === 'tools' }"
          @click="selectedFilter = 'tools'"
        >
          工具/MCP
        </button>
        <button
          type="button"
          class="filter-seg-btn"
          :class="{ active: selectedFilter === 'pages' }"
          @click="selectedFilter = 'pages'"
        >
          扩展页面
        </button>
      </div>

      <button type="button" class="btn-refresh" :disabled="loading" @click="loadMarket">
        <RefreshCw :size="14" :class="{ rotating: loading }" />
      </button>
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
    <div v-else class="market-grid">
      <div
        v-for="item in filteredItems"
        :key="item.id"
        class="market-card"
        :class="{ 'card-installed': item.installed }"
      >
        <div class="card-header">
          <div class="card-title-group">
            <span class="card-title">{{ item.displayName || item.id }}</span>
            <code class="card-id">{{ item.id }}</code>
          </div>
          <div class="card-status-badge">
            <span v-if="item.hasUpdate" class="badge badge-update">可更新</span>
            <span v-else-if="item.installed" class="badge badge-installed">
              <CheckCircle2 :size="11" />
              <span>已安装</span>
            </span>
            <span v-else class="badge badge-available">出厂预设</span>
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
      </div>
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
  min-width: 220px;
}
.search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-secondary, #888);
}
.search-input {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 10px 6px 30px;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
  background: var(--bg-input, #fff);
  color: var(--text-primary, #111);
  font-size: 12px;
}
.search-input:focus {
  outline: none;
  border-color: var(--accent, #4f46e5);
}

.filter-segments {
  display: flex;
  background: var(--bg-surface-elevated, #f3f4f6);
  padding: 3px;
  border-radius: 8px;
  gap: 2px;
}
.filter-seg-btn {
  border: none;
  background: transparent;
  padding: 5px 10px;
  font-size: 11px;
  color: var(--text-secondary, #666);
  border-radius: 6px;
  cursor: pointer;
  font-weight: 500;
  transition: all 0.15s ease;
}
.filter-seg-btn.active {
  background: var(--bg-surface, #fff);
  color: var(--text-primary, #111);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}

.btn-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--border, #e5e7eb);
  background: var(--bg-surface, #fff);
  border-radius: 6px;
  color: var(--text-secondary, #666);
  cursor: pointer;
}
.btn-refresh:hover:not(:disabled) {
  border-color: var(--accent, #4f46e5);
  color: var(--accent, #4f46e5);
}
.rotating {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

.market-loading,
.market-empty {
  padding: 40px;
  text-align: center;
  color: var(--text-secondary, #888);
  font-size: 13px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.market-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}

.market-card {
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 12px;
  padding: 16px;
  background: var(--bg-surface, #fff);
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.market-card:hover {
  border-color: rgba(79, 70, 229, 0.3);
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.04);
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
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #111);
}
.card-id {
  font-size: 10px;
  color: var(--text-secondary, #888);
}

.card-status-badge .badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.badge-installed {
  background: rgba(16, 185, 129, 0.1);
  color: #059669;
}
.badge-update {
  background: rgba(245, 158, 11, 0.1);
  color: #d97706;
}
.badge-available {
  background: var(--bg-surface-elevated, #f3f4f6);
  color: var(--text-secondary, #666);
}

.card-desc {
  font-size: 12px;
  color: var(--text-secondary, #555);
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
  border-radius: 4px;
  font-weight: 500;
}
.pill-proactive {
  background: rgba(236, 72, 153, 0.08);
  color: #db2777;
}
.pill-skill {
  background: rgba(245, 158, 11, 0.08);
  color: #d97706;
}
.pill-tool {
  background: rgba(79, 70, 229, 0.08);
  color: #4f46e5;
}
.pill-page {
  background: rgba(16, 185, 129, 0.08);
  color: #059669;
}
.pill-config {
  background: var(--bg-surface-elevated, #f3f4f6);
  color: var(--text-secondary, #666);
}

.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 10px;
  border-top: 1px solid var(--border-soft, #f3f4f6);
  margin-top: auto;
}
.footer-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-secondary, #888);
}
.meta-ver {
  font-weight: 600;
  color: var(--text-primary, #333);
}

.footer-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>
