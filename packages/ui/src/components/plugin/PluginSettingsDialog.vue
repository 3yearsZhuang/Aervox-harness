<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  BookOpen,
  BrainCircuit,
  Download,
  FileText,
  Info,
  LayoutGrid,
  Play,
  Puzzle,
  Radar,
  RefreshCw,
  Settings,
  Shield,
  SlidersHorizontal,
  Terminal,
  Wrench,
  Zap,
} from 'lucide-vue-next'
import { ElMessage } from '../../utils/element'
import type { PluginConfigField } from '@aervox/contracts'
import {
  useAervoxPlugins,
  useAervoxSkills,
  useAervoxTools,
  type PluginGrantDto,
  type PluginPageDto,
  type PluginSummaryDto,
  type SkillDto,
  type ToolRegistrationDto,
} from '@aervox/api-client'
import { AervoxButton, AervoxDialog, aervoxConfirm } from '../../primitives'
import PluginConfigForm from './PluginConfigForm.vue'
import SkillContentDialog from './SkillContentDialog.vue'
import ToolCallDialog from './ToolCallDialog.vue'
import PluginPageDialog from './PluginPageDialog.vue'

const props = defineProps<{
  open: boolean
  plugin: PluginSummaryDto | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'saved'): void
  (e: 'change'): void
}>()

const pluginsApi = useAervoxPlugins()
const skillsApi = useAervoxSkills()
const toolsApi = useAervoxTools()

type TabKey = 'config' | 'skills' | 'tools' | 'proactive' | 'pages' | 'info'
const currentTab = ref<TabKey>('config')

// 配置相关状态
const fields = ref<PluginConfigField[]>([])
const values = ref<Record<string, unknown>>({})
const secretFields = ref<Record<string, { configured: boolean }>>({})
const secretValues = ref<Record<string, string | null>>({})
const revision = ref(0)
const configLoading = ref(false)
const configSaving = ref(false)
const issues = ref<Array<{ key: string; code: string; message: string }>>([])

// 技能与工具状态
const pluginSkills = ref<SkillDto[]>([])
const pluginTools = ref<ToolRegistrationDto[]>([])
const skillsLoading = ref(false)
const toolsLoading = ref(false)
const busySkillId = ref<string | null>(null)
const busyToolId = ref<string | null>(null)

// 技能内容弹窗
const contentDialogOpen = ref(false)
const selectedSkill = ref<SkillDto | null>(null)

// 工具调试弹窗
const callDialogOpen = ref(false)
const selectedTool = ref<ToolRegistrationDto | null>(null)

// 页面相关
const pluginPages = ref<PluginPageDto[]>([])
const pagesLoading = ref(false)
const pageDialogOpen = ref(false)
const pageTargetPage = ref<PluginPageDto | null>(null)

// 主动感知源相关
interface DeclaredSensor {
  sourceId: string
  description?: string
}
interface DeclaredTrigger {
  ruleId: string
  name: string
  triggerType: string
  condition?: Record<string, unknown>
  cooldownSeconds?: number
  quietHoursPolicy?: string
  petPresentation?: { animation?: string; bubblePreset?: string }
}
const sensorGrants = ref<Record<string, PluginGrantDto | null>>({})
const sensorBusy = ref<string | null>(null)

const declaredSensors = computed<DeclaredSensor[]>(() => {
  const spec = props.plugin?.proactiveSpecJson as { sensors?: DeclaredSensor[] } | null | undefined
  return Array.isArray(spec?.sensors) ? spec!.sensors! : []
})

const declaredTriggers = computed<DeclaredTrigger[]>(() => {
  const spec = props.plugin?.proactiveSpecJson as { triggers?: DeclaredTrigger[] } | null | undefined
  return Array.isArray(spec?.triggers) ? spec!.triggers! : []
})

const hasConfig = computed(() => Boolean(props.plugin?.configSchemaJson))
const hasProactive = computed(() => declaredSensors.value.length > 0 || declaredTriggers.value.length > 0)

// 插件声明的 MCP 预设列表
const declaredMcpServers = computed<string[]>(() => {
  const spec = (props.plugin as unknown as { spec?: { mcpServers?: string[] } })?.spec
  return Array.isArray(spec?.mcpServers) ? spec.mcpServers : []
})

