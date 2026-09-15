<script setup lang="ts">
import { GraduationCap } from 'lucide-vue-next';
import { useWorkbenchContext } from '../../composables/workbench-context';

const { layout } = useWorkbenchContext();

function handleClick() {
  if (layout?.runMenuAction) {
    layout.runMenuAction(() => layout.openTool('study'));
  } else {
    layout?.openTool?.('study');
  }
}
</script>

<template>
  <button
    class="menu-item focus-nav-menu-item"
    type="button"
    aria-label="学习能力"
    @click.stop="handleClick"
  >
    <GraduationCap :size="16" />
    <span>学习能力</span>
  </button>
</template>
