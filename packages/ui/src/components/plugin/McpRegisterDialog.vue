<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Plus, Wrench } from 'lucide-vue-next'
import { useAervoxTools } from '@aervox/api-client'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'registered'): void
}>()

const api = useAervoxTools()

const id = ref('')
const name = ref('')
const description = ref('')
const category = ref<'memory' | 'search' | 'learning' | 'system' | 'external'>('external')
const safetyLevel = ref<'read_only' | 'write_with_approval' | 'privileged'>('read_only')
const rawInputSchema = ref('{\n  "type": "object",\n  "properties": {}\n}')
const saving = ref(false)

function resetForm() {
  id.value = ''
  name.value = ''
  description.value = ''
  category.value = 'external'
  safetyLevel.value = 'read_only'
  rawInputSchema.value = '{\n  "type": "object",\n  "properties": {}\n}'
}

async function handleRegister(): Promise<void> {
  const trimmedId = id.value.trim()
  const trimmedName = name.value.trim()
  const trimmedDesc = description.value.trim()

  if (!trimmedId || !trimmedName || !trimmedDesc) {
    ElMessage.warning('请填写完整的工具标识、名称与描述')
    return
  }

  let inputSchema: unknown = undefined
  if (rawInputSchema.value.trim()) {
    try {
      inputSchema = JSON.parse(rawInputSchema.value)
    } catch {
      ElMessage.error('参数 Input Schema JSON 格式不合法')
      return
    }
  }

  saving.value = true
  try {
    await api.registerTool({
      id: trimmedId,
      name: trimmedName,
      description: trimmedDesc,
      category: category.value,
      safetyLevel: safetyLevel.value,
      inputSchema,
      builtin: false,
    })
    ElMessage.success('工具注册成功')
    resetForm()
    emit('registered')
    emit('close')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '注册工具失败')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="open"
    class="mcp-register-dialog"
    width="min(640px, calc(100vw - 28px))"
    align-center
    :append-to-body="true"
    @close="emit('close')"
  >
    <template #header>
      <div class="dialog-header-wrap">
        <span class="heading-icon-wrap"><Wrench :size="18" /></span>
        <div class="dialog-header-text">
          <strong>注册 MCP / 自定义工具</strong>
          <small>向工具注册表登记新的外部工具声明与安全等级</small>
        </div>
      </div>
    </template>

    <div class="register-dialog-body">
      <div class="form-grid">
        <div class="field-block">
          <label class="field-label" for="tool-id-input">工具唯一标识 (ID)</label>
          <input
            id="tool-id-input"
            v-model="id"
            class="input-control"
            placeholder="例如：mcp__weather__get_forecast"
            maxlength="128"
          />
        </div>

        <div class="field-block">
          <label class="field-label" for="tool-name-input">AI 调用名称</label>
          <input
            id="tool-name-input"
            v-model="name"
            class="input-control"
            placeholder="例如：get_forecast"
            maxlength="128"
          />
        </div>

        <div class="field-block full-width">
          <label class="field-label" for="tool-desc-input">功能描述 (给模型的指令引导)</label>
          <input
            id="tool-desc-input"
            v-model="description"
            class="input-control"
            placeholder="例如：查询指定城市的实时天气预报"
            maxlength="500"
          />
        </div>

        <div class="field-block">
          <label class="field-label" for="tool-category-select">分类类别</label>
          <select id="tool-category-select" v-model="category" class="select-control">
            <option value="external">外部扩展 (external)</option>
            <option value="search">搜索查询 (search)</option>
            <option value="learning">学习练习 (learning)</option>
            <option value="memory">记忆管理 (memory)</option>
            <option value="system">系统服务 (system)</option>
          </select>
        </div>

        <div class="field-block">
          <label class="field-label" for="tool-safety-select">PET-05 安全级别</label>
          <select id="tool-safety-select" v-model="safetyLevel" class="select-control">
            <option value="read_only">只读无副作用 (AI 可自主调用)</option>
            <option value="write_with_approval">写操作 (需用户确认)</option>
            <option value="privileged">特权级 (仅管理员)</option>
          </select>
        </div>

        <div class="field-block full-width">
          <label class="field-label" for="tool-schema-input">参数 Schema (JSON Schema)</label>
          <textarea
            id="tool-schema-input"
            v-model="rawInputSchema"
            class="textarea-control"
            rows="5"
            spellcheck="false"
          />
        </div>
      </div>
    </div>

    <template #footer>
      <div class="register-dialog-footer">
        <el-button @click="emit('close')">取消</el-button>
        <button
          type="button"
          class="btn-submit"
          :disabled="saving"
          @click="handleRegister"
        >
          <Plus :size="14" />
          <span>{{ saving ? '正在注册…' : '确认注册' }}</span>
        </button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.mcp-register-dialog :deep(.el-dialog__body) {
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
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.full-width {
  grid-column: 1 / -1;
}
.field-block {
  display: grid;
  gap: 5px;
}
.field-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
}
.input-control,
.select-control {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 12px;
}
.input-control:focus,
.select-control:focus,
.textarea-control:focus {
  outline: none;
  border-color: var(--accent);
}
.textarea-control {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  resize: vertical;
}
.register-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.btn-submit {
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
.btn-submit:hover:not(:disabled) {
  opacity: 0.9;
  transform: translateY(-1px);
}
.btn-submit:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
