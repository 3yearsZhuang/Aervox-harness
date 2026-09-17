<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from '../../utils/element'
import {
  PackagePlus,
  UploadCloud,
  FileArchive,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Sparkles,
  Zap,
  Wrench,
  Layout,
  Sliders,
} from 'lucide-vue-next'
import { useAervoxPlugins, type PluginPackageInspectionDto } from '@aervox/api-client'
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

type InstallMode = 'package' | 'manual'
const currentMode = ref<InstallMode>('package')

// ── 模式 1：离线包上传与预检 ─────────────────────────────────
const fileInputRef = ref<HTMLInputElement | null>(null)
const selectedFile = ref<File | null>(null)
const packageBase64 = ref<string>('')
const inspecting = ref(false)
const inspection = ref<PluginPackageInspectionDto | null>(null)
const inspectionError = ref<string | null>(null)
const overwrite = ref(false)
const installingPackage = ref(false)

function triggerFileSelect() {
  fileInputRef.value?.click()
}

function handleFileDrop(e: DragEvent) {
  e.preventDefault()
  const files = e.dataTransfer?.files
  if (files && files.length > 0 && files[0]) {
    processFile(files[0])
  }
}

function handleFileChange(e: Event) {
  const target = e.target as HTMLInputElement
  if (target.files && target.files.length > 0 && target.files[0]) {
    processFile(target.files[0])
  }
}

async function processFile(file: File): Promise<void> {
  if (!file.name.endsWith('.aervox-plugin') && !file.name.endsWith('.zip')) {
    ElMessage.warning('仅支持 .aervox-plugin 或 .zip 格式的插件分发包')
    return
  }
  selectedFile.value = file
  inspecting.value = true
  inspectionError.value = null
  inspection.value = null

  try {
    const arrayBuffer = await file.arrayBuffer()
    const bytes = new Uint8Array(arrayBuffer)
    let binary = ''
    const len = bytes.byteLength
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]!)
    }
    const b64 = btoa(binary)
    packageBase64.value = b64

    const result = await api.inspectPackage(b64)
    if (!result.isValid) {
      inspectionError.value = result.issues.join('；') || '分发包格式校验失败'
    } else {
      inspection.value = result
      overwrite.value = result.alreadyInstalled
    }
  } catch (e) {
    inspectionError.value = e instanceof Error ? e.message : '解析分发包失败'
  } finally {
    inspecting.value = false
  }
}

function resetPackageState() {
  selectedFile.value = null
  packageBase64.value = ''
  inspection.value = null
  inspectionError.value = null
  overwrite.value = false
  if (fileInputRef.value) fileInputRef.value.value = ''
}

async function handlePackageInstall(): Promise<void> {
  if (!packageBase64.value || !inspection.value) return
  installingPackage.value = true
  try {
    await api.installPackage(packageBase64.value, overwrite.value)
    ElMessage.success(`插件「${inspection.value.displayName || inspection.value.id}」安装成功`)
    resetPackageState()
    emit('installed')
    emit('close')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '安装插件包失败')
  } finally {
    installingPackage.value = false
  }
}

function formatSensorsSummary(sensors: Array<{ sourceId: string }>): string {
  return sensors.map((s) => s.sourceId).join(', ')
}

// ── 模式 2：手动 JSON 声明 ───────────────────────────────────
const pluginId = ref('')
const publisher = ref('')
const version = ref('')
const rawPermissions = ref('[]')
const rawTools = ref('')
const rawSkills = ref('')
const savingManual = ref(false)

function resetManualForm() {
  pluginId.value = ''
  publisher.value = ''
  version.value = ''
  rawPermissions.value = '[]'
  rawTools.value = ''
  rawSkills.value = ''
}

async function handleManualInstall(): Promise<void> {
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

  savingManual.value = true
  try {
    await api.installPlugin({ ...result.payload, installSource: 'manual' })
    ElMessage.success('插件安装成功')
    resetManualForm()
    emit('installed')
    emit('close')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '安装插件失败')
  } finally {
    savingManual.value = false
  }
}
</script>

