<script setup lang="ts">
import { AervoxButton, AervoxCard } from '../../primitives';
import { computed } from 'vue';
import { ChevronDown, ChevronRight, ChevronUp, History, MessageSquare } from 'lucide-vue-next';
import ExtensionSlot from '../extension/ExtensionSlot.vue';
import ToolApprovalCard from './ToolApprovalCard.vue';
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
const isGreeting = computed(() => conversation.story.value.length === 1
  && latestAssistantLine.value?.state !== 'streaming');
</script>

<template>
  <AervoxCard as="section" class="message-panel companion-panel" :class="{ collapsed: consoleCollapsed }" aria-label="伴学对话">
    <ExtensionSlot name="conversation:top" />

    <header class="companion-panel-head">
      <MessageSquare class="companion-panel-icon" :size="18" aria-hidden="true" />
      <span class="companion-panel-title">{{ assistantDisplayName }}</span>
      <span v-if="consoleCollapsed" class="console-collapsed-text">{{ collapsedSummaryText }}</span>
      <AervoxButton variant="ghost" icon-only
        type="button"
        class="companion-panel-action console-collapse-toggle"
        :title="consoleCollapsed ? '展开对话' : '收起对话'"
        :aria-label="consoleCollapsed ? '展开对话区域' : '收起对话区域'"
        :aria-expanded="!consoleCollapsed"
        @click="consoleCollapsed = !consoleCollapsed"
      >
        <ChevronDown v-if="consoleCollapsed" :size="16" />
        <ChevronUp v-else :size="16" />
      </AervoxButton>
    </header>

    <div v-show="!consoleCollapsed" ref="storyViewport" class="message-viewport" aria-live="polite">
      <p
        v-if="latestAssistantLine"
        class="message-line"
        :class="latestAssistantLine.state"
      >
        <span v-if="latestAssistantLine.state === 'streaming'" class="message-text">
          <span class="markdown-body" v-html="renderMarkdown(novelStreamingText)" />
          <i class="stream-cursor" aria-hidden="true" />
        </span>
        <span v-else class="message-text message-novel-text">
          <!-- 视觉小说分句（切换模式）：:key 随句索引变化，整句替换触发切换动画 -->
          <span :key="novelIndex" class="markdown-body" v-html="renderMarkdown((isGreeting ? latestAssistantLine.text : novelDisplayText) || '正在连接 Aervox…')" />
          <span v-if="!isGreeting" class="novel-meta-row">
            <!-- 进度指示：仅在存在多句时展示「1/3 句」，单句时隐藏避免干扰 -->
            <small v-if="novelSentences.length > 1" class="novel-progress">
              {{ novelIndex + 1 }} / {{ novelSentences.length }} 句
            </small>
            <!-- 下一句切换按钮：有待释放句子时高亮显示气泡角标，点击切至下一句 -->
            <AervoxButton variant="secondary"
              v-if="hasQueuedSentence"
              type="button"
              class="novel-next-btn"
              title="下一句（或按空格）"
              aria-label="显示下一句"
              @click.stop="showNextSentence"
            >
              <span>下一句</span>
              <span class="aervox-badge novel-next-badge">+{{ queuedSentenceCount }}</span>
              <ChevronRight :size="13" />
            </AervoxButton>
            <ExtensionSlot
              name="message:bubble-actions"
              :context="{
                message: latestAssistantLine,
                text: latestAssistantLine?.text,
                sentence: novelDisplayText,
                index: novelIndex,
                sentences: novelSentences,
              }"
              wrapper-class="novel-bubble-actions-slot"
            />
          </span>
        </span>
      </p>

      <ToolApprovalCard />
    </div>

    <footer v-if="!isGreeting && !consoleCollapsed" class="companion-panel-footer">
      <AervoxButton variant="ghost" class="message-history-entry" type="button" @click="historyOpen = true">
        <History :size="14" />
        <span>回看完整对话</span>
      </AervoxButton>
    </footer>

    <ExtensionSlot name="conversation:bottom" />
  </AervoxCard>
</template>
