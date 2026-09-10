<script setup lang="ts">
import { Sparkles } from 'lucide-vue-next';
import { useWorkbenchContext } from '../../composables/workbench-context';
import TermExploreDialog from './TermExploreDialog.vue';

const { layout, conversation } = useWorkbenchContext();
const { focusModeEnabled } = layout;
const {
  currentExtractedTerms,
  streaming,
  openTermExplore,
  exploreDialogOpen,
  selectedTerm,
  latestAssistantLine,
} = conversation;
</script>

<template>
  <div class="study-terms-section">
    <div v-if="focusModeEnabled && currentExtractedTerms.length > 0 && !streaming" class="message-terms-bar">
      <div class="terms-bar-label">
        <Sparkles :size="13" />
        <span>核心概念</span>
      </div>
      <div class="terms-chips-list">
        <button
          v-for="t in currentExtractedTerms"
          :key="t.text"
          type="button"
          class="term-chip"
          :class="t.relation"
          title="点击查看名词解释与深度追问"
          @click="openTermExplore(t)"
        >
          <span class="term-chip-text">{{ t.text }}</span>
          <span class="term-chip-badge">{{ t.relation === 'background' ? '深挖' : '对比' }}</span>
        </button>
      </div>
    </div>

    <!-- 术语名词解释弹窗：由专注模式模块自包含管理 -->
    <TermExploreDialog
      v-model="exploreDialogOpen"
      :term="selectedTerm"
      :context-text="latestAssistantLine?.text"
    />
  </div>
</template>