async function loadConfigData(): Promise<void> {
  if (!props.plugin || !hasConfig.value) return
  configLoading.value = true
  issues.value = []
  try {
    const [schema, config] = await Promise.all([
      pluginsApi.getConfigSchema(props.plugin.id),
      pluginsApi.getConfig(props.plugin.id),
    ])
    fields.value = schema.fields
    values.value = config.values ?? {}
    secretFields.value = config.secretFields ?? {}
    secretValues.value = {}
    revision.value = config.revision ?? 0
  } catch (e) {
    console.error('加载插件配置失败', e)
  } finally {
    configLoading.value = false
  }
}

async function loadSkillsData(): Promise<void> {
  if (!props.plugin) return
  skillsLoading.value = true
  try {
    await skillsApi.loadSkills()
    pluginSkills.value = skillsApi.skills.value.filter(
      (s) => s.pluginId === props.plugin?.id || s.name === props.plugin?.id,
    )
  } catch (e) {
    console.error('加载插件技能失败', e)
  } finally {
    skillsLoading.value = false
  }
}

async function loadToolsData(): Promise<void> {
  if (!props.plugin) return
  toolsLoading.value = true
  try {
    await toolsApi.loadTools()
    const pluginId = props.plugin.id
    const mcpServers = declaredMcpServers.value
    pluginTools.value = toolsApi.tools.value.filter((t) => {
      if (t.pluginId === pluginId) return true
      if (t.pluginId && t.pluginId.startsWith('mcp:')) {
        const serverName = t.pluginId.slice(4)
        if (mcpServers.includes(serverName)) return true
      }
      return false
    })
  } catch (e) {
    console.error('加载插件工具失败', e)
  } finally {
    toolsLoading.value = false
  }
}

async function loadPagesData(): Promise<void> {
  if (!props.plugin) return
  pagesLoading.value = true
  try {
    pluginPages.value = await pluginsApi.listPages(props.plugin.id)
  } catch {
    pluginPages.value = []
  } finally {
    pagesLoading.value = false
  }
}

async function loadSensorsData(): Promise<void> {
  if (!props.plugin || declaredSensors.value.length === 0) return
  try {
    const grants = await pluginsApi.listSensorGrants(props.plugin.id)
    const next: Record<string, PluginGrantDto | null> = {}
    for (const sensor of declaredSensors.value) {
      next[sensor.sourceId] = grants.find((g) => g.scope === sensor.sourceId) ?? null
    }
    sensorGrants.value = next
  } catch (e) {
    console.error('加载感知源授权失败', e)
  }
}

async function initializeData(): Promise<void> {
  if (!props.open || !props.plugin) return
  // 智能决策默认 Tab
  if (hasConfig.value) {
    currentTab.value = 'config'
  } else if (hasProactive.value) {
    currentTab.value = 'proactive'
  } else {
    currentTab.value = 'info'
  }

  await Promise.all([
    loadConfigData(),
    loadSkillsData(),
    loadToolsData(),
    loadPagesData(),
    loadSensorsData(),
  ])

  // 如果默认不是 config 且无 config，自动跳转到有内容的 Tab
  if (!hasConfig.value) {
    if (pluginSkills.value.length > 0) currentTab.value = 'skills'
    else if (pluginTools.value.length > 0) currentTab.value = 'tools'
    else if (hasProactive.value) currentTab.value = 'proactive'
    else if (pluginPages.value.length > 0) currentTab.value = 'pages'
    else currentTab.value = 'info'
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      void initializeData()
    }
  },
  { immediate: true },
)

// 配置更新与保存
function updateValue(key: string, value: unknown): void {
  values.value = { ...values.value, [key]: value }
}

function updateSecret(key: string, value: string | null): void {
  secretValues.value = { ...secretValues.value, [key]: value }
}

