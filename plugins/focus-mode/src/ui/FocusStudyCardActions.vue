<script setup lang="ts">
import { CircleHelp, Clock3, Puzzle } from 'lucide-vue-next';
import { useWorkbenchContext } from '@aervox/ui/plugin-api';
import { useFocusModeState } from './plugin-state';
const { focusModeEnabled, openLearningView } = useFocusModeState();
import { openDailyProblem } from './daily-problem';

const { layout } = useWorkbenchContext();

function handleDailyProblem() {
  openDailyProblem();
}

function handleStartTimer() {
  layout?.openTool?.('timer');
}

function handleOpenMistakes() {
  openLearningView('mistake');
}
</script>

<template>
  <div
    v-if="focusModeEnabled"
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
