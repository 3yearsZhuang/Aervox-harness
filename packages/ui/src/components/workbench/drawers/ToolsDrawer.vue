<script setup lang="ts">
import {
  Check,
  History,
  NotebookPen,
  Pause,
  Play,
  Plus,
  RotateCcw,
  TimerReset,
} from 'lucide-vue-next';
import { useWorkbenchContext } from '../../../composables/workbench-context';
import { renderMarkdown } from '../../../utils/markdown';
import { DIAL_RADIUS, DIAL_CIRCUMFERENCE } from '../../../composables/useWorkbenchTimer';

const { layout, timer, cards, conversation } = useWorkbenchContext();
const {
  toolsOpen,
  activeToolView,
  toolsNavItems,
  switchToolView,
  historyOpen,
} = layout;

const {
  timerMinutes,
  timerRunning,
  timerDialRef,
  isDraggingDial,
  formattedTime,
  timerArcDashoffset,
  thumbAngle,
  toggleTimer,
  resetTimer,
  selectPresetMinutes,
  handleDialPointerDown,
} = timer;

const {
  todos,
  newTodo,
  unfinishedTodos,
  completedTodoCount,
  syncGoals,
  syncReviewCount,
  syncedTodoCount,
  goalBusyId,
  addTodo,
  completeGoalFromTodo,
  toggleGoalPausedFromTodo,
  todayDiary,
  viewingDiary,
  diaryHistory,
  diaryBusy,
  diaryError,
  diaryDisplayContent,
  generateDiaryNow,
  selectDiaryDate,
  completeReview,
  reviewBusyId,
} = cards;

const { story } = conversation;
</script>

