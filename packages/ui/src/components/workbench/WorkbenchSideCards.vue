<script setup lang="ts">
import { AervoxButton, AervoxCard } from '../../primitives';
import { computed, nextTick, ref } from 'vue';
import { Check, ChevronRight, Pause, Play, Plus, TimerReset, X } from 'lucide-vue-next';
import ExtensionSlot from '../extension/ExtensionSlot.vue';
import UserQuestionComposer from '../UserQuestionComposer.vue';
import { useWorkbenchContext } from '../../composables/workbench-context';

const { timer, cards, conversation } = useWorkbenchContext();
const { activeQuestion, questionSubmitting, handleQuestionSubmit } = conversation;
const {
  timerRunning,
  timerMinutes,
  toggleTimer,
  resetTimer,
  selectPresetMinutes,
} = timer;
const {
  slotCards,
  cardCatalog,
  selectCard,
  activateCard,
  isCardPicked,
} = cards;

const pickerOpen = ref(false);
const pickerRoot = ref<HTMLElement | null>(null);
const visibleSlots = computed(() => slotCards.value
  .map((card, slotIndex) => ({ card, slotIndex }))
  .filter(({ card, slotIndex }) => card || (slotIndex === 0 && activeQuestion.value)));
const availableSlot = computed(() => slotCards.value.findIndex(
  (card, index) => !card && !(index === 0 && activeQuestion.value),
));

function addCard(id: string, event: MouseEvent) {
  if (availableSlot.value < 0) return;
  selectCard(availableSlot.value, id, event);
  closePicker();
}

function closePicker() {
  if (!pickerOpen.value) return;
  pickerOpen.value = false;
  void nextTick(() => pickerRoot.value?.querySelector<HTMLButtonElement>('.side-card-add')?.focus());
}
</script>

<template>
  <aside class="side-cards" aria-label="功能卡片">
    <div v-for="({ card, slotIndex }) in visibleSlots" :key="slotIndex" class="side-card-slot">
      <Transition name="card-swap" mode="out-in">
        <div :key="slotIndex === 0 && activeQuestion ? 'question' : card?.id ?? 'placeholder'" class="side-card-slot-inner">
          <UserQuestionComposer
            v-if="slotIndex === 0 && activeQuestion"
            class="side-question-card"
            :question-data="activeQuestion"
            :submitting="questionSubmitting"
            @submit="handleQuestionSubmit"
          />

          <AervoxCard as="article"
            v-else-if="card"
            class="side-card companion-panel"
            role="region"
            tabindex="0"
            :aria-label="`打开${card.label}`"
            @click="activateCard(card, $event)"
            @keydown.enter.self="activateCard(card, $event)"
            @keydown.space.self.prevent="activateCard(card, $event)"
          >
            <header class="side-card-head companion-panel-head">
              <span class="side-card-icon" aria-hidden="true"><component :is="card.icon" :size="22" /></span>
              <span class="side-card-title">
                <strong class="companion-panel-title">{{ card.label }}</strong>
                <small>{{ card.description }}</small>
              </span>
              <AervoxButton variant="ghost" icon-only class="side-card-remove companion-panel-action" type="button" :aria-label="`移除${card.label}卡片`" title="移除此卡片" @click.stop="selectCard(slotIndex, null, $event)">
                <X :size="15" />
              </AervoxButton>
            </header>
            <p class="side-card-summary">{{ card.summary() }}</p>
            <!-- 番茄钟基础操作 -->
            <div v-if="card.id === 'timer'" class="timer-card-ops">
              <div v-if="!timerRunning" class="timer-card-presets" role="group" aria-label="快捷预设时长">
                <button
                  v-for="preset in [15, 25, 45, 60]"
                  :key="preset"
                  type="button"
                  class="timer-chip"
                  :class="{ active: timerMinutes === preset }"
                  :aria-pressed="timerMinutes === preset"
                  @click.stop="selectPresetMinutes(preset)"
                >
                  {{ preset }}分
                </button>
              </div>
              <div class="timer-card-actions">
                <button type="button" class="side-card-grid-item" @click.stop="toggleTimer()">
                  <Pause v-if="timerRunning" :size="15" />
                  <Play v-else :size="15" />
                  <span>{{ timerRunning ? '暂停专注' : '开始专注' }}</span>
                </button>
                <button type="button" class="side-card-grid-item" @click.stop="resetTimer()">
                  <TimerReset :size="15" />
                  <span>重置</span>
                </button>
              </div>
            </div>
            <!-- 卡片自定义扩展操作区（由 CardDefinition.extraComponent 动态挂载） -->
            <component :is="card.extraComponent" v-if="card.extraComponent" />
            <footer class="side-card-foot companion-panel-footer">
              <span>点击打开</span>
              <ChevronRight :size="15" />
            </footer>
          </AervoxCard>

        </div>
      </Transition>
    </div>
    <div v-if="availableSlot >= 0" ref="pickerRoot" class="side-card-picker" @keydown.esc.stop.prevent="closePicker">
      <p v-if="visibleSlots.length === 0 && !pickerOpen" class="side-card-empty">添加常用工具，随时查看进度</p>
      <AervoxButton variant="ghost"
        class="side-card-add"
        type="button"
        :aria-expanded="pickerOpen"
        aria-controls="side-card-choices"
        @click="pickerOpen = !pickerOpen"
      >
        <Plus :size="16" />{{ pickerOpen ? '收起工具列表' : '添加工具' }}
      </AervoxButton>
      <div v-if="pickerOpen" id="side-card-choices" class="side-card-grid" aria-label="选择要添加的工具">
        <button
          v-for="option in cardCatalog"
          :key="option.id"
          type="button"
          class="side-card-grid-item"
          :class="{ 'is-added': isCardPicked(option.id) }"
          :disabled="isCardPicked(option.id)"
          @click="addCard(option.id, $event)"
        >
          <component :is="option.icon" :size="15" /><span>{{ option.label }}</span>
          <Check v-if="isCardPicked(option.id)" class="side-card-picked-icon" :size="14" aria-label="已添加" />
        </button>
      </div>
    </div>
    <ExtensionSlot name="sidecards:widgets" />
  </aside>
</template>