async function saveConfig(): Promise<void> {
  if (!props.plugin) return
  configSaving.value = true
  issues.value = []
  try {
    const snapshot = await pluginsApi.saveConfig(props.plugin.id, {
      revision: revision.value,
      values: values.value,
      secretValues: secretValues.value,
    })
    revision.value = snapshot.revision
    values.value = snapshot.values ?? {}
    secretFields.value = snapshot.secretFields ?? {}
    secretValues.value = {}
    ElMessage.success('插件配置已保存')
    emit('saved')
    emit('change')
  } catch (e) {
    const message = e instanceof Error ? e.message : '保存失败'
    if (message.includes('REVISION_CONFLICT') || message.includes('409')) {
      ElMessage.error('配置已被其他设备修改，请重新打开后重试')
    } else {
      ElMessage.error(message)
    }
  } finally {
    configSaving.value = false
  }
}

async function resetConfig(): Promise<void> {
  if (!props.plugin) return
  const confirmed = await aervoxConfirm({
    title: '恢复默认配置？',
    message: '恢复默认值将清空全部插件配置（含密钥），确定继续吗？',
    variant: 'danger',
    confirmText: '恢复默认',
  })
  if (!confirmed) return
  configSaving.value = true
  try {
    const snapshot = await pluginsApi.resetConfig(props.plugin.id)
    revision.value = snapshot.revision
    values.value = snapshot.values ?? {}
    secretFields.value = snapshot.secretFields ?? {}
    secretValues.value = {}
    ElMessage.success('已恢复默认配置')
    emit('saved')
    emit('change')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '重置失败')
  } finally {
    configSaving.value = false
  }
}

// 技能操作
function isSkillActive(skill: SkillDto): boolean {
  return skill.active === 1 || skill.active === true
}

async function toggleSkillActive(skill: SkillDto): Promise<void> {
  const next = !isSkillActive(skill)
  busySkillId.value = skill.id || skill.name
  try {
    await skillsApi.setSkillActive(skill.id || skill.name, next)
    skill.active = next ? 1 : 0
    ElMessage.success(`已${next ? '启用' : '停用'}技能「${skill.name}」`)
    emit('change')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '切换技能状态失败')
  } finally {
    busySkillId.value = null
  }
}

function openSkillContent(skill: SkillDto): void {
  selectedSkill.value = skill
  contentDialogOpen.value = true
}

// 工具操作
function isToolEnabled(tool: ToolRegistrationDto): boolean {
  return tool.enabled === 1 || tool.enabled === true
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

async function toggleToolEnabled(tool: ToolRegistrationDto): Promise<void> {
  const next = !isToolEnabled(tool)
  busyToolId.value = tool.id
  try {
    await toolsApi.setToolEnabled(tool.id, next)
    tool.enabled = next ? 1 : 0
    ElMessage.success(`已${next ? '启用' : '停用'}工具「${tool.name}」`)
    emit('change')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '切换工具状态失败')
  } finally {
    busyToolId.value = null
  }
}

function openToolCall(tool: ToolRegistrationDto): void {
  selectedTool.value = tool
  callDialogOpen.value = true
}

// 感知源授权操作
async function toggleSensorGrant(sensor: DeclaredSensor): Promise<void> {
  if (!props.plugin) return
  const current = sensorGrants.value[sensor.sourceId]
  sensorBusy.value = sensor.sourceId
  try {
    if (current) {
      await pluginsApi.revokeSensorGrant(props.plugin.id, current.id)
      sensorGrants.value = { ...sensorGrants.value, [sensor.sourceId]: null }
      ElMessage.success(`已撤销 ${sensor.sourceId} 感知授权`)
    } else {
      const grant = await pluginsApi.grantSensor(props.plugin.id, sensor.sourceId)
      sensorGrants.value = { ...sensorGrants.value, [sensor.sourceId]: grant }
      ElMessage.success(`已授予 ${sensor.sourceId} 感知授权`)
    }
    emit('change')
  } catch (e) {
    ElMessage.error('切换感知源授权失败')
  } finally {
    sensorBusy.value = null
  }
}

// 页面操作
function openPage(page: PluginPageDto): void {
  pageTargetPage.value = page
  pageDialogOpen.value = true
}

const isExporting = ref(false)
async function handleExport(): Promise<void> {
  if (!props.plugin) return
  isExporting.value = true
  try {
    await pluginsApi.downloadPackage(props.plugin.id)
    ElMessage.success(`插件包导出成功: ${props.plugin.id}.aervox-plugin`)
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '导出插件包失败')
  } finally {
    isExporting.value = false
  }
}
</script>

