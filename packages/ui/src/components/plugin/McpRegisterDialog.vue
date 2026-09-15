<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from '../../utils/element'
import { Wrench, Plus } from 'lucide-vue-next'
import { useAervoxTools } from '@aervox/api-client'
import { AervoxDialog, AervoxButton } from '../../primitives'

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
const inputSchemaJson = ref('{\n  "type": "object",\n  "properties": {}\n}')
const saving = ref(false)

function resetForm() {
  id.value = ''
  name.value = ''
  description.value = ''
  category.value = 'external'
  safetyLevel.value = 'read_only'
  inputSchemaJson.value = '{\n  "type": "object",\n  "properties": {}\n}'
}

async function handleRegister() {
  const toolId = id.value.trim()
  const toolName = name.value.trim()
  const toolDesc = description.value.trim()

  if (!toolId || !toolName || !toolDesc) {
    ElMessage.warning('请填写完整的工具标识、名称与描述')
    return
  }

  let parsedSchema: unknown = undefined
  if (inputSchemaJson.value.trim()) {
    try {
      parsedSchema = JSON.parse(inputSchemaJson.value)
    } catch {
      ElMessage.error('输入参数 JSON Schema 格式不正确，请检查语法')
      return
    }
  }

  saving.value = true
  try {
    await api.registerTool({
      id: toolId,
      name: toolName,
      description: toolDesc,
      category: category.value,
      safetyLevel: safetyLevel.value,
      inputSchema: parsedSchema,
      builtin: false,
    })
    ElMessage.success('工具已成功注册')
    emit('registered')
    emit('close')
    resetForm()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '注册工具失败')
  } finally {
    saving.value = false
  }
}

</script>

<template>
  <AervoxDialog
    :model-value="open"
    title="注册 MCP / 自定义工具"
    subtitle="向工具注册表登记新的外部工具声明与安全等级"
    :icon="Wrench"
    size="md"
    @close="emit('close')"
  >
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
          <label class="field-label" for="tool-safety-select">安全级别</label>
          <select id="tool-safety-select" v-model="safetyLevel" class="select-control">
            <option value="read_only">只读无副作用 (AI 可自主调用)</option>
            <option value="write_with_approval">写操作 (需用户确认)</option>
            <option value="privileged">特权级 (仅管理员)</option>
          </select>
        </div>


        <div class="field-block full-width">
          <label class="field-label" for="tool-schema-input">入参结构 (JSON Schema)</label>
          <textarea
            id="tool-schema-input"
            v-model="inputSchemaJson"
            class="textarea-control"
            rows="6"
            placeholder="{ type: 'object', properties: { ... } }"
          />
        </div>
      </div>
    </div>

    <template #footer>
      <AervoxButton variant="secondary" @click="emit('close')">取消</AervoxButton>
      <AervoxButton
        variant="primary"
        :icon="Plus"
        :loading="saving"
        @click="handleRegister"
      >
        确认注册
      </AervoxButton>
    </template>
  </AervoxDialog>
</template>

<style scoped>
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
