<script setup lang="ts">
import { computed } from 'vue';
import {
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  Clock3,
  Database,
  GraduationCap,
  NotebookPen,
  Zap,
} from 'lucide-vue-next';
import { useWorkbenchContext } from '../../../composables/workbench-context';

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

function goToReview() {
  taskCenterOpen.value = false;
  openTool('mistake');
}

function goToStudy() {
  taskCenterOpen.value = false;
  openTool('study');
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
  <el-dialog
    v-model="taskCenterOpen"
    title="统一任务中心"
    class="task-center-dialog"
    width="min(760px, calc(100vw - 32px))"
    align-center
  >
    <div class="task-center-body">
      <p class="task-center-intro">
        集中管理本地排期、复习规划、日记提炼与后台守护任务。所有状态均由纯本地 SQLite 驱动。
      </p>

      <div class="task-card-grid">
        <!-- 学习与错题排期 -->
        <div class="task-summary-card">
          <div class="task-card-header">
            <div class="task-card-icon study-icon">
              <GraduationCap :size="20" />
            </div>
            <div class="task-card-meta">
              <h4>间隔复习与错题排期</h4>
              <span class="task-status-tag" :class="{ 'tag-active': cards.syncReviewCount.value > 0 }">
                {{ cards.syncReviewCount.value > 0 ? `${cards.syncReviewCount.value} 个待复习` : '今日已全部完成' }}
              </span>
            </div>
          </div>
          <p class="task-card-desc">
            基于艾宾浩斯曲线与认知遗忘规律，自动排期需要强化的错题与核心概念。
          </p>
          <div class="task-card-actions">
            <button type="button" class="task-link-btn" @click="goToReview">
              <span>进入错题复习</span>
              <ArrowRight :size="14" />
            </button>
            <button type="button" class="task-sub-btn" @click="goToStudy">
              <span>学习规划</span>
            </button>
          </div>
        </div>

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
  </el-dialog>
</template>