<template>
  <el-dialog
    v-model="toolsOpen"
    title="工具管理"
    class="tools-dialog"
    width="min(860px, calc(100vw - 28px))"
    align-center
  >
    <div class="tool-dialog-layout">
      <nav class="tool-sidebar" aria-label="工具导航">
        <button
          v-for="item in toolsNavItems"
          :key="item.id"
          type="button"
          :class="{ active: item.id === activeToolView }"
          :aria-current="item.id === activeToolView ? 'true' : undefined"
          @click="switchToolView(item.id)"
        >
          <component :is="item.icon" :size="18" />
          <span><strong>{{ item.label }}</strong><small>{{ item.description }}</small></span>
        </button>
      </nav>
      <div class="tool-dialog-content" :class="{ 'content-centered': activeToolView === 'timer' }">
        <template v-if="activeToolView === 'todo'">
          <p class="drawer-intro">用小任务保持节奏，不需要一次完成所有事情。</p>
          <form class="todo-form" @submit.prevent="addTodo">
            <label class="sr-only" for="new-todo">添加待办</label>
            <input id="new-todo" v-model="newTodo" placeholder="添加一件小事" />
            <button type="submit" aria-label="添加待办"><Plus :size="20" /></button>
          </form>
          <div class="todo-summary">
            已完成 {{ completedTodoCount }} 件 · 待完成 {{ unfinishedTodos.length + syncedTodoCount }} 件（含学习同步）
          </div>
          <div class="todo-list">
            <label v-for="todo in todos" :key="todo.id" class="todo-item" :class="{ done: todo.done }">
              <input v-model="todo.done" type="checkbox" />
              <span>{{ todo.text }}</span>
              <Check v-if="todo.done" :size="18" />
            </label>
            <p v-if="todos.length === 0" class="drawer-empty">暂无待办，先从一件五分钟能完成的小事开始。</p>
          </div>

          <!-- 学习同步：进行中目标 + 到期复习 -->
          <div v-if="syncGoals.length > 0 || syncReviewCount > 0" class="settings-section" style="margin-top: 18px;">
            <h4>学习同步 <small>{{ syncedTodoCount }}</small></h4>
            <ul class="study-list">
              <li v-for="goal in syncGoals" :key="goal.id">
                <label class="todo-item" :class="{ done: goal.status === 'completed' }">
                  <input
                    type="checkbox"
                    :disabled="goalBusyId === goal.id"
                    @change="completeGoalFromTodo(goal.id)"
                  />
                  <span>目标：{{ goal.topic }} · {{ goal.availableMinutes }} 分钟/天</span>
                </label>
                <div class="goal-actions">
                  <button v-if="goal.status === 'active'" type="button" :disabled="goalBusyId === goal.id" @click="toggleGoalPausedFromTodo(goal.id, 'paused')">
                    <Pause :size="14" />暂停
                  </button>
                  <button v-else type="button" :disabled="goalBusyId === goal.id" @click="toggleGoalPausedFromTodo(goal.id, 'active')">
                    <Play :size="14" />继续
                  </button>
                </div>
              </li>
              <li v-for="item in cards.api.dueReviews.value" :key="item.id">
                <label class="todo-item">
                  <input
                    type="checkbox"
                    :disabled="reviewBusyId === item.id"
                    @change="completeReview(item.id, true)"
                  />
                  <span>复习：知识点 #{{ item.knowledgeId }} · 间隔 {{ item.intervalDays }} 天</span>
                </label>
                <div class="goal-actions">
                  <button type="button" :disabled="reviewBusyId === item.id" @click="completeReview(item.id, false)">
                    <RotateCcw :size="14" />忘了
                  </button>
                </div>
              </li>
            </ul>
          </div>
        </template>

        <template v-else-if="activeToolView === 'timer'">
          <div class="timer-panel">
            <div
              class="timer-dial-wrapper"
              :class="{ running: timerRunning, dragging: isDraggingDial }"
              @mousedown="handleDialPointerDown"
              @touchstart="handleDialPointerDown"
            >
              <svg
                ref="timerDialRef"
                class="timer-dial-svg"
                viewBox="0 0 200 200"
                aria-hidden="true"
              >
                <circle
                  class="timer-dial-track"
                  cx="100"
                  cy="100"
                  :r="DIAL_RADIUS"
                />
                <circle
                  class="timer-dial-progress"
                  cx="100"
                  cy="100"
                  :r="DIAL_RADIUS"
                  :stroke-dasharray="DIAL_CIRCUMFERENCE"
                  :stroke-dashoffset="timerArcDashoffset"
                />
                <g
                  v-if="!timerRunning"
                  class="timer-dial-thumb-group"
                  :style="{ transform: `rotate(${thumbAngle}deg)` }"
                >
                  <circle
                    class="timer-dial-thumb-halo"
                    cx="180"
                    cy="100"
                    r="13"
                  />
                  <circle
                    class="timer-dial-thumb"
                    cx="180"
                    cy="100"
                    r="7.5"
                  />
                </g>
              </svg>
              <div class="timer-dial-center">
                <strong>{{ formattedTime }}</strong>
                <small>{{ timerRunning ? '专注中' : '专注时间' }}</small>
              </div>
            </div>

            <p class="timer-guide-text">
              {{ timerRunning ? '保持当前节奏，结束后记得休息。' : `滑动圆环设定 ${timerMinutes} 分钟专注回合` }}
            </p>

            <div v-if="!timerRunning" class="timer-presets" role="radiogroup" aria-label="快捷预设时长">
              <button
                v-for="preset in [15, 25, 45, 60]"
                :key="preset"
                type="button"
                class="timer-preset-btn"
                :class="{ active: timerMinutes === preset }"
                @click="selectPresetMinutes(preset)"
              >
                {{ preset }} 分钟
              </button>
            </div>

            <div class="timer-actions">
              <button type="button" @click="toggleTimer">
                <Pause v-if="timerRunning" :size="20" />
                <Play v-else :size="20" />
                {{ timerRunning ? '暂停' : '开始专注' }}
              </button>
              <button type="button" @click="resetTimer">
                <TimerReset :size="20" />
                重置
              </button>
            </div>
          </div>
        </template>

        <template v-else-if="activeToolView === 'history'">
          <p class="drawer-intro">完整上下文回看：视觉小说式滚动浏览与思隅的全部对话。</p>
          <div class="diary-actions">
            <button type="button" class="diary-generate-btn" @click="historyOpen = true">
              <History :size="16" />
              <span>打开对话回看（{{ story.length }} 条记录）</span>
            </button>
          </div>
        </template>

        <template v-else-if="activeToolView === 'diary'">
          <p class="drawer-intro">思思根据今天我们一起聊过、记下和做过的事，替你写一篇日记。</p>
          <div class="diary-actions">
            <button type="button" class="diary-generate-btn" :disabled="diaryBusy" @click="generateDiaryNow">
              <NotebookPen v-if="!diaryBusy" :size="16" />
              <span>{{ diaryBusy ? '思思正在写…' : (viewingDiary ? '让思思改写今天的' : '让思思现在写') }}</span>
            </button>
          </div>
          <p v-if="diaryError" class="drawer-empty" role="alert">{{ diaryError }}</p>
          <article v-if="viewingDiary" class="diary-card">
            <header class="diary-head">
              <strong>{{ viewingDiary.title }}</strong>
              <small class="diary-meta">{{ viewingDiary.localDate }} · {{ viewingDiary.generatedBy === 'template' ? '模板生成' : '思思手写' }}</small>
            </header>
            <div class="markdown-body diary-body" v-html="renderMarkdown(diaryDisplayContent)" />
          </article>
          <p v-else-if="!diaryBusy" class="drawer-empty">今天还没有日记，点上面的按钮让思思写一篇。</p>

          <div v-if="diaryHistory.length > 0" class="settings-section" style="margin-top: 20px;">
            <h4>历史日记 <small>{{ diaryHistory.length }}</small></h4>
            <ul class="diary-history-list">
              <li v-for="item in diaryHistory" :key="item.localDate">
                <button type="button" :class="{ active: viewingDiary?.localDate === item.localDate }" @click="selectDiaryDate(item.localDate)">
                  <span class="diary-history-date">{{ item.localDate }}</span>
                  <span class="diary-history-title">{{ item.title }}</span>
                </button>
              </li>
            </ul>
          </div>
        </template>
      </div>
    </div>
  </el-dialog>
</template>
