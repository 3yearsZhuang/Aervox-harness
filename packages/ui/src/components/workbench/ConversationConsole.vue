<script setup lang="ts">
import { ChevronDown, ChevronRight, ChevronUp, History } from 'lucide-vue-next';
import ExtensionSlot from '../extension/ExtensionSlot.vue';
import ToolApprovalCard from './ToolApprovalCard.vue';
import TermsBar from './TermsBar.vue';
import { useWorkbenchContext } from '../../composables/workbench-context';
import { renderMarkdown } from '../../utils/markdown';

const { layout, conversation } = useWorkbenchContext();
const { assistantDisplayName, historyOpen } = layout;
const {
  consoleCollapsed,
  collapsedSummaryText,
  storyViewport,
  latestAssistantLine,
  novelStreamingText,
  novelIndex,
  novelDisplayText,
  novelSentences,
  hasQueuedSentence,
  queuedSentenceCount,
  showNextSentence,
} = conversation;
</script>

<template>
  <section class="message-panel" :class="{ collapsed: consoleCollapsed }" aria-label="伴学对话">
    <ExtensionSlot name="conversation:top" />

    <!-- 收起态摘要行：说话人 + 当前句单行省略（视觉小说细条） -->
    <div v-if="consoleCollapsed" class="console-collapsed-summary" aria-hidden="true">
      <span class="console-collapsed-speaker">{{ assistantDisplayName }}</span>
      <span class="console-collapsed-text">{{ collapsedSummaryText }}</span>
    </div>

    <div ref="storyViewport" class="message-viewport" aria-live="polite">
      <p
        v-if="latestAssistantLine"
        class="message-line"
        :class="latestAssistantLine.state"
      >
        <span class="message-speaker">{{ assistantDisplayName }}</span>
        <span v-if="latestAssistantLine.state === 'streaming'" class="message-text">
          <span class="markdown-body" v-html="renderMarkdown(novelStreamingText)" />
          <i class="stream-cursor" aria-hidden="true" />
        </span>
        <span v-else class="message-text message-novel-text">
          <!-- 视觉小说分句（切换模式）：:key 随句索引变化，整句替换触发切换动画 -->
          <span :key="novelIndex" class="markdown-body" v-html="renderMarkdown(novelDisplayText || '正在连接 Aervox…')" />
          <span class="novel-meta-row">
            <!-- 进度指示：仅在存在多句时展示「1/3 句」，单句时隐藏避免干扰 -->
            <small v-if="novelSentences.length > 1" class="novel-progress">
              {{ novelIndex + 1 }} / {{ novelSentences.length }} 句
            </small>
            <!-- 下一句切换按钮：有待释放句子时高亮显示气泡角标，点击切至下一句 -->
            <button
              v-if="hasQueuedSentence"
              type="button"
              class="novel-next-btn"
              title="下一句（或按空格）"
              aria-label="显示下一句"
              @click.stop="showNextSentence"
            >
              <span>下一句</span>
              <span class="novel-next-badge">+{{ queuedSentenceCount }}</span>
              <ChevronRight :size="13" />
            </button>
          </span>
        </span>
      </p>

      <ToolApprovalCard />
      <TermsBar />
    </div>

    <button class="message-history-entry" type="button" @click="historyOpen = true">
      <History :size="14" />
      <span>回看完整对话</span>
    </button>

    <!-- 收起/展开开关：右上角常驻，收起态仍留在细条上 -->
    <button
      type="button"
      class="console-collapse-toggle"
      :aria-label="consoleCollapsed ? '展开对话区域' : '收起对话区域'"
      :aria-expanded="!consoleCollapsed"
      @click="consoleCollapsed = !consoleCollapsed"
    >
      <ChevronDown v-if="consoleCollapsed" :size="14" />
      <ChevronUp v-else :size="14" />
    </button>

    <ExtensionSlot name="conversation:bottom" />
  </section>
</template>
