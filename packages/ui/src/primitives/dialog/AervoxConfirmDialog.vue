<script setup lang="ts">
import { computed, ref, watch, type Component } from 'vue';
import { AlertTriangle, ShieldAlert } from 'lucide-vue-next';
import AervoxDialog from './AervoxDialog.vue';
import AervoxButton from '../button/AervoxButton.vue';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    acknowledged?: boolean;
    title?: string;
    message?: string;
    description?: string;
    icon?: Component;
    confirmText?: string;
    cancelText?: string;
    variant?: 'primary' | 'danger';
    loading?: boolean;
    requireAcknowledge?: boolean;
    acknowledgeText?: string;
    width?: string;
    customClass?: string;
  }>(),
  {
    acknowledged: undefined,
    title: '请确认',
    message: '',
    description: '',
    icon: undefined,
    confirmText: '确认',
    cancelText: '取消',
    variant: 'primary',
    loading: false,
    requireAcknowledge: false,
    acknowledgeText: '我已了解风险，并愿意继续',
    width: 'min(500px, calc(100vw - 28px))',
    customClass: '',
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  'update:acknowledged': [value: boolean];
  confirm: [];
  cancel: [];
  closed: [];
}>();

const innerAcknowledged = ref(false);

const isAcknowledged = computed({
  get: () => (props.acknowledged !== undefined ? props.acknowledged : innerAcknowledged.value),
  set: (val: boolean) => {
    innerAcknowledged.value = val;
    emit('update:acknowledged', val);
  },
});

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      innerAcknowledged.value = false;
      emit('update:acknowledged', false);
    }
  },
);

function handleCancel() {
  emit('update:modelValue', false);
  emit('cancel');
}

function handleConfirm() {
  if (props.requireAcknowledge && !isAcknowledged.value) return;
  emit('confirm');
}
</script>

<template>
  <AervoxDialog
    :model-value="modelValue"
    :title="title"
    :icon="icon ?? (variant === 'danger' ? AlertTriangle : ShieldAlert)"
    :width="width"
    :custom-class="customClass"
    size="sm"
    @update:model-value="emit('update:modelValue', $event)"
    @close="handleCancel"
    @closed="emit('closed')"
  >
    <div class="confirm-body">
      <p v-if="message" class="confirm-message">{{ message }}</p>
      <slot />
      <small v-if="description" class="confirm-desc">{{ description }}</small>

      <label v-if="requireAcknowledge" class="confirm-acknowledge">
        <input v-model="isAcknowledged" type="checkbox" />
        <span>{{ acknowledgeText }}</span>
      </label>
    </div>

    <template #footer>
      <AervoxButton variant="secondary" :disabled="loading" @click="handleCancel">
        {{ cancelText }}
      </AervoxButton>
      <AervoxButton
        :variant="variant"
        :loading="loading"
        :disabled="requireAcknowledge && !isAcknowledged"
        @click="handleConfirm"
      >
        {{ confirmText }}
      </AervoxButton>
    </template>
  </AervoxDialog>
</template>

<style scoped>
.confirm-body {
  display: grid;
  gap: 12px;
}

.confirm-message {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-primary);
}

.confirm-desc {
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-muted);
}

.confirm-acknowledge {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--bg-soft, rgba(0, 0, 0, 0.03));
  border: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-primary);
  cursor: pointer;
  user-select: none;
}

.confirm-acknowledge input[type='checkbox'] {
  cursor: pointer;
}
</style>