<template>
  <AervoxDialog
    :model-value="open"
    title="安装插件"
    subtitle="支持离线分发包 (.aervox-plugin / .zip) 安装预检，或开发者手动声明"
    :icon="PackagePlus"
    size="md"
    @close="emit('close')"
  >
    <div class="install-dialog-body">
      <!-- 模式切换分段导航 -->
      <div class="install-mode-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          class="mode-tab-btn"
          :class="{ active: currentMode === 'package' }"
          @click="currentMode = 'package'"
        >
          <FileArchive :size="14" />
          <span>离线安装包 (推荐)</span>
        </button>
        <button
          type="button"
          role="tab"
          class="mode-tab-btn"
          :class="{ active: currentMode === 'manual' }"
          @click="currentMode = 'manual'"
        >
          <Sliders :size="14" />
          <span>开发者手动声明 (JSON)</span>
        </button>
      </div>

      <!-- 模式 1：离线包上传与安装前预检 (CAP-020) -->
      <div v-if="currentMode === 'package'" class="package-mode-wrap">
        <input
          ref="fileInputRef"
          type="file"
          accept=".aervox-plugin,.zip"
          style="display: none"
          @change="handleFileChange"
        />

        <!-- 初始上传区域 -->
        <div
          v-if="!inspection && !inspecting"
          class="package-dropzone"
          @click="triggerFileSelect"
          @dragover.prevent
          @drop="handleFileDrop"
        >
          <div class="dropzone-icon">
            <UploadCloud :size="36" />
          </div>
          <div class="dropzone-text">
            <strong>点击选取文件或拖拽到此处</strong>
            <span>支持 <code>.aervox-plugin</code> 或 <code>.zip</code> 插件包</span>
          </div>
          <div v-if="inspectionError" class="inspection-error-banner">
            <AlertTriangle :size="15" />
            <span>{{ inspectionError }}</span>
          </div>
        </div>

        <!-- 预检中转圈态 -->
        <div v-else-if="inspecting" class="inspecting-state">
          <div class="spinner" />
          <span>正在对安装包进行内存安全预检与完整性校验…</span>
        </div>

        <!-- PRD CAP-020 安装前预检卡片 -->
        <div v-else-if="inspection" class="inspection-result-card">
          <div class="inspection-header">
            <div class="header-main">
              <span class="plugin-title">{{ inspection.displayName || inspection.id }}</span>
              <span class="plugin-id-tag"><code>{{ inspection.id }}</code></span>
            </div>
            <div class="header-badges">
              <span class="badge version-badge">v{{ inspection.version }}</span>
              <span class="badge pub-badge">{{ inspection.publisher }}</span>
              <span v-if="inspection.license" class="badge license-badge">{{ inspection.license }}</span>
            </div>
          </div>

          <p v-if="inspection.description" class="inspection-desc">
            {{ inspection.description }}
          </p>

          <!-- 完整性校验与安全门禁说明 -->
          <div class="security-gate-banner">
            <div class="sec-left">
              <ShieldCheck :size="16" class="sec-icon" />
              <span>SHA-256 完整性校验：</span>
            </div>
            <code class="sec-hash" :title="inspection.checksum">{{ inspection.checksum.slice(0, 16) }}…{{ inspection.checksum.slice(-8) }}</code>
          </div>

          <!-- 权限与数据范围 (PRD CAP-020 核心验收) -->
          <div class="permissions-section">
            <div class="sec-title">
              <ShieldCheck :size="14" />
              <span>权限与数据范围要求（默认无多余系统越权）：</span>
            </div>
            <div v-if="inspection.dataScope.length > 0" class="scope-badges">
              <span v-for="(scope, idx) in inspection.dataScope" :key="idx" class="scope-badge">
                {{ scope }}
              </span>
            </div>
            <div v-else class="empty-scope">本插件未声明任何敏感系统权限。</div>

            <div v-if="inspection.proactive.sensors.length > 0" class="sensor-warning-box">
              <AlertTriangle :size="14" class="sensor-warn-icon" />
              <span>包含主动感知源（{{ formatSensorsSummary(inspection.proactive.sensors) }}），安装后需由您显式授权方可启动感知。</span>
            </div>
          </div>

          <!-- 包含的能力明细汇总 -->
          <div class="capabilities-grid">
            <div class="cap-item" :class="{ empty: inspection.skills.length === 0 }">
              <div class="cap-header">
                <Zap :size="13" />
                <span>包含技能 ({{ inspection.skills.length }})</span>
              </div>
              <div v-if="inspection.skills.length > 0" class="cap-names">
                <span v-for="s in inspection.skills" :key="s.name" class="cap-tag">
                  {{ s.name }}
                </span>
              </div>
            </div>

            <div class="cap-item" :class="{ empty: inspection.tools.length === 0 }">
              <div class="cap-header">
                <Wrench :size="13" />
                <span>包含工具 ({{ inspection.tools.length }})</span>
              </div>
              <div v-if="inspection.tools.length > 0" class="cap-names">
                <span v-for="t in inspection.tools" :key="t.name" class="cap-tag">
                  {{ t.name }}
                </span>
              </div>
            </div>

            <div class="cap-item" :class="{ empty: inspection.pages.length === 0 }">
              <div class="cap-header">
                <Layout :size="13" />
                <span>扩展页面 ({{ inspection.pages.length }})</span>
              </div>
              <div v-if="inspection.pages.length > 0" class="cap-names">
                <span v-for="p in inspection.pages" :key="p.id" class="cap-tag">
                  {{ p.id }}
                </span>
              </div>
            </div>
          </div>

          <!-- 重复安装覆盖选项 -->
          <div v-if="inspection.alreadyInstalled" class="overwrite-section">
            <label class="overwrite-checkbox-label">
              <input v-model="overwrite" type="checkbox" />
              <span>当前已安装该插件 (v{{ inspection.installedVersion }})，确认覆盖替换</span>
            </label>
          </div>
        </div>
      </div>

      <!-- 模式 2：手动 JSON 声明 -->
      <div v-else class="manual-mode-wrap">
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
            <label class="field-label" for="plugin-permissions-input">权限声明 (JSON)</label>
            <textarea
              id="plugin-permissions-input"
              v-model="rawPermissions"
              class="textarea-control"
              rows="2"
              spellcheck="false"
              placeholder='["fs.read", "net.fetch"]'
            />
          </div>

          <div class="field-block full-width">
            <label class="field-label" for="plugin-tools-input">声明工具 (JSON 数组)</label>
            <textarea
              id="plugin-tools-input"
              v-model="rawTools"
              class="textarea-control"
              rows="3"
              spellcheck="false"
              placeholder='例：[{"name": "search_notes", "description": "检索学习笔记", "category": "search", "safetyLevel": "read_only"}]'
            />
          </div>

          <div class="field-block full-width">
            <label class="field-label" for="plugin-skills-input">声明技能 (JSON 数组)</label>
            <textarea
              id="plugin-skills-input"
              v-model="rawSkills"
              class="textarea-control"
              rows="3"
              spellcheck="false"
              placeholder='例：[{"name": "note-taking", "content": "---\ndescription: 记笔记\n---\n…"}]'
            />
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <div v-if="currentMode === 'package' && inspection" class="package-footer-left">
        <AervoxButton variant="secondary" :icon="RotateCcw" @click="resetPackageState">
          重选文件
        </AervoxButton>
      </div>
      <AervoxButton variant="secondary" @click="emit('close')">取消</AervoxButton>
      <AervoxButton
        v-if="currentMode === 'package'"
        variant="primary"
        :icon="PackagePlus"
        :loading="installingPackage"
        :disabled="!inspection || (inspection.alreadyInstalled && !overwrite)"
        @click="handlePackageInstall"
      >
        确认安全安装
      </AervoxButton>
      <AervoxButton
        v-else
        variant="primary"
        :icon="PackagePlus"
        :loading="savingManual"
        @click="handleManualInstall"
      >
        提交安装
      </AervoxButton>
    </template>
  </AervoxDialog>