<template>
  <AervoxDialog
    :model-value="open"
    :title="`${plugin?.id ?? ''} 插件能力与设置`"
    :subtitle="`${plugin?.publisher ?? ''}@${plugin?.version ?? ''} · 集中管理插件配置、技能与工具能力`"
    :icon="SlidersHorizontal"
    size="lg"
    @close="emit('close')"
  >
    <template #header-actions>
      <button
        v-if="plugin"
        type="button"
        class="header-action-btn plugin-export-btn"
        title="导出插件安装包 (.aervox-plugin)"
        :disabled="isExporting"
        @click="handleExport"
      >
        <Download :size="13" />
        <span>{{ isExporting ? '导出中...' : '导出分发包' }}</span>
      </button>
    </template>
    <div class="plugin-settings-layout">
      <!-- 左侧 / 顶部能力分类导航 -->
      <nav class="settings-subnav" role="tablist">
        <button
          v-if="hasConfig"
          type="button"
          role="tab"
          class="subnav-item"
          :class="{ active: currentTab === 'config' }"
          @click="currentTab = 'config'"
        >
          <Settings :size="15" />
          <span>运行配置</span>
        </button>

        <button
          type="button"
          role="tab"
          class="subnav-item"
          :class="{ active: currentTab === 'skills' }"
          @click="currentTab = 'skills'"
        >
          <Zap :size="15" />
          <span>专属技能</span>
          <span v-if="pluginSkills.length > 0" class="subnav-badge">{{ pluginSkills.length }}</span>
        </button>

        <button
          type="button"
          role="tab"
          class="subnav-item"
          :class="{ active: currentTab === 'tools' }"
          @click="currentTab = 'tools'"
        >
          <Wrench :size="15" />
          <span>工具与 MCP</span>
          <span v-if="pluginTools.length > 0" class="subnav-badge">{{ pluginTools.length }}</span>
        </button>

        <button
          v-if="hasProactive"
          type="button"
          role="tab"
          class="subnav-item"
          :class="{ active: currentTab === 'proactive' }"
          @click="currentTab = 'proactive'"
        >
          <BrainCircuit :size="15" />
          <span>主动智能</span>
          <span v-if="declaredSensors.length > 0" class="subnav-badge">{{ declaredSensors.length }}</span>
        </button>

        <button
          v-if="pluginPages.length > 0"
          type="button"
          role="tab"
          class="subnav-item"
          :class="{ active: currentTab === 'pages' }"
          @click="currentTab = 'pages'"
        >
          <LayoutGrid :size="15" />
          <span>扩展页面</span>
          <span class="subnav-badge">{{ pluginPages.length }}</span>
        </button>

        <button
          type="button"
          role="tab"
          class="subnav-item"
          :class="{ active: currentTab === 'info' }"
          @click="currentTab = 'info'"
        >
          <Info :size="15" />
          <span>基本信息</span>
        </button>
      </nav>

      <!-- 右侧内容呈现区 -->
      <div class="settings-tab-pane">
        <!-- 1. 运行配置 -->
        <section v-if="currentTab === 'config' && hasConfig" class="tab-pane-content">
          <div v-if="configLoading" class="settings-loading">加载配置中…</div>
          <div v-else-if="issues.length > 0" class="settings-issues">
            <p v-for="issue in issues" :key="issue.key" class="settings-issue">
              {{ issue.key }}: {{ issue.message }}
            </p>
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
        </section>

        <!-- 2. 专属技能 -->
        <section v-else-if="currentTab === 'skills'" class="tab-pane-content">
          <div class="section-banner">
            <Zap :size="16" />
            <span>以下为该插件内置声明的技能指令（由插件生命周期联动，随插件启停）。</span>
          </div>

          <div v-if="skillsLoading" class="settings-loading">加载技能列表中…</div>
          <div v-else-if="pluginSkills.length === 0" class="settings-empty">
            该插件未声明专有 Skill 技能。
          </div>
          <div v-else class="capability-list">
            <article v-for="skill in pluginSkills" :key="skill.id || skill.name" class="capability-item">
              <div class="capability-main">
                <div class="capability-header">
                  <strong>{{ skill.name }}</strong>
                  <span class="capability-tag is-readonly">插件内置·只读</span>
                  <span class="capability-tag is-source">{{ skill.source }}</span>
                </div>
                <p class="capability-desc">{{ skill.description || '暂无描述' }}</p>
              </div>
              <div class="capability-actions">
                <button
                  type="button"
                  class="action-btn"
                  title="查看 SKILL.md 全文"
                  @click="openSkillContent(skill)"
                >
                  <FileText :size="14" />
                  <span>查看说明</span>
                </button>
                <button
                  type="button"
                  class="settings-switch"
                  :class="{ checked: isSkillActive(skill) }"
                  :disabled="busySkillId === (skill.id || skill.name)"
                  :aria-label="`${isSkillActive(skill) ? '停用' : '启用'} ${skill.name}`"
                  @click="toggleSkillActive(skill)"
                />
              </div>
            </article>
          </div>
        </section>

        <!-- 3. 工具与 MCP -->
        <section v-else-if="currentTab === 'tools'" class="tab-pane-content">
          <div class="section-banner">
            <Wrench :size="16" />
            <span>以下为该插件声明的端点工具或绑定的 MCP 服务，可单独启停或调试调用。</span>
          </div>

          <div v-if="toolsLoading" class="settings-loading">加载工具列表中…</div>
          <div v-else-if="pluginTools.length === 0" class="settings-empty">
            该插件未声明任何专有工具或绑定 MCP 服务。
          </div>
          <div v-else class="capability-list">
            <article v-for="tool in pluginTools" :key="tool.id" class="capability-item">
              <div class="capability-main">
                <div class="capability-header">
                  <strong>{{ tool.name }}</strong>
                  <code class="tool-id">{{ tool.id }}</code>
                  <span class="capability-tag" :class="getSafetyLabel(tool.safetyLevel).class">
                    {{ getSafetyLabel(tool.safetyLevel).label }}
                  </span>
                  <span v-if="tool.pluginId?.startsWith('mcp:')" class="capability-tag is-mcp">
                    MCP 绑定
                  </span>
                </div>
                <p class="capability-desc">{{ tool.description || '暂无描述' }}</p>
              </div>
              <div class="capability-actions">
                <button
                  type="button"
                  class="action-btn"
                  title="调试调用该工具"
                  :disabled="!isToolEnabled(tool)"
                  @click="openToolCall(tool)"
                >
                  <Terminal :size="14" />
                  <span>调试</span>
                </button>
                <button
                  type="button"
                  class="settings-switch"
                  :class="{ checked: isToolEnabled(tool) }"
                  :disabled="busyToolId === tool.id"
                  :aria-label="`${isToolEnabled(tool) ? '停用' : '启用'} ${tool.name}`"
                  @click="toggleToolEnabled(tool)"
                />
              </div>
            </article>
          </div>
        </section>

        <!-- 4. 主动智能 -->
        <section v-else-if="currentTab === 'proactive'" class="tab-pane-content">
          <!-- 4.1 感知源授权 -->
          <div v-if="declaredSensors.length > 0" class="proactive-block">
            <div class="block-title">
              <Radar :size="15" />
              <strong>系统感知源授权 (Sensors)</strong>
              <small>未授权的感知源将被内核 fail-closed 阻断事件输入</small>
            </div>
            <ul class="sensor-list">
              <li v-for="sensor in declaredSensors" :key="sensor.sourceId" class="sensor-item">
                <div class="sensor-info">
                  <code>{{ sensor.sourceId }}</code>
                  <p>{{ sensor.description || '读取系统特定状态用于主动智能感知' }}</p>
                </div>
                <button
                  type="button"
                  class="settings-switch"
                  :class="{ checked: Boolean(sensorGrants[sensor.sourceId]) }"
                  :disabled="sensorBusy === sensor.sourceId"
                  :aria-label="`${sensorGrants[sensor.sourceId] ? '撤销' : '授予'} ${sensor.sourceId} 授权`"
                  @click="toggleSensorGrant(sensor)"
                />
              </li>
            </ul>
          </div>

          <!-- 4.2 声明式触发规则 -->
          <div v-if="declaredTriggers.length > 0" class="proactive-block">
            <div class="block-title">
              <BrainCircuit :size="15" />
              <strong>主动触发规则与桌宠表现 (Triggers & Presentation)</strong>
              <small>由 Worker 防打扰裁决器进行节流与触发</small>
            </div>
            <ul class="trigger-list">
              <li v-for="trig in declaredTriggers" :key="trig.ruleId" class="trigger-item">
                <div class="trigger-header">
                  <strong>{{ trig.name }}</strong>
                  <code>{{ trig.ruleId }}</code>
                  <span class="trigger-type-tag">{{ trig.triggerType }}</span>
                  <span v-if="trig.cooldownSeconds" class="trigger-cd-tag">冷却: {{ trig.cooldownSeconds }}s</span>
                </div>
                <div v-if="trig.petPresentation" class="trigger-presentation">
                  <span>桌宠动画: <code>{{ trig.petPresentation.animation || 'stretch_body' }}</code></span>
                  <span>气泡预设: <code>{{ trig.petPresentation.bubblePreset || 'gentle_care' }}</code></span>
                </div>
              </li>
            </ul>
          </div>
        </section>

        <!-- 5. 扩展页面 -->
        <section v-else-if="currentTab === 'pages'" class="tab-pane-content">
          <div class="section-banner">
            <LayoutGrid :size="16" />
            <span>该插件包含基于 iframe 沙箱的独立受控扩展页面，可通过 Bridge 与工作台安全交互。</span>
          </div>
          <div class="capability-list">
            <article v-for="page in pluginPages" :key="page.id" class="capability-item">
              <div class="capability-main">
                <div class="capability-header">
                  <strong>{{ page.title || page.id }}</strong>
                  <code class="tool-id">{{ page.id }}</code>
                </div>
                <p class="capability-desc">{{ page.description || '无描述页面' }}</p>
              </div>
              <div class="capability-actions">
                <button
                  type="button"
                  class="action-btn is-primary"
                  @click="openPage(page)"
                >
                  <Play :size="14" />
                  <span>打开页面</span>
                </button>
              </div>
            </article>
          </div>
        </section>

        <!-- 6. 基本信息 -->
        <section v-else class="tab-pane-content info-pane">
          <div class="info-card">
            <div class="info-row">
              <span class="info-label">插件标识:</span>
              <code class="info-val">{{ plugin?.id }}</code>
            </div>
            <div class="info-row">
              <span class="info-label">版本:</span>
              <span class="info-val">{{ plugin?.version }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">发布者:</span>
              <span class="info-val">{{ plugin?.publisher }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">安装来源:</span>
              <span class="info-val">{{ plugin?.installSource }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">运行状态:</span>
              <span class="info-val" :class="{ 'is-enabled': plugin?.enabled === 1 }">
                {{ plugin?.enabled === 1 ? '已启用' : '已停用' }}
              </span>
            </div>
            <div v-if="pluginSkills.length > 0" class="info-row">
              <span class="info-label">专属技能:</span>
              <span class="info-val">{{ pluginSkills.map((s) => s.name).join(', ') }}</span>
            </div>
            <div v-if="pluginTools.length > 0" class="info-row">
              <span class="info-label">专属工具:</span>
              <span class="info-val">{{ pluginTools.map((t) => t.name).join(', ') }}</span>
            </div>
          </div>
        </section>
      </div>
    </div>

    <template #footer>
      <template v-if="currentTab === 'config' && hasConfig">
        <AervoxButton variant="secondary" :disabled="configSaving" @click="resetConfig">恢复默认</AervoxButton>
        <AervoxButton variant="secondary" @click="emit('close')">取消</AervoxButton>
        <AervoxButton variant="primary" :loading="configSaving" @click="saveConfig">保存配置</AervoxButton>
      </template>
      <template v-else>
        <AervoxButton variant="secondary" @click="emit('close')">关闭</AervoxButton>
      </template>
    </template>

    <!-- 子弹窗 -->
    <SkillContentDialog
      :open="contentDialogOpen"
      :skill="selectedSkill"
      @close="contentDialogOpen = false"
    />
    <ToolCallDialog
      :open="callDialogOpen"
      :tool="selectedTool"
      @close="callDialogOpen = false"
    />
    <PluginPageDialog
      :open="pageDialogOpen"
      :plugin="plugin"
      :page="pageTargetPage"
      @close="pageDialogOpen = false"
    />
  </AervoxDialog>
</template>

<style scoped>
.plugin-settings-layout {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 16px;
  min-height: 380px;
}

.settings-subnav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-right: 1px solid var(--border);
  padding-right: 12px;
}

.subnav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  transition: all 0.18s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
}

.subnav-item:hover {
  background: color-mix(in srgb, var(--bg-soft) 70%, transparent);
  color: var(--text-primary);
}

.subnav-item.active {
  background: var(--bg-soft);
  color: var(--accent);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  font-weight: 600;
}

.subnav-badge {
  margin-left: auto;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  color: var(--accent);
}

.settings-tab-pane {
  overflow-y: auto;
  max-height: 520px;
  padding-right: 4px;
}

.tab-pane-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.section-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent-soft) 45%, transparent);
  border: 1px dashed color-mix(in srgb, var(--accent) 30%, var(--border));
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.4;
}

