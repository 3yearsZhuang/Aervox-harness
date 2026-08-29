<script setup lang="ts">
import {onMounted, ref} from 'vue'
import {Puzzle, Settings, LayoutGrid, Zap, Wrench} from 'lucide-vue-next'
import {useAervoxPlugins, type PluginPageDto, type PluginSummaryDto} from '@aervox/api-client'
import PluginConfigDialog from './PluginConfigDialog.vue'
import PluginPageDialog from './PluginPageDialog.vue'
import SkillManagerTab from './SkillManagerTab.vue'
import McpToolsTab from './McpToolsTab.vue'

type ExtensionSubTab = 'plugins' | 'skills' | 'mcp'
const currentTab = ref<ExtensionSubTab>('plugins')

const api = useAervoxPlugins()
const {plugins, loading, error, setPluginEnabled, listPages} = api
const configTarget = ref<PluginSummaryDto | null>(null)
const configOpen = ref(false)
const pageTarget = ref<PluginSummaryDto | null>(null)
const pageOpen = ref(false)
const pageTargetPage = ref<PluginPageDto | null>(null)
const pageBusy = ref<string | null>(null)

/** 已提供 Page 资源的插件 ID 集合（无页面时隐藏「页面」按钮） */
const pluginsWithPages = ref<Set<string>>(new Set())

async function refresh(): Promise<void> {
  await api.loadPlugins()
  // 逐个查询插件页面元数据，仅记录有页面的插件
  const withPages = new Set<string>()
  await Promise.all(plugins.value.map(async (plugin) => {
    try {
      const pages = await listPages(plugin.id)
      if (pages.length > 0) withPages.add(plugin.id)
    } catch {
      // 插件被禁用或页面查询失败时忽略
    }
  }))
  pluginsWithPages.value = withPages
}

onMounted(() => {
  void refresh()
})

async function toggleEnabled(plugin: PluginSummaryDto): Promise<void> {
  try {
    await setPluginEnabled(plugin.id, plugin.enabled !== 1)
    await refresh()
  } catch (e) {
    console.error('切换插件状态失败', e)
  }
}

function openConfig(plugin: PluginSummaryDto): void {
  configTarget.value = plugin
  configOpen.value = true
}

async function openPage(plugin: PluginSummaryDto): Promise<void> {
  pageBusy.value = plugin.id
  try {
    const pages = await listPages(plugin.id)
    const first = pages[0]
    if (!first) {
      window.alert('该插件没有可用的页面')
      return
    }
    pageTarget.value = plugin
    pageTargetPage.value = first
    pageOpen.value = true
  } finally {
    pageBusy.value = null
  }
}

function openConfigFromPage(): void {
  pageOpen.value = false
  if (pageTarget.value) openConfig(pageTarget.value)
}
</script>

