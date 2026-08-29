<script setup lang="ts">
import {computed} from 'vue'
import type {PluginConfigField} from '@aervox/contracts'
import {Plus, Trash2, RefreshCw} from 'lucide-vue-next'

const props = defineProps<{
  field: PluginConfigField
  value: unknown
  secretState?: {configured: boolean}
  secretValue?: string | null
  depth?: number
}>()

const emit = defineEmits<{
  (e: 'change', value: unknown): void
  (e: 'changeSecret', value: string | null): void
}>()

const locale = 'zh-CN'
const localize = (value: string | Record<string, string> | undefined, fallback = ''): string => {
  if (value === undefined) return fallback
  if (typeof value === 'string') return value
  if (value[locale]) return value[locale]
  return value['zh-CN'] ?? Object.values(value)[0] ?? fallback
}

const objectValue = computed<Record<string, unknown>>(() =>
  typeof props.value === 'object' && props.value !== null && !Array.isArray(props.value)
    ? props.value as Record<string, unknown>
    : {},
)
const arrayValue = computed<unknown[]>(() => (Array.isArray(props.value) ? props.value : []))

function handleChildChange(key: string, next: unknown): void {
  emit('change', {...objectValue.value, [key]: next})
}

function addArrayItem(): void {
  const itemField = props.field.items
  let item: unknown = {}
  if (itemField && itemField.default !== undefined) {
    item = JSON.parse(JSON.stringify(itemField.default))
  }
  emit('change', [...arrayValue.value, item])
}

function removeArrayItem(index: number): void {
  const next = arrayValue.value.slice()
  next.splice(index, 1)
  emit('change', next)
}


function onInputChange(event: Event): void {
  emit('change', (event.target as HTMLInputElement).value)
}
function onTextChange(event: Event): void {
  emit('change', (event.target as HTMLTextAreaElement).value)
}
function onNumberChange(event: Event): void {
  emit('change', Number((event.target as HTMLInputElement).value))
}
function onBoolChange(event: Event): void {
  emit('change', (event.target as HTMLInputElement).checked)
}
function onSelectChange(event: Event): void {
  emit('change', (event.target as HTMLSelectElement).value)
}
function onSecretInput(event: Event): void {
  emit('changeSecret', (event.target as HTMLInputElement).value)
}
function onMultiChange(optionValue: string | number | boolean, event: Event): void {
  const current = (Array.isArray(props.value) ? props.value : []) as Array<string | number | boolean>
  const checked = (event.target as HTMLInputElement).checked
  emit('change', checked ? [...current, optionValue] : current.filter((v) => v !== optionValue))
}

function updateArrayItem(index: number, next: unknown): void {
  const arr = arrayValue.value.slice()
  arr[index] = next
  emit('change', arr)
}
</script>

<template>
  <div class="pcfg-field" :class="`pcfg-${field.type}`">
    <template v-if="field.type === 'object'">
      <fieldset class="pcfg-group">
        <legend>{{ localize(field.label, field.key) }}</legend>
        <p v-if="field.description" class="pcfg-hint">{{ localize(field.description) }}</p>
        <PluginConfigFieldInput
          v-for="child in field.children ?? []"
          :key="child.key"
          :field="child"
          :value="objectValue[child.key]"
          :depth="(depth ?? 1) + 1"
          @change="(v) => handleChildChange(child.key, v)"
        />
      </fieldset>
    </template>

    <template v-else-if="field.type === 'array'">
      <div class="pcfg-array">
        <div class="pcfg-label">
          <strong>{{ localize(field.label, field.key) }}</strong>
          <small v-if="field.description">{{ localize(field.description) }}</small>
        </div>
        <div v-for="(item, index) in arrayValue" :key="index" class="pcfg-array-item">
          <PluginConfigFieldInput
            v-if="field.items"
            :field="field.items"
            :value="item"
            :depth="(depth ?? 1) + 1"
            @change="(v) => updateArrayItem(index, v)"
          />
          <button type="button" class="pcfg-icon-btn" :aria-label="`删除第 ${index + 1} 项`" @click="removeArrayItem(index)">
            <Trash2 :size="14" />
          </button>
        </div>
        <button type="button" class="pcfg-add-btn" @click="addArrayItem"><Plus :size="14" />添加一项</button>
      </div>
    </template>

    <template v-else>
      <label class="pcfg-row">
        <span class="pcfg-label">
          <strong>{{ localize(field.label, field.key) }}<em v-if="field.required">*</em></strong>
          <small v-if="field.description">{{ localize(field.description) }}</small>
          <small v-if="field.hint" class="pcfg-hint">{{ localize(field.hint) }}</small>
        </span>

        <input
          v-if="field.type === 'string'"
          type="text"
          :value="(value as string) ?? ''"
          :placeholder="localize(field.placeholder)"
          @input="emit('change', ($event.target as HTMLInputElement).value)"
        />
        <textarea
          v-else-if="field.type === 'text'"
          rows="4"
          :value="(value as string) ?? ''"
          :placeholder="localize(field.placeholder)"
          @input="emit('change', ($event.target as HTMLTextAreaElement).value)"
        />
        <input
          v-else-if="field.type === 'integer' || field.type === 'number'"
          type="number"
          :value="(value as number) ?? 0"
          @input="emit('change', Number(($event.target as HTMLInputElement).value))"
        />
        <input
          v-else-if="field.type === 'boolean'"
          type="checkbox"
          class="settings-switch"
          :checked="Boolean(value)"
          @change="onBoolChange($event)"
        />
        <select
          v-else-if="field.type === 'select'"
          :value="(value as string | number | boolean | undefined) ?? ''"
          @change="onSelectChange($event)"
        >
          <option value="" disabled>请选择</option>
          <option v-for="option in field.options ?? []" :key="String(option.value)" :value="String(option.value)">
            {{ option.label }}
          </option>
        </select>
        <span v-else-if="field.type === 'multi_select'" class="pcfg-checks">
          <label v-for="option in field.options ?? []" :key="String(option.value)" class="pcfg-check">
            <input
              type="checkbox"
              :checked="(Array.isArray(value) ? value : []).includes(option.value)"
              @change="(e) => onMultiChange(option.value, e)"
            />
            {{ option.label }}
          </label>
        </span>
        <span v-else-if="field.type === 'secret'" class="pcfg-secret">
          <span class="pcfg-secret-state">{{ secretState?.configured ? '已配置' : '未配置' }}</span>
          <input
            v-if="secretValue !== undefined && secretValue !== null"
            type="password"
            :value="secretValue"
            placeholder="输入新值后保存"
            @input="onSecretInput($event)"
          />
          <button v-if="!secretState?.configured" type="button" class="pcfg-small-btn" @click="emit('changeSecret', '')">设置</button>
          <button v-else type="button" class="pcfg-small-btn" @click="emit('changeSecret', null)">清除</button>
          <button v-if="secretValue !== undefined && secretValue !== null" type="button" class="pcfg-small-btn" @click="emit('changeSecret', null)">
            <RefreshCw :size="12" />取消
          </button>
        </span>
      </label>
    </template>
  </div>