.capability-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.capability-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  gap: 12px;
  transition: border-color 0.2s ease;
}
.capability-item:hover {
  border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
}

.capability-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.capability-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.capability-header strong {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.capability-desc {
  margin: 0;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.4;
}

.capability-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.capability-tag {
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--bg-input);
  color: var(--text-secondary);
  border: 1px solid var(--border);
}

.capability-tag.is-readonly {
  background: var(--bg-input);
  color: var(--text-muted);
}

.capability-tag.is-mcp {
  background: color-mix(in srgb, #06b6d4 14%, transparent);
  color: #0891b2;
  border-color: color-mix(in srgb, #06b6d4 28%, transparent);
}

.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.action-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(78, 119, 209, 0.15);
}

.action-btn.is-primary {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}
.action-btn.is-primary:hover:not(:disabled) {
  opacity: 0.92;
  box-shadow: 0 3px 8px rgba(78, 119, 209, 0.25);
}

.action-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  background: var(--bg-soft);
  color: var(--text-muted);
  border-color: var(--border);
  box-shadow: none;
  transform: none;
}

.tool-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 10px;
  color: var(--text-muted);
  background: var(--bg-input);
  border: 1px solid var(--border);
  padding: 1px 5px;
  border-radius: 4px;
}

/* 主动智能卡片 */
.proactive-block {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--bg-soft);
}

