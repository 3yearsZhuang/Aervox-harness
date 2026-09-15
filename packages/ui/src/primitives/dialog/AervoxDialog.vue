<script setup lang="ts">
import { computed, type Component } from 'vue';
import { ElDialog } from '../../utils/element';
import AervoxDialogHeader from './AervoxDialogHeader.vue';

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl' | 'custom';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title?: string;
    subtitle?: string;
    icon?: Component;
    size?: DialogSize;
    width?: string;
    showHeader?: boolean;
    showClose?: boolean;
    closeOnClickModal?: boolean;
    closeOnPressEscape?: boolean;
    appendToBody?: boolean;
    destroyOnClose?: boolean;
    alignCenter?: boolean;
    customClass?: string;
    bodyMaxHeight?: string;
    noPadding?: boolean;
  }>(),
  {
    title: '',
    subtitle: '',
    icon: undefined,
    size: 'md',
    width: '',
    showHeader: true,
    showClose: true,
    closeOnClickModal: true,
    closeOnPressEscape: true,
    appendToBody: true,
    destroyOnClose: false,
    alignCenter: true,
    customClass: '',
    bodyMaxHeight: '66vh',
    noPadding: false,
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  close: [];
  closed: [];
  open: [];
  opened: [];
}>();

const resolvedWidth = computed(() => {
  if (props.width) return props.width;
  switch (props.size) {
    case 'sm':
      return 'min(480px, calc(100vw - 28px))';
    case 'md':
      return 'min(640px, calc(100vw - 28px))';
    case 'lg':
      return 'min(860px, calc(100vw - 28px))';
    case 'xl':
      return 'min(1040px, calc(100vw - 28px))';
    default:
      return 'min(640px, calc(100vw - 28px))';
  }
});

const dialogClasses = computed(() => [
  'aervox-dialog',
  `aervox-dialog--${props.size}`,
  props.customClass,
]);

function handleClose() {
  emit('update:modelValue', false);
  emit('close');
}
</script>

<template>
  <ElDialog
    :model-value="modelValue"
    :title="title"
    :width="resolvedWidth"
    :class="dialogClasses"
    :show-close="false"
    :close-on-click-modal="closeOnClickModal"
    :close-on-press-escape="closeOnPressEscape"
    :append-to-body="appendToBody"
    :destroy-on-close="destroyOnClose"
    :align-center="alignCenter"
    @update:model-value="emit('update:modelValue', $event)"
    @close="handleClose"
    @closed="emit('closed')"
    @open="emit('open')"
    @opened="emit('opened')"
  >
    <template v-if="showHeader" #header>
      <slot name="header">
        <AervoxDialogHeader
          :title="title"
          :subtitle="subtitle"
          :icon="icon"
          :show-close="showClose"
          @close="handleClose"
        >
          <template v-if="$slots['header-icon']" #icon>
            <slot name="header-icon" />
          </template>
          <template v-if="$slots['header-title']" #title>
            <slot name="header-title" />
          </template>
          <template v-if="$slots['header-subtitle']" #subtitle>
            <slot name="header-subtitle" />
          </template>
          <template v-if="$slots['header-actions']" #actions>
            <slot name="header-actions" />
          </template>
        </AervoxDialogHeader>
      </slot>
    </template>

    <div
      class="aervox-dialog-body"
      :class="{ 'is-no-padding': noPadding }"
      :style="{ maxHeight: bodyMaxHeight }"
    >
      <slot />
    </div>

    <template v-if="$slots.footer" #footer>
      <div class="aervox-dialog-footer">
        <slot name="footer" />
      </div>
    </template>
  </ElDialog>
</template>

<style>
/* 全局覆盖与统一弹窗容器样式（Scoped 样式无法直接作用于 Teleport 后的 el-dialog 根元素） */
.el-dialog.aervox-dialog {
  border-radius: 14px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  box-shadow: 0 24px 56px -12px rgba(0, 0, 0, 0.28), 0 0 0 1px var(--border);
  overflow: hidden;
  padding: 0;
}

.el-dialog.aervox-dialog .el-dialog__header {
  padding: 16px 20px 14px;
  margin: 0;
  border-bottom: 1px solid var(--border);
}

.el-dialog.aervox-dialog .el-dialog__body {
  padding: 0;
  color: var(--text-primary);
}

.el-dialog.aervox-dialog .el-dialog__footer {
  padding: 12px 20px 16px;
  margin: 0;
  border-top: 1px solid var(--border);
}

.aervox-dialog-body {
  padding: 18px 20px;
  overflow-y: auto;
  box-sizing: border-box;
  scrollbar-width: thin;
  scrollbar-color: var(--border-strong, var(--border)) transparent;
}

.aervox-dialog-body.is-no-padding,
.el-dialog.aervox-nav-dialog .aervox-dialog-body {
  padding: 0;
  overflow: hidden;
}

.aervox-dialog-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}

/* 非阻塞确认弹窗（aervoxConfirm）视觉风格微调与统一对齐 */
.el-message-box.aervox-message-box {
  border-radius: 14px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  box-shadow: 0 24px 56px -12px rgba(0, 0, 0, 0.28), 0 0 0 1px var(--border);
  padding: 20px;
  overflow: hidden;
  box-sizing: border-box;
}

.el-message-box.aervox-message-box .el-message-box__header {
  padding-bottom: 12px;
}

.el-message-box.aervox-message-box .el-message-box__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.el-message-box.aervox-message-box .el-message-box__content {
  padding: 0 0 20px;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
}

.el-message-box.aervox-message-box .el-message-box__btns {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 0;
}

.el-message-box.aervox-message-box .el-message-box__btns button {
  border-radius: 8px;
  font-size: 12px;
  font-weight: 500;
  padding: 8px 16px;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
</style>
