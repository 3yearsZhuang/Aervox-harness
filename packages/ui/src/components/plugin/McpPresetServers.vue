<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  Store,
  Unplug,
  Zap,
} from 'lucide-vue-next'
import { useAervoxMcp, type McpPresetDto } from '@aervox/api-client'

const emit = defineEmits<{
  (e: 'changed'): void
}>()

const api = useAervoxMcp()
const { presets, loading, error, loadPresets } = api

const tokenDialogOpen = ref(false)
const activePreset = ref<McpPresetDto | null>(null)
const tokenInput = ref('')
const connecting = ref(false)
const syncingId = ref<string | null>(null)
const disconnectingId = ref<string | null>(null)

onMounted(() => {
  void loadPresets()
})

function getStatusLabel(preset: McpPresetDto): { label: string; class: string } {
  if (preset.enabled && preset.status === 'connected') {
    return { label: `已连接 · ${preset.toolCount} 个工具`, class: 'preset-status-connected' }
  }
  if (preset.status === 'error') return { label: '连接异常', class: 'preset-status-error' }
  if (preset.configured) return { label: '未启用', class: 'preset-status-idle' }
  return { label: '未接入', class: 'preset-status-idle' }
}

function openTokenDialog(preset: McpPresetDto): void {
  activePreset.value = preset
  tokenInput.value = ''
  tokenDialogOpen.value = true
}

async function handleConnect(): Promise<void> {
  const preset = activePreset.value
  if (!preset) return
  const token = tokenInput.value.trim()
  if (preset.authType === 'bearer' && !token && !preset.tokenConfigured) {
    ElMessage.warning('请先在麦当劳 MCP 平台申请 Token 后粘贴到此处')
    return
  }
  connecting.value = true
  try {
    await api.connectServer(preset.id, token || undefined)
    ElMessage.success(`已接入「${preset.name}」并同步工具`)
    tokenDialogOpen.value = false
    emit('changed')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '接入失败，请检查 Token 与网络')
  } finally {
    connecting.value = false
    void loadPresets()
  }
}

async function handleSync(preset: McpPresetDto): Promise<void> {
  syncingId.value = preset.id
  try {
    await api.syncServer(preset.id)
    ElMessage.success(`「${preset.name}」工具已重新同步`)
    emit('changed')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '同步失败')
  } finally {
    syncingId.value = null
    void loadPresets()
  }
}

async function handleDisconnect(preset: McpPresetDto): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `断开后将停用并注销「${preset.name}」同步的全部工具（Token 会保留在本地，重新接入无需重填）。`,
      '断开 MCP 服务器',
      { confirmButtonText: '断开', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  disconnectingId.value = preset.id
  try {
    await api.disconnectServer(preset.id)
    ElMessage.success(`已断开「${preset.name}」`)
    emit('changed')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '断开失败')
  } finally {
    disconnectingId.value = null
    void loadPresets()
  }
}
</script>