</template>

<style scoped>
.install-dialog-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.install-mode-tabs {
  display: flex;
  background: var(--bg-surface-elevated, #f1f3f5);
  padding: 3px;
  border-radius: 8px;
  gap: 3px;
}
.mode-tab-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  background: transparent;
  color: var(--text-secondary, #666);
  font-size: 12px;
  font-weight: 500;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.mode-tab-btn.active {
  background: var(--bg-surface, #fff);
  color: var(--text-primary, #111);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.package-dropzone {
  border: 2px dashed var(--border, #ddd);
  border-radius: 12px;
  padding: 32px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  text-align: center;
  cursor: pointer;
  transition: border-color 0.2s, background-color 0.2s;
  background: var(--bg-surface-soft, rgba(0, 0, 0, 0.01));
}
.package-dropzone:hover {
  border-color: var(--accent, #4f46e5);
  background: var(--bg-surface-elevated, rgba(0, 0, 0, 0.03));
}
.dropzone-icon {
  color: var(--accent, #4f46e5);
}
.dropzone-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: var(--text-primary, #222);
}
.dropzone-text span {
  font-size: 11px;
  color: var(--text-secondary, #666);
}

.inspection-error-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--danger, #dc2626);
  font-size: 12px;
  padding: 6px 12px;
  background: rgba(220, 38, 38, 0.08);
  border-radius: 6px;
}

.inspecting-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 40px 20px;
  color: var(--text-secondary, #666);
  font-size: 12px;
}
.spinner {
  width: 24px;
  height: 24px;
  border: 3px solid rgba(0, 0, 0, 0.1);
  border-top-color: var(--accent, #4f46e5);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

.inspection-result-card {
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 10px;
  padding: 16px;
  background: var(--bg-surface, #fff);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.inspection-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}
.header-main {
  display: flex;
  align-items: center;
  gap: 8px;
}
.plugin-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary, #111);
}
.plugin-id-tag code {
  font-size: 11px;
  color: var(--text-secondary, #666);
  background: var(--bg-surface-elevated, #f3f4f6);
  padding: 2px 6px;
  border-radius: 4px;
}
.header-badges {
  display: flex;
  gap: 6px;
}
.badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 500;
}
.version-badge {
  background: rgba(79, 70, 229, 0.1);
  color: var(--accent, #4f46e5);
}
.pub-badge {
  background: var(--bg-surface-elevated, #f3f4f6);
  color: var(--text-secondary, #4b5563);
}
.license-badge {
  background: rgba(16, 185, 129, 0.1);
  color: #059669;
}
.inspection-desc {
  font-size: 12px;
  color: var(--text-secondary, #4b5563);
  margin: 0;
  line-height: 1.5;
}

.security-gate-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: rgba(79, 70, 229, 0.04);
  border: 1px solid rgba(79, 70, 229, 0.15);
  border-radius: 6px;
  font-size: 11px;
}
.sec-left {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-primary, #111);
  font-weight: 500;
}
.sec-icon {
  color: var(--accent, #4f46e5);
}
.sec-hash {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  color: var(--text-secondary, #666);
}

.permissions-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sec-title {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary, #4b5563);
}
.scope-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.scope-badge {
  font-size: 11px;
  padding: 3px 8px;
  background: var(--bg-surface-elevated, #f3f4f6);
  color: var(--text-primary, #111);
  border-radius: 4px;
}
.empty-scope {
  font-size: 11px;
  color: var(--text-muted, #999);
}
.sensor-warning-box {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 11px;
  color: #d97706;
  background: #fffbeb;
  border: 1px solid #fde68a;
  padding: 6px 10px;
  border-radius: 6px;
}
.sensor-warn-icon {
  flex-shrink: 0;
  margin-top: 2px;
}

.capabilities-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 8px;
}
.cap-item {
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 6px;
  padding: 8px;
  background: var(--bg-surface-soft, #fafafa);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.cap-item.empty {
  opacity: 0.5;
}
.cap-header {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary, #4b5563);
}
.cap-names {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}
.cap-tag {
  font-size: 10px;
  padding: 1px 5px;
  background: var(--bg-surface, #fff);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 3px;
  color: var(--text-primary, #333);
}

.overwrite-section {
  padding-top: 6px;
  border-top: 1px dashed var(--border, #e5e7eb);
}
.overwrite-checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--danger, #dc2626);
  font-weight: 500;
  cursor: pointer;
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 12px;
}
.full-width {
  grid-column: 1 / -1;
}
.field-block {
  display: grid;
  gap: 4px;
}
.field-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary, #666);
}
.input-control {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 6px;
  background: var(--bg-input, #fff);
  color: var(--text-primary, #111);
  font-size: 12px;
}
.textarea-control {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 6px;
  background: var(--bg-input, #fff);
  color: var(--text-primary, #111);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  resize: vertical;
}

.package-footer-left {
  margin-right: auto;
}
</style>