.block-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.block-title small {
  color: var(--text-muted);
  font-size: 10px;
}

.sensor-list, .trigger-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sensor-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--bg-input);
  border: 1px solid var(--border);
}

.sensor-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sensor-id {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.sensor-desc {
  font-size: 10px;
  color: var(--text-muted);
}

.trigger-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg-input);
  border: 1px solid var(--border);
}

.trigger-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 500;
}

.trigger-header strong {
  color: var(--text-primary);
}

.trigger-meta {
  display: flex;
  gap: 16px;
  font-size: 11px;
  color: var(--text-muted);
}

.trigger-presentation code {
  color: var(--text-primary);
  font-weight: 500;
}

.settings-loading, .settings-empty {
  padding: 36px 16px;
  text-align: center;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.5;
}

.info-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-radius: 12px;
  background: var(--bg-soft);
  border: 1px solid var(--border);
}

.info-row {
  display: flex;
  align-items: center;
  font-size: 12px;
}

.info-label {
  width: 90px;
  color: var(--text-muted);
}

.info-val {
  color: var(--text-primary);
  font-weight: 500;
}

.info-val.is-enabled {
  color: #10b981;
}

/* 契约安全等级样式 */
.safety-read-only { color: #10b981; background: color-mix(in srgb, #10b981 14%, transparent); border: 1px solid color-mix(in srgb, #10b981 28%, transparent); }
.safety-approval { color: #f59e0b; background: color-mix(in srgb, #f59e0b 14%, transparent); border: 1px solid color-mix(in srgb, #f59e0b 28%, transparent); }
.safety-privileged { color: var(--danger); background: var(--danger-soft); border: 1px solid color-mix(in srgb, var(--danger) 28%, transparent); }

/* 对话框头部动作按钮 */
.header-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.header-action-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(78, 119, 209, 0.15);
}

.header-action-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
