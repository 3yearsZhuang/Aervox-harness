<script setup lang="ts">
import { computed } from 'vue';
import { GraduationCap } from 'lucide-vue-next';
import { useWorkbenchContext } from '@aervox/ui/plugin-api';
import { activeLearningView, learningOpen, openLearningView } from './plugin-state';

const { layout } = useWorkbenchContext();

const isActive = computed(() => Boolean(learningOpen.value && activeLearningView.value === 'study'));

function handleClick() {
  const open = () => openLearningView('study');
  if (layout?.runMenuAction) {
    layout.runMenuAction(open);
  } else {
    open();
  }
}
</script>

<template>
  <button
    class="menu-item focus-nav-menu-item"
    :class="{ 'is-active': isActive }"
    type="button"
    aria-label="学习能力"
    title="学习能力"
    @click.stop="handleClick"
  >
    <GraduationCap :size="16" />
    <span>学习能力</span>
  </button>
</template>
