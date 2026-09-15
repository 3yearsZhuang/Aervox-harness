<script setup lang="ts">
import { computed } from 'vue';
import {
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  Clock3,
  Database,
  NotebookPen,
  Zap,
} from 'lucide-vue-next';
import ExtensionSlot from '../../extension/ExtensionSlot.vue';
import { useWorkbenchContext } from '../../../composables/workbench-context';
import { AervoxDialog } from '../../../primitives';

const { layout, cards, timer } = useWorkbenchContext();
const { taskCenterOpen, openTool, openSettingsCategory } = layout;


const diaryStatusText = computed(() => {
  if (cards.todayDiary.value?.content) return '今日日记已提炼完成';
  return '今日对话尚在积累中，稍后由 Worker 自动提炼';
});

const isDiaryDone = computed(() => Boolean(cards.todayDiary.value?.content));

function goToDiary() {
  taskCenterOpen.value = false;
  openTool('diary');
}

function goToTimer() {
  taskCenterOpen.value = false;
  openTool('timer');
}

function goToProactive() {
  taskCenterOpen.value = false;
  openSettingsCategory('proactive');
}
</script>

<template>
  <AervoxDialog
    v-model="taskCenterOpen"
    title="统一任务中心"
    subtitle="集中管理本地排期、复习规划、日记提炼与后台守护任务"
    :icon="Zap"
    size="lg"
  >

    <div class="task-center-body">
      <p class="task-center-intro">
        集中管理本地排期、复习规划、日记提炼与后台守护任务。所有状态均由纯本地 SQLite 驱动。
      </p>

      <div class="task-card-grid">
        <!-- 插件注入任务卡片（例如专注模式的间隔复习与错题排期） -->
        <ExtensionSlot name="taskcenter:cards" />

        <!-- 每日日记提炼 -->
        <div class="task-summary-card">
          <div class="task-card-header">
            <div class="task-card-icon diary-icon">
              <NotebookPen :size="20" />
            </div>
            <div class="task-card-meta">
              <h4>每日对话提炼与日记本</h4>
              <span class="task-status-tag" :class="{ 'tag-success': isDiaryDone }">
                {{ isDiaryDone ? '今日已提炼' : '待提炼' }}
              </span>
            </div>
          </div>
          <p class="task-card-desc">{{ diaryStatusText }}</p>
          <div class="task-card-actions">
            <button type="button" class="task-link-btn" @click="goToDiary">
              <span>查看日记本</span>
              <ArrowRight :size="14" />
            </button>
          </div>
        </div>

        <!-- 专注时钟与节奏 -->
        <div class="task-summary-card">
          <div class="task-card-header">
            <div class="task-card-icon timer-icon">
              <Clock3 :size="20" />
            </div>
            <div class="task-card-meta">
              <h4>番茄专注钟</h4>
              <span class="task-status-tag" :class="{ 'tag-running': timer.timerRunning.value }">
                {{ timer.timerRunning.value ? `进行中 · ${timer.formattedTime.value}` : `就绪 · ${timer.timerMinutes.value} 分钟` }}
              </span>
            </div>
          </div>
          <p class="task-card-desc">
            保持学习心流状态，劳逸结合。专注倒计时与桌宠反馈紧密联动。
          </p>
          <div class="task-card-actions">
            <button type="button" class="task-link-btn" @click="goToTimer">
              <span>{{ timer.timerRunning.value ? '管理当前计时' : '开启专注计时' }}</span>
              <ArrowRight :size="14" />
            </button>
          </div>
        </div>

        <!-- 主动智能与规则引擎 -->
        <div class="task-summary-card">
          <div class="task-card-header">
            <div class="task-card-icon proactive-icon">
              <BrainCircuit :size="20" />
            </div>
            <div class="task-card-meta">
              <h4>主动智能与规则策略</h4>
              <span class="task-status-tag tag-normal">
                画像已加载
              </span>
            </div>
          </div>
          <p class="task-card-desc">
            本地运行的端侧智能决策，在不打扰用户的前提下捕捉疲劳、复习节点与提醒时机。
          </p>
          <div class="task-card-actions">
            <button type="button" class="task-link-btn" @click="goToProactive">
              <span>主动智能设置</span>
              <ArrowRight :size="14" />
            </button>
          </div>
        </div>
      </div>

      <!-- 系统与存储真源状态 -->
      <div class="task-system-status">
        <div class="status-item">
          <Database :size="15" />
          <span>本地 SQLite 单库真源 (WAL 模式)</span>
        </div>
        <div class="status-item">
          <CheckCircle2 :size="15" class="text-success" />
          <span>去租户化纯本地隔离 (LocalContext)</span>
        </div>
        <div class="status-item">
          <Zap :size="15" />
          <span>Outbox 事务调度引擎正常</span>
        </div>
      </div>
    </div>
  </AervoxDialog>
</template>

