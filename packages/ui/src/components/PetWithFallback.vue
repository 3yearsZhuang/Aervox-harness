<script setup lang="ts">
/**
 * Aervox｜思隅 @aervox/ui — 桌宠渲染降级链编排
 *
 * 优先级：Live2D（完整表现）→ SpritePet（调用方提供精灵图清单时）→ PetHero（纯 CSS 兜底）。
 * Live2DPet 自身在加载失败 / 偏好减弱动效时进入 error 态并渲染 fallback 槽，
 * 本组件只负责在槽内选择下一线表现，保证任何环境下桌宠区域都有可见角色。
 */
import Live2DPet from './Live2DPet.vue';
import SpritePet, { type PetManifest, type PetSheetState, type PetToolActivity } from './SpritePet.vue';
import PetHero from './PetHero.vue';

withDefaults(
  defineProps<{
    /** 提供精灵图清单时，Live2D 失败优先降级到 SpritePet 而非 PetHero */
    spriteManifest?: PetManifest;
    spriteState?: PetSheetState;
    spriteToolActivity?: PetToolActivity;
  }>(),
  {
    spriteManifest: undefined,
    spriteState: 'idle',
    spriteToolActivity: 'idle',
  },
);

const emit = defineEmits<{ onSpeak: [text: string, preset?: string] }>();

function forwardSpeak(text: string, preset?: string) {
  emit('onSpeak', text, preset);
}
</script>

<template>
  <Live2DPet @on-speak="forwardSpeak">
    <template #fallback>
      <SpritePet
        v-if="spriteManifest"
        :manifest="spriteManifest"
        :active-state="spriteState"
        :tool-activity="spriteToolActivity"
      />
      <PetHero v-else />
    </template>
  </Live2DPet>
</template>
