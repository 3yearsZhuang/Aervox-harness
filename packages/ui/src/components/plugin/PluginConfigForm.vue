<script setup lang="ts">
import type {PluginConfigField} from '@aervox/contracts'
import PluginConfigFieldInput from './PluginConfigFieldInput.vue'

defineProps<{
  fields: PluginConfigField[]
  values: Record<string, unknown>
  secretFields: Record<string, {configured: boolean}>
  secretValues: Record<string, string | null>
}>()

const emit = defineEmits<{
  (e: 'updateValue', key: string, value: unknown): void
  (e: 'updateSecret', key: string, value: string | null): void
}>()

function onValue(field: {key: string}, value: unknown): void {
  emit('updateValue', field.key, value)
}

function onSecret(field: {key: string}, value: string | null): void {
  emit('updateSecret', field.key, value)
}
</script>

<template>
  <div class="pcfg-form">
    <PluginConfigFieldInput
      v-for="field in fields"
      :key="field.key"
      :field="field"
      :value="values[field.key]"
      :secret-state="secretFields[field.key]"
      :secret-value="secretValues[field.key] ?? undefined"
      @change="onValue(field, $event)"
      @change-secret="onSecret(field, $event)"
    />
  </div>
</template>
