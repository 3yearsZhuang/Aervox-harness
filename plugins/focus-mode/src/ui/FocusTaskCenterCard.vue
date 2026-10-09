<script setup lang="ts">
import { ArrowRight, GraduationCap } from 'lucide-vue-next';
import { AervoxButton, AervoxCard } from '@aervox/ui/primitives';
import { useWorkbenchContext } from '@aervox/ui/plugin-api';
import { useFocusModeState } from './plugin-state';
const { openLearningView } = useFocusModeState();

const { layout, cards } = useWorkbenchContext();

function goToReview() {
  if (layout) layout.taskCenterOpen.value = false;
  openLearningView('mistake');
}

function goToStudy() {
  if (layout) layout.taskCenterOpen.value = false;
  openLearningView('study');
}
</script>

<template>
  <AervoxCard class="task-summary-card focus-task-center-card">
    <div class="task-card-header">
      <div class="task-card-icon focus-icon">
        <GraduationCap :size="20" />
      </div>
      <div class="task-card-meta">
        <h4>间隔复习与错题排期</h4>
        <span class="aervox-badge task-status-tag" :class="{ 'tag-active': (cards?.syncReviewCount?.value ?? 0) > 0 }">
          {{ (cards?.syncReviewCount?.value ?? 0) > 0 ? `${cards.syncReviewCount.value} 个待复习` : '今日已全部完成' }}
        </span>
      </div>
    </div>
    <p class="task-card-desc">
      基于艾宾浩斯曲线与认知遗忘规律，自动排期需要强化的错题与核心概念。
    </p>
    <div class="task-card-actions">
      <AervoxButton variant="secondary" type="button" class="task-link-btn" @click="goToReview">
        <span>进入错题复习</span>
        <ArrowRight :size="14" />
      </AervoxButton>
      <AervoxButton variant="secondary" type="button" class="task-sub-btn" @click="goToStudy">
        <span>学习规划</span>
      </AervoxButton>
    </div>
  </AervoxCard>
</template>
