<script setup lang="ts">
import {onMounted, ref} from 'vue'
import {Puzzle, Settings, LayoutGrid} from 'lucide-vue-next'
import {useAervoxPlugins, type PluginPageDto, type PluginSummaryDto} from '@aervox/api-client'
import PluginConfigDialog from './PluginConfigDialog.vue'
import PluginPageDialog from './PluginPageDialog.vue'

const api = useAervoxPlugins()
const {plugins, loading, error, loadPlugins, setPluginEnabled, listPages} = api
const configTarget = ref<PluginSummaryDto | null>(null)
const configOpen = ref(false)
const pageTarget = ref<PluginSummaryDto | null>(null)
const pageOpen = ref(false)
const pageTargetPage = ref<PluginPageDto | null>(null)
const pageBusy = ref<string | null>(null)

onMounted(() => {
  void api.loadPlugins()
})

async function toggleEnabled(plugin: PluginSummaryDto): Promise<void> {
  try {
    await setPluginEnabled(plugin.id, plugin.enabled !== 1)
    await loadPlugins()
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
      <span><Puzzle :size="19" /><span><strong>插件</strong><small>管理已安装插件、配置与页面</small></span></span>
    </div>

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
          <button v-if="plugin.configSchemaJson" type="button" class="plugin-action" title="配置" @click="openConfig(plugin)">
            <Settings :size="15" />配置
          </button>
          <button type="button" class="plugin-action" title="页面" :disabled="pageBusy === plugin.id" @click="openPage(plugin)">
            <LayoutGrid :size="15" />页面
          </button>
        </div>
      </article>
    </div>

    <PluginConfigDialog
      :open="configOpen"
      :plugin="configTarget"
      @close="configOpen = false"
      @saved="loadPlugins"
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
}
.plugin-card-icon {
  width: 36px; height: 36px; flex: 0 0 36px;
  display: grid; place-items: center;
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent);
}
.plugin-card-main { min-width: 0; flex: 1; display: grid; gap: 3px; }
.plugin-card-main strong { color: var(--text-primary); font-size: 12px; }
.plugin-card-main small { color: var(--text-muted); font-size: 10px; }
.plugin-card-actions { display: flex; align-items: center; gap: 8px; }
.plugin-toggle { width: 39px; height: 23px; flex: 0 0 39px; }
.plugin-action {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 10px;
  cursor: pointer;
}
.plugin-action:hover { border-color: var(--accent); color: var(--accent); }
.plugin-action:disabled { opacity: .5; cursor: default; }
</style>
