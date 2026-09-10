<script setup lang="ts">
import { computed } from 'vue';
import {
  BookOpen,
  Check,
  Puzzle,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-vue-next';
import { useWorkbenchContext } from '../../../composables/workbench-context';

const { layout, cards } = useWorkbenchContext();
const {
  learningOpen,
  activeLearningView,
  learningNavItems,
} = layout;

const {
  api,
  visibleMistakes,
  selectedMistakeIds,
  practiceBusy,
  mistakes,
  startMistakePractice,
  mistakeFilter,
  mistakeReasonFilter,
  mistakeReasonOptions,
  practiceError,
  practiceReport,
  practiceSession,
  practiceReadyToComplete,
  finishPractice,
  currentPracticeQuestion,
  practiceIndex,
  practiceFeedback,
  practiceAnswer,
  submitPracticeAnswer,
  nextPracticeQuestion,
  mistakeReasonLabel,
  mistakeInsightDraft,
  mistakeBusyId,
  updateMistakeInsightDraft,
  saveMistakeInsight,
  setMistakeStatus,
  newPlanTopic,
  newPlanLevel,
  newPlanMinutes,
  planGenerating,
  planError,
  generatePlan,
  planBusyId,
  archivePlan,
  togglePlanTask,
  planMilestoneStatusLabel,
} = cards;

const { learningPlans, error: apiError } = api;

const hasActiveMistakes = computed(() => mistakes.value.some((item) => item.status === 'active'));

async function reloadGoals() {
  await api.loadAll();
}
</script>

<template>
  <el-dialog
    v-model="learningOpen"
    title="学习能力"
    class="learning-dialog single-panel-dialog"
    width="min(860px, calc(100vw - 28px))"
    align-center
    @open="reloadGoals"
  >
    <div class="tool-dialog-layout">
      <nav class="tool-sidebar" aria-label="学习导航">
        <button
          v-for="item in learningNavItems"
          :key="item.id"
          type="button"
          :class="{ active: item.id === activeLearningView }"
          :aria-current="item.id === activeLearningView ? 'true' : undefined"
          @click="activeLearningView = item.id"
        >
          <component :is="item.icon" :size="18" />
          <span><strong>{{ item.label }}</strong><small>{{ item.description }}</small></span>
        </button>
      </nav>
      <div class="tool-dialog-content">
        <div v-if="activeLearningView === 'study'" class="single-dialog-detail">
          <p v-if="apiError" class="drawer-error">{{ apiError }}</p>

          <!-- AI 学习规划生成 -->
          <div class="settings-section">
            <div class="settings-section-heading">
              <span class="heading-icon-wrap"><BookOpen :size="18" /></span>
              <span><strong>AI 学习规划</strong><small>输入主题，生成「里程碑 + 任务」的项目式学习路线图</small></span>
            </div>
            <form class="study-goal-form" @submit.prevent="generatePlan">
              <label class="sr-only" for="new-plan-topic">学习主题</label>
              <input id="new-plan-topic" v-model="newPlanTopic" placeholder="例如：用 Vue 写一个番茄钟应用" :disabled="planGenerating" />
              <select v-model="newPlanLevel" aria-label="学习水平" :disabled="planGenerating">
                <option value="beginner">入门</option>
                <option value="intermediate">进阶</option>
                <option value="advanced">熟练</option>
              </select>
              <select v-model.number="newPlanMinutes" aria-label="每日可用时间" :disabled="planGenerating">
                <option :value="15">15 分钟</option>
                <option :value="25">25 分钟</option>
                <option :value="45">45 分钟</option>
                <option :value="60">60 分钟</option>
              </select>
              <button type="submit" class="practice-start" :disabled="planGenerating || !newPlanTopic.trim()">
                <Sparkles :size="15" />{{ planGenerating ? '正在生成…' : 'AI 生成规划' }}
              </button>
            </form>
            <p v-if="planError" class="drawer-error">{{ planError }}</p>
            <p class="study-section-desc">生成后按里程碑推进：勾选任务即可，完成一个阶段自动解锁下一阶段。</p>
          </div>

          <!-- 我的规划列表 -->
          <div class="settings-section">
            <h4>我的规划 <small>{{ learningPlans.length }}</small></h4>
            <ul class="study-list plan-list">
              <li v-for="plan in learningPlans" :key="plan.id" class="plan-card">
                <div class="goal-item-heading">
                  <span class="study-item-title">{{ plan.title }}</span>
                  <span class="goal-status">{{ plan.dailyAvailableMinutes }} 分钟/天</span>
                </div>
                <p class="plan-description">{{ plan.description }}</p>
                <p class="plan-objective">学习目标：{{ plan.learningObjective }}</p>
                <div class="plan-gains">
                  <span v-for="gain in plan.gains" :key="gain" class="subnav-badge">{{ gain }}</span>
                </div>
                <div v-for="milestone in plan.milestones" :key="milestone.id" class="plan-milestone" :class="`is-${milestone.status}`">
                  <div class="plan-milestone-heading">
                    <span class="study-item-title">{{ milestone.order + 1 }}. {{ milestone.title }}</span>
                    <span class="goal-status" :class="{ 'is-completed': milestone.status === 'completed' }">{{ planMilestoneStatusLabel(milestone.status) }}</span>
                  </div>
                  <small v-if="milestone.completionCriteria">完成标准：{{ milestone.completionCriteria }}</small>
                  <label
                    v-for="task in milestone.tasks"
                    :key="task.id"
                    class="plan-task"
                    :class="{ done: task.status === 'done', locked: milestone.status === 'locked' }"
                  >
                    <input
                      type="checkbox"
                      :checked="task.status === 'done'"
                      :disabled="planBusyId === task.id || milestone.status === 'locked'"
                      @change="togglePlanTask(task)"
                    />
                    <span>
                      <strong>{{ task.title }}</strong>
                      <small v-if="task.description">{{ task.description }}</small>
                      <small v-if="task.hints.length" class="plan-hints">提示：{{ task.hints.join('；') }}</small>
                    </span>
                  </label>
                </div>
                <div class="goal-actions">
                  <button type="button" class="danger" :disabled="planBusyId === plan.id" @click="archivePlan(plan.id)"><X :size="14" />归档</button>
                </div>
              </li>
              <li v-if="learningPlans.length === 0" class="study-empty">还没有学习规划，输入主题让 AI 生成一份路线图。</li>
            </ul>
          </div>
        </div>

        <div v-else-if="activeLearningView === 'mistake'" class="single-dialog-detail">
          <div class="settings-section">
            <div class="settings-section-heading">
              <span class="heading-icon-wrap"><Puzzle :size="18" /></span>
              <span><strong>错题管理与重练</strong><small>针对性练习未掌握题目，记录错因洞察</small></span>
            </div>

            <div class="study-section-title-row">
              <div class="mistake-filter-summary">
                <span>当前错题 <strong>{{ visibleMistakes.length }}</strong> 题</span>
                <span v-if="selectedMistakeIds.length" class="mistake-selected-badge">已选 {{ selectedMistakeIds.length }} 题</span>
              </div>
              <button
                class="practice-start"
                type="button"
                :disabled="practiceBusy || !hasActiveMistakes"
                @click="startMistakePractice"
              >
                <RotateCcw :size="15" />{{ selectedMistakeIds.length ? `重练所选 ${selectedMistakeIds.length} 题` : '重练错题' }}
              </button>
            </div>

            <div class="mistake-filter-bar">
              <div class="mistake-status-tabs" aria-label="错题状态筛选">
                <button
                  v-for="option in (['active', 'mastered', 'dismissed', 'all'] as const)"
                  :key="option"
                  type="button"
                  class="mistake-tab-btn"
                  :class="{ active: mistakeFilter === option }"
                  @click="mistakeFilter = option"
                >
                  {{ option === 'active' ? '待掌握' : option === 'mastered' ? '已掌握' : option === 'dismissed' ? '已忽略' : '全部' }}
                </button>
              </div>

              <label class="mistake-reason-filter">错因：
                <select v-model="mistakeReasonFilter" aria-label="按错因筛选">
                  <option value="all">全部错因</option>
                  <option v-for="option in mistakeReasonOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
              </label>
            </div>

            <p v-if="practiceError" class="drawer-error">{{ practiceError }}</p>

            <!-- 练习作答面板 -->
            <article v-if="practiceReport" class="practice-report">
              <strong>本次练习完成</strong>
              <p>已作答 {{ practiceReport.answeredCount }}/{{ practiceReport.questionCount }} 题 · 正确 {{ practiceReport.correctCount }} · 错误 {{ practiceReport.incorrectCount }} · 待确认 {{ practiceReport.unverifiableCount }}</p>
              <p v-if="practiceReport.accuracy !== null">可判定题正确率：{{ Math.round(practiceReport.accuracy * 100) }}%</p>
              <p v-if="practiceReport.avgTimeSpentSec !== null">平均用时：{{ practiceReport.avgTimeSpentSec }} 秒</p>
              <div class="practice-guidance" :class="`difficulty-${practiceReport.guidance.difficulty}`">
                <strong>
                  {{ practiceReport.guidance.difficulty === 'ease' ? '📉 建议降低难度' : practiceReport.guidance.difficulty === 'increase' ? '📈 建议提高难度' : '➡️ 保持当前难度' }}
                </strong>
                <small>{{ practiceReport.guidance.message }}</small>
              </div>
              <small>{{ practiceReport.remainingCount > 0 ? `还有 ${practiceReport.remainingCount} 题未作答；` : '' }}{{ practiceReport.nextStep === 'review_scheduled' ? '错题已进入后续复习。' : practiceReport.nextStep === 'await_review' ? '待确认题暂不计入掌握度。' : '继续保持这个节奏。' }}</small>
            </article>
            <article v-else-if="practiceSession && practiceReadyToComplete" class="practice-panel">
              <strong>本次答案已保存</strong>
              <p>你可以结束练习并查看本次报告。</p>
              <button type="button" :disabled="practiceBusy" @click="() => finishPractice()">生成练习报告</button>
            </article>
            <article v-else-if="currentPracticeQuestion" class="practice-panel">
              <small>第 {{ practiceIndex + 1 }}/{{ practiceSession?.items.length }} 题</small>
              <strong>{{ currentPracticeQuestion.prompt }}</strong>
              <form v-if="!practiceFeedback" @submit.prevent="submitPracticeAnswer">
                <label class="sr-only" for="practice-answer">你的答案</label>
                <input id="practice-answer" v-model="practiceAnswer" placeholder="输入你的答案" :disabled="practiceBusy" />
                <button type="submit" :disabled="practiceBusy || !practiceAnswer.trim()">提交答案</button>
              </form>
              <div v-else class="practice-feedback">
                <p>{{ practiceFeedback.judgement === 'correct' ? '回答正确。' : practiceFeedback.judgement === 'incorrect' ? '这题暂不正确，已安排后续复习。' : '这题需要进一步确认，暂不计入掌握度。' }}</p>
                <button type="button" :disabled="practiceBusy" @click="nextPracticeQuestion">{{ practiceIndex + 1 === practiceSession?.items.length ? '查看报告' : '下一题' }}</button>
              </div>
              <button class="practice-end" type="button" :disabled="practiceBusy" @click="() => finishPractice()">提前结束并查看报告</button>
            </article>

            <ul class="study-list mistake-list">
              <li v-for="item in visibleMistakes" :key="item.questionId">
                <div class="mistake-heading">
                  <label v-if="item.status === 'active'">
                    <input
                      v-model="selectedMistakeIds"
                      type="checkbox"
                      :value="item.questionId"
                      :disabled="selectedMistakeIds.length >= 5 && !selectedMistakeIds.includes(item.questionId)"
                    />
                    <span class="study-item-title">{{ item.prompt }}</span>
                  </label>
                  <span v-else class="study-item-title">{{ item.prompt }}</span>
                  <span class="goal-status" :class="{ 'is-completed': item.status === 'mastered' }">
                    {{ item.status === 'mastered' ? '已掌握' : item.status === 'dismissed' ? '已忽略' : '待掌握' }}
                  </span>
                </div>
                <small>最近答案：{{ item.latestAnswer }} · 共答错 {{ item.wrongCount }} 次 · {{ item.latestAttemptAt.slice(0, 10) }}</small>
                <p class="mistake-insight-summary">错因：{{ mistakeReasonLabel(item.reasonCode) }}</p>
                <div class="mistake-insight-editor">
                  <label>错因
                    <select
                      :value="mistakeInsightDraft(item).reasonCode"
                      :disabled="mistakeBusyId === item.questionId"
                      @change="updateMistakeInsightDraft(item.questionId, { reasonCode: ($event.target as HTMLSelectElement).value })"
                    >
                      <option value="">清除错因记录</option>
                      <option v-for="option in mistakeReasonOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                    </select>
                  </label>
                  <label>补充说明
                    <input
                      :value="mistakeInsightDraft(item).note"
                      maxlength="500"
                      placeholder="例如：循环边界少比较了一次"
                      :disabled="mistakeBusyId === item.questionId"
                      @input="updateMistakeInsightDraft(item.questionId, { note: ($event.target as HTMLInputElement).value })"
                    />
                  </label>
                  <button type="button" :disabled="mistakeBusyId === item.questionId" @click="saveMistakeInsight(item)">保存错因</button>
                </div>
                <div v-if="item.knowledgeId" class="goal-actions">
                  <button v-if="item.status === 'active'" type="button" :disabled="mistakeBusyId === item.questionId" @click="setMistakeStatus(item.questionId, 'mastered')"><Check :size="14" />标记已掌握</button>
                  <button v-else-if="item.status === 'mastered'" type="button" :disabled="mistakeBusyId === item.questionId" @click="setMistakeStatus(item.questionId, 'active')"><RotateCcw :size="14" />继续学习</button>
                  <button v-else type="button" :disabled="mistakeBusyId === item.questionId" @click="setMistakeStatus(item.questionId, 'active')"><RotateCcw :size="14" />恢复错题</button>
                  <button v-if="item.status === 'active'" type="button" :disabled="mistakeBusyId === item.questionId" @click="setMistakeStatus(item.questionId, 'dismissed')">忽略</button>
                </div>
                <small v-else>这道题尚未关联知识点，可以重练，但暂不能标记掌握。</small>
              </li>
              <li v-if="visibleMistakes.length === 0" class="study-empty">
                {{ mistakeFilter === 'mastered' ? '还没有已掌握的错题。' : '当前没有待处理错题。' }}
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </el-dialog>
</template>
