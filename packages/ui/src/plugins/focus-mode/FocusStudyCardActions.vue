<script setup lang="ts">
import { CircleHelp, Clock3, Puzzle } from 'lucide-vue-next';
import { useWorkbenchContext } from '../../composables/workbench-context';

const { layout, cards } = useWorkbenchContext();

function handleDailyProblem() {
  if (cards?.openDailyProblem) {
    cards.openDailyProblem();
  } else {
    window.open('https://www.nowcoder.com/problem/tracker', '_blank', 'noopener,noreferrer');
  }
}

function handleStartTimer() {
  layout?.openTool?.('timer');
}

function handleOpenMistakes() {
  layout?.openTool?.('mistake');
}
</script>

<template>
  <div
    v-if="layout?.focusModeEnabled === undefined || layout?.focusModeEnabled?.value"
    class="side-card-grid side-card-actions focus-study-card-actions"
  >
    <button type="button" class="side-card-grid-item" @click.stop="handleDailyProblem">
      <CircleHelp :size="15" />
      <span>每日一题</span>
    </button>
    <button type="button" class="side-card-grid-item" @click.stop="handleStartTimer">
      <Clock3 :size="15" />
      <span>开始专注</span>
    </button>
    <button type="button" class="side-card-grid-item" @click.stop="handleOpenMistakes">
      <Puzzle :size="15" />
      <span>错题重练</span>
    </button>
  </div>
</template>
