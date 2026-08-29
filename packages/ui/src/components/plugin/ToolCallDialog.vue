<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Play, ShieldCheck, Terminal } from 'lucide-vue-next'
import { useAervoxTools, type ToolRegistrationDto } from '@aervox/api-client'

const props = defineProps<{
  open: boolean
  tool: ToolRegistrationDto | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const api = useAervoxTools()
const rawArgs = ref('{}')
const needApproval = ref(false)
const calling = ref(false)
const callResult = ref<unknown>(null)
const callError = ref<string | null>(null)

const isReadOnly = computed(() => {
  return (props.tool?.safetyLevel ?? 'write_with_approval') === 'read_only'
})

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen || !props.tool) return
    callResult.value = null
    callError.value = null
    needApproval.value = !isReadOnly.value

    // 根据 inputSchemaJson 构造默认示例
    if (props.tool.inputSchemaJson && typeof props.tool.inputSchemaJson === 'object') {
      const schema = props.tool.inputSchemaJson as { properties?: Record<string, { type?: string; default?: unknown }> }
      if (schema.properties) {
        const initial: Record<string, unknown> = {}
        for (const [key, val] of Object.entries(schema.properties)) {
          initial[key] = val.default !== undefined ? val.default : val.type === 'string' ? '' : val.type === 'number' ? 0 : val.type === 'boolean' ? false : null
        }
        rawArgs.value = JSON.stringify(initial, null, 2)
        return
      }
    }
    rawArgs.value = '{\n  \n}'
  },
)

async function handleCall(): Promise<void> {
  if (!props.tool) return
  let parsedArgs: unknown = {}
  try {
    parsedArgs = JSON.parse(rawArgs.value)
  } catch {
    ElMessage.error('入参 JSON 格式不合法')
    return
  }

  calling.value = true
  callResult.value = null
  callError.value = null
  try {
    const res = await api.callTool(props.tool.id, parsedArgs, needApproval.value)
    callResult.value = res
    if (res.isError) {
      callError.value = '工具返回错误状态 (isError = true)'
    } else {
      ElMessage.success('工具执行成功')
    }
  } catch (e) {
    callError.value = e instanceof Error ? e.message : '调用工具失败'
    ElMessage.error(callError.value)
  } finally {
    calling.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="open"
    class="tool-call-dialog"
    width="min(720px, calc(100vw - 28px))"
    align-center
    :append-to-body="true"
    @close="emit('close')"
  >
    <template #header>
      <div class="dialog-header-wrap">
        <span class="heading-icon-wrap"><Terminal :size="18" /></span>
        <div class="dialog-header-text">
          <strong>调试调用：{{ tool?.name }}</strong>
          <small>{{ tool?.id }} · {{ tool?.safetyLevel || 'write_with_approval' }}</small>
        </div>
      </div>
    </template>

    <div class="call-dialog-body">
      <div class="field-block">
        <div class="field-title-row">
          <label class="field-label" for="tool-args-input">调用入参 (JSON 格式)</label>
          <label v-if="!isReadOnly" class="approval-toggle">
            <input v-model="needApproval" type="checkbox" />
            <ShieldCheck :size="14" />
            <span>携带用户显式授权 (approval: true)</span>
          </label>
        </div>
        <textarea
          id="tool-args-input"
          v-model="rawArgs"
          class="args-textarea"
          rows="6"
          placeholder="{}"
          spellcheck="false"
        />
      </div>

      <div class="result-section">
        <div class="result-title">执行输出结果</div>
        <div v-if="calling" class="result-loading">正在执行工具调用…</div>
        <div v-else-if="callError && !callResult" class="result-box is-error">
          <pre>{{ callError }}</pre>
        </div>
        <div v-else-if="callResult" class="result-box" :class="{ 'is-error': (callResult as any).isError }">
          <pre>{{ JSON.stringify(callResult, null, 2) }}</pre>
        </div>
        <div v-else class="result-placeholder">
          点击下方「执行调用」运行该工具并查看 MCP 响应数据。
        </div>
      </div>
    </div>

    <template #footer>
      <div class="call-dialog-footer">
        <el-button @click="emit('close')">关闭</el-button>
        <button
          type="button"
          class="btn-execute"
          :disabled="calling"
          @click="handleCall"
        >
          <Play :size="14" />
          <span>{{ calling ? '执行中…' : '执行调用' }}</span>
        </button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.tool-call-dialog :deep(.el-dialog__body) {
  padding: 16px 20px;
}
.dialog-header-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}
.heading-icon-wrap {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent);
}
.dialog-header-text {
  display: grid;
  gap: 2px;
}
.dialog-header-text strong {
  font-size: 14px;
  color: var(--text-primary);
}
.dialog-header-text small {
  font-size: 11px;
  color: var(--text-muted);
}
.call-dialog-body {
  display: grid;
  gap: 16px;
}
.field-block {
  display: grid;
  gap: 6px;
}
.field-title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.field-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
}
.approval-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-muted);
  cursor: pointer;
}
.args-textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
}
.args-textarea:focus {
  outline: none;
  border-color: var(--accent);
}
.result-section {
  display: grid;
  gap: 6px;
}
.result-title {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
}
.result-box {
  padding: 12px;
  border-radius: 8px;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  max-height: 220px;
  overflow-y: auto;
}
.result-box.is-error {
  background: color-mix(in srgb, #ef4444 8%, transparent);
  border-color: color-mix(in srgb, #ef4444 30%, transparent);
}
.result-box pre {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-all;
}
.result-loading,
.result-placeholder {
  padding: 24px;
  text-align: center;
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-soft);
  border: 1px dashed var(--border);
  border-radius: 8px;
}
.call-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.btn-execute {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  border: none;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}
.btn-execute:hover:not(:disabled) {
  opacity: 0.9;
  transform: translateY(-1px);
}
.btn-execute:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
