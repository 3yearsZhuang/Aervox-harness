<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue';
import { Sparkles } from 'lucide-vue-next';
import { useWorkbenchContext } from '@aervox/ui/plugin-api';
import TermExploreDialog from './TermExploreDialog.vue';
import { useFocusModeState } from './plugin-state';
const { focusModeEnabled } = useFocusModeState();
import { createTermsState } from './plugin-events';
const { exploreDialogOpen, extractedTerms, openTermExplore, resetTermsState, selectedTerm, subscribeTermsEvents } = createTermsState();

const { conversation, pluginEvents } = useWorkbenchContext();
const { streaming, latestAssistantLine } = conversation;

// CR-060：术语状态归插件；宿主只提供通用事件总线，不解释事件语义
const unsubscribe = subscribeTermsEvents(pluginEvents);
onBeforeUnmount(() => unsubscribe());

// 新回合开始即清空上一轮概念，避免跨轮残留
watch(streaming, (isStreaming) => {
  if (isStreaming) resetTermsState();
});
</script>

<template>
  <div class="study-terms-section">
    <div v-if="focusModeEnabled && extractedTerms.length > 0 && !streaming" class="message-terms-bar">
      <div class="terms-bar-label">
        <Sparkles :size="13" />
        <span>核心概念</span>
      </div>
      <div class="terms-chips-list">
        <button
          v-for="t in extractedTerms"
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