</template>

<style scoped>
.pcfg-field { width: 100%; transition: opacity 0.2s ease; }
.pcfg-group {
  margin: 0 0 14px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
  border-radius: 12px;
  background: var(--bg-soft);
  transition: border-color 0.22s ease, background-color 0.22s ease, box-shadow 0.22s ease;
}
.pcfg-group:hover {
  border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
}
.pcfg-group legend { padding: 0 6px; color: var(--text-primary); font-size: 11px; font-weight: 750; }
.pcfg-hint { margin: 2px 0 8px; color: var(--text-muted); font-size: 10px; line-height: 1.45; }
.pcfg-row {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 12px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  transition: background-color 0.18s ease;
}
.pcfg-field .pcfg-field:last-child .pcfg-row { border-bottom: 0; }
.pcfg-label { min-width: 0; display: grid; gap: 3px; }
.pcfg-label strong { color: var(--text-primary); font-size: 11px; }
.pcfg-label strong em { color: var(--danger); font-style: normal; }
.pcfg-label small { color: var(--text-muted); font-size: 9px; line-height: 1.45; }
.pcfg-row input[type='text'],
.pcfg-row input[type='number'],
.pcfg-row input[type='password'],
.pcfg-row textarea,
.pcfg-row select {
  max-width: 46%;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 9px;
  outline: 0;
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 11px;
  transition: border-color 0.2s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.2s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.18s ease;
}
.pcfg-row textarea { width: 46%; resize: vertical; }
.pcfg-row input:focus,
.pcfg-row textarea:focus,
.pcfg-row select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
.pcfg-checks { max-width: 50%; display: grid; gap: 6px; }
.pcfg-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font-size: 10px;
  cursor: pointer;
  user-select: none;
  transition: color 0.15s ease;
}
.pcfg-check:hover { color: var(--text-primary); }
.pcfg-check input[type="checkbox"] {
  accent-color: var(--accent);
  cursor: pointer;
  transition: transform 0.15s ease;
}
.pcfg-check input[type="checkbox"]:active {
  transform: scale(0.9);
}
.pcfg-secret { display: inline-flex; align-items: center; gap: 8px; }
.pcfg-secret-state {
  padding: 4px 8px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 10px;
  transition: all 0.2s ease;
}
.pcfg-small-btn, .pcfg-add-btn, .pcfg-icon-btn {
  display: inline-flex; align-items: center; gap: 4px;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg-soft); color: var(--text-secondary);
  font-size: 10px; cursor: pointer;
  transition: all 0.18s cubic-bezier(0.4, 0, 0.2, 1);
}
.pcfg-small-btn { padding: 5px 9px; }
.pcfg-small-btn:hover, .pcfg-add-btn:hover, .pcfg-icon-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
  transform: translateY(-1px);
}
.pcfg-small-btn:active, .pcfg-add-btn:active, .pcfg-icon-btn:active {
  transform: translateY(0) scale(0.97);
}
.pcfg-array { display: grid; gap: 8px; width: 100%; }
.pcfg-array-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 8px;
  transition: background-color 0.18s ease;
}
.pcfg-array-item:hover {
  background: color-mix(in srgb, var(--bg-main) 60%, transparent);
}
.pcfg-array-item .pcfg-field { flex: 1; }
.pcfg-array-item .pcfg-row { border-bottom: 0; }
.pcfg-icon-btn { padding: 6px; align-self: center; }
.pcfg-icon-btn:hover {
  border-color: var(--danger);
  color: var(--danger);
  background: var(--danger-soft);
}
.pcfg-add-btn { justify-self: start; padding: 6px 10px; }
</style>