<template>
  <section class="preset-servers">
    <header class="preset-header">
      <span class="preset-title">
        <Store :size="14" />
        <span>预设 MCP 服务</span>
      </span>
      <small class="preset-hint">出厂内置的官方 MCP 接入档案，补 Token 即可一键接入</small>
    </header>

    <div v-if="loading" class="preset-empty">加载预设 MCP 服务中…</div>
    <p v-else-if="error" class="preset-empty">{{ error }}</p>
    <p v-else-if="presets.length === 0" class="preset-empty">暂无预设 MCP 服务。</p>

    <article v-for="preset in presets" :key="preset.id" class="preset-card">
      <span class="preset-icon">
        <Zap :size="18" />
      </span>
      <div class="preset-main">
        <div class="preset-line">
          <strong class="preset-name">{{ preset.name }}</strong>
          <code class="preset-endpoint">{{ preset.endpointUrl }}</code>
          <span class="preset-status" :class="getStatusLabel(preset).class">
            {{ getStatusLabel(preset).label }}
          </span>
          <span v-if="preset.tokenConfigured" class="preset-token" :title="preset.tokenMasked ?? ''">
            Token 已配置（{{ preset.tokenMasked }}）
          </span>
        </div>
        <p class="preset-desc">{{ preset.description }}</p>
        <p class="preset-meta">
          <span v-if="preset.regionNote">{{ preset.regionNote }}</span>
          <span v-if="preset.rateLimitNote"> · {{ preset.rateLimitNote }}</span>
          <span> · 协议 {{ preset.protocolVersion }} / {{ preset.transport }}</span>
        </p>
        <p v-if="preset.lastError" class="preset-error">最近错误：{{ preset.lastError }}</p>
      </div>
      <div class="preset-actions">
        <button
          type="button"
          class="preset-btn preset-btn-primary"
          @click="openTokenDialog(preset)"
        >
          <ShieldCheck :size="14" />
          <span>{{ preset.configured ? '重新接入' : '接入' }}</span>
        </button>
        <button
          type="button"
          class="preset-btn"
          :disabled="!preset.configured || syncingId === preset.id"
          title="重新同步工具清单"
          @click="handleSync(preset)"
        >
          <RefreshCw :size="14" />
          <span>同步</span>
        </button>
        <button
          type="button"
          class="preset-btn preset-btn-danger"
          :disabled="!preset.enabled || disconnectingId === preset.id"
          title="断开并注销同步工具"
          @click="handleDisconnect(preset)"
        >
          <Unplug :size="14" />
        </button>
        <a
          class="preset-btn preset-link"
          :href="preset.tokenApplyUrl"
          target="_blank"
          rel="noreferrer noopener"
          title="打开官方平台申请 Token"
        >
          <ExternalLink :size="14" />
        </a>
      </div>
    </article>

    <el-dialog
      :model-value="tokenDialogOpen"
      class="mcp-token-dialog"
      width="min(520px, calc(100vw - 28px))"
      align-center
      :append-to-body="true"
      @close="tokenDialogOpen = false"
    >
      <template #header>
        <div class="token-header-wrap">
          <span class="heading-icon-wrap"><ShieldCheck :size="18" /></span>
          <div class="token-header-text">
            <strong>接入「{{ activePreset?.name }}」</strong>
            <small>Token 仅保存在本地数据库，接口不会回传原文</small>
          </div>
        </div>
      </template>

      <div class="token-body">
        <div class="field-block">
          <label class="field-label" for="mcp-token-input">MCP Token</label>
          <input
            id="mcp-token-input"
            v-model="tokenInput"
            class="input-control"
            type="password"
            autocomplete="off"
            :placeholder="activePreset?.tokenConfigured ? '留空则沿用已保存的 Token' : '粘贴在官方平台申请的 MCP Token'"
            maxlength="256"
          />
        </div>
        <p class="token-hint">
          尚无 Token？打开
          <a :href="activePreset?.tokenApplyUrl" target="_blank" rel="noreferrer noopener">
            {{ activePreset?.tokenApplyUrl }}
          </a>
          登录后在「控制台」申请。{{ activePreset?.rateLimitNote }}
        </p>
        <p class="token-hint">
          接入后将立即同步远程工具清单：查询类工具可被 AI 自主调用，下单/领券等写操作每次都需你确认授权（PET-05）。
        </p>
      </div>

      <template #footer>
        <div class="token-footer">
          <el-button @click="tokenDialogOpen = false">取消</el-button>
          <button type="button" class="btn-token-submit" :disabled="connecting" @click="handleConnect">
            <ShieldCheck :size="14" />
            <span>{{ connecting ? '正在接入…' : '接入并同步' }}</span>
          </button>
        </div>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.preset-servers {
  display: grid;
  gap: 10px;
}
.preset-header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.preset-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 600;
}
.preset-hint {
  color: var(--text-muted);
  font-size: 10px;
}
.preset-empty {
  padding: 16px 0;
  text-align: center;
  color: var(--text-muted);
  font-size: 11px;
}
.preset-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-soft);
  transition: all 0.22s ease;
}
.preset-card:hover {
  border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
  box-shadow: 0 4px 12px rgba(15, 20, 32, 0.05);
}
.preset-icon {
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent);
}
.preset-main {
  min-width: 0;
  flex: 1;
  display: grid;
  gap: 3px;
}
.preset-line {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.preset-name {
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 600;
}
.preset-endpoint {
  font-size: 10px;
  padding: 1px 4px;
  background: var(--bg-input);
  border-radius: 4px;
  color: var(--text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.preset-status {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 9px;
  border: 1px solid transparent;
}
.preset-status-connected {
  background: color-mix(in srgb, #10b981 15%, transparent);
  color: #10b981;
  border-color: color-mix(in srgb, #10b981 30%, transparent);
}
.preset-status-error {
  background: color-mix(in srgb, #ef4444 15%, transparent);
  color: #ef4444;
  border-color: color-mix(in srgb, #ef4444 30%, transparent);
}
.preset-status-idle {
  background: color-mix(in srgb, #6b7280 15%, transparent);
  color: var(--text-muted);
}
.preset-token {
  font-size: 9px;
  color: var(--text-muted);
}
.preset-desc {
  margin: 0;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.5;
}
.preset-meta {
  margin: 0;
  color: var(--text-muted);
  font-size: 10px;
}
.preset-error {
  margin: 0;
  color: #ef4444;
  font-size: 10px;
}
.preset-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.preset-btn {
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
  text-decoration: none;
  transition: all 0.2s ease;
}
.preset-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
  transform: translateY(-1px);
}
.preset-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.preset-btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.preset-btn-primary:hover:not(:disabled) {
  color: #fff;
  opacity: 0.9;
  box-shadow: 0 2px 8px rgba(78, 119, 209, 0.25);
}
.preset-btn-danger:hover:not(:disabled) {
  border-color: var(--danger, #ef4444);
  color: var(--danger, #ef4444);
  background: color-mix(in srgb, #ef4444 12%, transparent);
}
.preset-link {
  padding: 6px 8px;
}
.token-header-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}
.heading-icon-wrap {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent);
}
.token-header-text {
  display: grid;
  gap: 2px;
}
.token-header-text strong {
  color: var(--text-primary);
  font-size: 13px;
}
.token-header-text small {
  color: var(--text-muted);
  font-size: 10px;
}
.token-body {
  display: grid;
  gap: 12px;
}
.field-block {
  display: grid;
  gap: 6px;
}
.field-label {
  font-size: 11px;
  color: var(--text-secondary);
  font-weight: 500;
}
.input-control {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
  box-sizing: border-box;
}
.input-control:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 20%, transparent);
}
.token-hint {
  margin: 0;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.5;
}
.token-hint a {
  color: var(--accent);
}
.token-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.btn-token-submit {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  border: none;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}
.btn-token-submit:hover:not(:disabled) {
  opacity: 0.9;
  box-shadow: 0 2px 8px rgba(78, 119, 209, 0.25);
}
.btn-token-submit:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