<template>
  <div class="plugin-manager">
    <div class="settings-section-heading">
      <span class="heading-icon-wrap"><Puzzle :size="18" /></span>
      <span><strong>扩展与插件</strong><small>管理插件、技能包 (Skills) 与 MCP 工具端点</small></span>
    </div>

    <!-- 二级导航切换 Tab -->
    <div class="plugin-subtabs" role="tablist" aria-label="扩展功能分类">
      <button
        type="button"
        role="tab"
        class="subtab-btn"
        :class="{active: currentTab === 'plugins'}"
        :aria-selected="currentTab === 'plugins'"
        @click="currentTab = 'plugins'"
      >
        <Puzzle :size="15" />
        <span>插件 (Plugins)</span>
      </button>
      <button
        type="button"
        role="tab"
        class="subtab-btn"
        :class="{active: currentTab === 'skills'}"
        :aria-selected="currentTab === 'skills'"
        @click="currentTab = 'skills'"
      >
        <Zap :size="15" />
        <span>技能 (Skills)</span>
      </button>
      <button
        type="button"
        role="tab"
        class="subtab-btn"
        :class="{active: currentTab === 'mcp'}"
        :aria-selected="currentTab === 'mcp'"
        @click="currentTab = 'mcp'"
      >
        <Wrench :size="15" />
        <span>MCP / 工具 (Tools)</span>
      </button>
    </div>

    <!-- Tab 1: 插件管理 -->
    <div v-if="currentTab === 'plugins'" class="plugins-tab-content">
      <div v-if="loading" class="pcfg-loading">加载插件…</div>
      <p v-else-if="error" class="plugin-empty">{{ api.error.value }}</p>
      <p v-else-if="plugins.length === 0" class="plugin-empty">还没有安装插件。插件安装后，可在这里配置与打开页面。</p>

      <div v-else class="plugin-list">
        <article v-for="plugin in plugins" :key="plugin.id" class="plugin-card">
          <span class="plugin-card-icon"><Puzzle :size="18" /></span>
          <div class="plugin-card-main">
            <strong>{{ plugin.id }}</strong>
            <small>{{ plugin.publisher }}@{{ plugin.version }} · {{ plugin.enabled === 1 ? '已启用' : '已停用' }}</small>
          </div>
          <div class="plugin-card-actions">
            <button
              type="button"
              class="settings-switch plugin-toggle"
              :class="{checked: plugin.enabled === 1}"
              :aria-label="`${plugin.enabled === 1 ? '停用' : '启用'} ${plugin.id}`"
              @click="toggleEnabled(plugin)"
            />
            <button v-if="plugin.configSchemaJson && plugin.enabled === 1" type="button" class="plugin-action" title="配置" @click="openConfig(plugin)">
              <Settings :size="15" />配置
            </button>
            <button v-if="pluginsWithPages.has(plugin.id)" type="button" class="plugin-action" title="页面" :disabled="pageBusy === plugin.id" @click="openPage(plugin)">
              <LayoutGrid :size="15" />页面
            </button>
          </div>
        </article>
      </div>
    </div>

    <!-- Tab 2: 技能库管理 -->
    <SkillManagerTab v-else-if="currentTab === 'skills'" />

    <!-- Tab 3: MCP / 工具管理 -->
    <McpToolsTab v-else-if="currentTab === 'mcp'" />

    <PluginConfigDialog
      :open="configOpen"
      :plugin="configTarget"
      @close="configOpen = false"
      @saved="refresh"
    />
    <PluginPageDialog
      :open="pageOpen"
      :plugin="pageTarget"
      :page="pageTargetPage"
      @close="pageOpen = false"
      @open-config="openConfigFromPage"
    />
  </div>
</template>

<style scoped>
.plugin-manager { display: grid; gap: 14px; }
.plugin-subtabs {
  display: flex;
  gap: 6px;
  padding: 4px;
  border-radius: 10px;
  background: var(--bg-input);
  border: 1px solid var(--border);
}
.subtab-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.subtab-btn:hover {
  color: var(--text-primary);
  background: color-mix(in srgb, var(--bg-soft) 70%, transparent);
}
.subtab-btn.active {
  background: var(--bg-soft);
  color: var(--accent);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
  font-weight: 600;
}
.plugins-tab-content {
  display: grid;
  gap: 14px;
}
.plugin-empty { padding: 26px 0; text-align: center; color: var(--text-muted); font-size: 11px; }
.plugin-list { display: grid; gap: 10px; }
.plugin-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-soft);
  transition: border-color 0.22s ease, background-color 0.22s ease, transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.22s ease;
}
.plugin-card:hover {
  border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
  background: color-mix(in srgb, var(--bg-soft) 85%, var(--accent-soft));
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(15, 20, 32, 0.05);
}
.plugin-card-icon {
  width: 36px; height: 36px; flex: 0 0 36px;
  display: grid; place-items: center;
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent);
  transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1), background-color 0.22s ease;
}
.plugin-card:hover .plugin-card-icon {
  transform: scale(1.05);
}
.plugin-card-main { min-width: 0; flex: 1; display: grid; gap: 3px; }
.plugin-card-main strong { color: var(--text-primary); font-size: 12px; }
.plugin-card-main small { color: var(--text-muted); font-size: 10px; }
.plugin-card-actions { display: flex; align-items: center; gap: 8px; }
.plugin-toggle { width: 40px; height: 22px; flex: 0 0 40px; }
.plugin-action {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 10px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.plugin-action:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(78, 119, 209, 0.15);
}
.plugin-action:active:not(:disabled) {
  transform: translateY(0) scale(0.97);
}
.plugin-action:disabled { opacity: .5; cursor: default; }
</style>
