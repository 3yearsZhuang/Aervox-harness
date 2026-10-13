<script setup lang="ts">
import { useWorkbenchContext } from '@aervox/ui/plugin-api';
import { AervoxSwitch } from '@aervox/ui/primitives';
import { useFocusModeState } from './plugin-state';
const { focusModeEnabled, setFocusModeEnabled } = useFocusModeState();

/**
 * 插件自有设置行。
 *
 * CR-060：宿主设置面板只提供 `settings:conversation-rows` 通用插槽，
 * 行内的开关、文案与可用性判断全部归插件。
 */
const { pluginRuntime } = useWorkbenchContext();
const isAvailable = pluginRuntime?.isPluginAvailable('focus-mode') ?? true;
</script>

<template>
  <label v-if="isAvailable" class="settings-row settings-choice-row">
    <span>
      <strong>专注模式</strong>
      <small>启用专属启发式教学与防剧透规则</small>
    </span>
    <AervoxSwitch :model-value="focusModeEnabled" @update:model-value="setFocusModeEnabled" />
  </label>
</template>
