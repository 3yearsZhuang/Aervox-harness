<script setup lang="ts">
import { ChevronRight, CircleHelp, Clock3, Pause, Play, Plus, Puzzle, TimerReset, X } from 'lucide-vue-next';
import ExtensionSlot from '../extension/ExtensionSlot.vue';
import { useWorkbenchContext } from '../../composables/workbench-context';

const { layout, timer, cards } = useWorkbenchContext();
const { assistantDisplayName, studyModeEnabled, openTool } = layout;
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
  questionCardData,
  questionCardSelected,
  handleQuestionCardOption,
  submitQuestionCardAnswers,
  selectCard,
  activateCard,
  isCardPicked,
  openDailyProblem,
} = cards;
</script>

<template>
  <aside class="side-cards" aria-label="功能卡片">
    <div v-for="(card, slotIndex) in slotCards" :key="slotIndex" class="side-card-slot">
      <Transition name="card-swap" mode="out-in">
        <div :key="slotIndex === 0 && questionCardData ? 'question' : card?.id ?? 'placeholder'" class="side-card-slot-inner">
          <!-- UQ-01: AI 提问时第一槽临时切换为提问卡，作答后自动恢复 -->
          <article
            v-if="slotIndex === 0 && questionCardData"
            class="side-card side-question-card"
            role="region"
            tabindex="0"
            :aria-label="`${assistantDisplayName}想问你`"
          >
            <header class="side-card-head">
              <span class="side-card-icon"><CircleHelp :size="24" /></span>
              <span class="side-card-title">
                <strong>{{ assistantDisplayName }}想问你</strong>
                <small>点选选项作答，答完卡片自动恢复</small>
              </span>
            </header>
            <p class="side-card-summary side-question-text">{{ questionCardData.question }}</p>
            <div v-if="questionCardData.options?.length" class="side-card-grid side-question-options">
              <button
                v-for="option in questionCardData.options"
                :key="option.label"
                type="button"
                class="side-card-grid-item"
                :class="{ picked: questionCardSelected.includes(option.label) }"
                @click.stop="handleQuestionCardOption(option.label)"
              >
                <span>{{ option.label }}</span>
              </button>
            </div>
            <button
              v-if="questionCardData.multiSelect && questionCardData.options?.length"
              type="button"
              class="side-question-submit"
              :disabled="questionCardSelected.length === 0"
              @click.stop="submitQuestionCardAnswers()"
            >
              {{ `提交（已选 ${questionCardSelected.length}）` }}
            </button>
            <footer class="side-card-foot">
              <span>正在等待你的回答…</span>
            </footer>
          </article>

          <article
            v-else-if="card"
            class="side-card"
            role="region"
            tabindex="0"
            :aria-label="`打开${card.label}`"
            @click="activateCard(card, $event)"
            @keydown.enter="activateCard(card, $event)"
          >
            <header class="side-card-head">
              <span class="side-card-icon"><component :is="card.icon" :size="24" /></span>
              <span class="side-card-title">
                <strong>{{ card.label }}</strong>
                <small>{{ card.description }}</small>
              </span>
              <button class="side-card-remove" type="button" aria-label="移除此卡片" @click.stop="selectCard(slotIndex, null, $event)">
                <X :size="15" />
              </button>
            </header>
            <p class="side-card-summary">{{ card.summary() }}</p>
            <!-- 番茄钟基础操作 -->
            <div v-if="card.id === 'timer'" class="timer-card-ops">
              <div v-if="!timerRunning" class="timer-card-presets" role="radiogroup" aria-label="快捷预设时长">
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
            <!-- 学习模式下的今日学习富卡片 -->
            <div v-if="card.id === 'study' && studyModeEnabled" class="side-card-grid side-card-actions">
              <button type="button" class="side-card-grid-item" @click.stop="openDailyProblem()">
                <CircleHelp :size="15" />
                <span>每日一题</span>
              </button>
              <button type="button" class="side-card-grid-item" @click.stop="openTool('timer')">
                <Clock3 :size="15" />
                <span>开始专注</span>
              </button>
              <button type="button" class="side-card-grid-item" @click.stop="openTool('mistake')">
                <Puzzle :size="15" />
                <span>错题重练</span>
              </button>
            </div>
            <footer class="side-card-foot">
              <span>点击打开</span>
              <ChevronRight :size="15" />
            </footer>
          </article>

          <div v-else class="side-card side-card-placeholder" role="group" aria-label="为此卡片选择功能">
            <header class="side-card-head">
              <span class="side-card-icon"><Plus :size="17" /></span>
              <span class="side-card-title">
                <strong>选择功能</strong>
                <small>把常用工具放到这里</small>
              </span>
            </header>
            <div class="side-card-grid">
              <button
                v-for="option in cardCatalog"
                :key="option.id"
                type="button"
                class="side-card-grid-item"
                :disabled="isCardPicked(option.id)"
                @click="selectCard(slotIndex, option.id, $event)"
              >
                <component :is="option.icon" :size="15" />
                <span>{{ option.label }}</span>
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </div>
    <ExtensionSlot name="sidecards:widgets" />
  </aside>
</template>
