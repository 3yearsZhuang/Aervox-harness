<script setup lang="ts">
import { computed } from 'vue';
import {
  BookOpen,
  Check,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-vue-next';
import { AervoxNavDialog, AervoxButton, AervoxCard, AervoxSegmentedControl, AervoxSettingsHeading } from '@aervox/ui/primitives';
import { useFocusModeState, learningNavItems } from './plugin-state';
const { activeLearningView, learningOpen } = useFocusModeState();
import { useFocusLearning } from './useFocusLearning';

// CR-060 §B9b：刷题 / 错题 / 学习规划的状态机已自宿主迁入本插件包
const {
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
  learningPlans,
  apiError,
  reloadGoals,
} = useFocusLearning();

const hasActiveMistakes = computed(() => mistakes.value.some((item) => item.status === 'active'));
</script>

<template>
  <AervoxNavDialog
    v-model="learningOpen"
    title="学习能力"
    subtitle="AI 学习规划与错题靶向重练"
    :icon="BookOpen"
    :items="learningNavItems"
    :active-key="activeLearningView"
    nav-aria-label="学习导航"
    custom-class="learning-dialog"
    @update:active-key="activeLearningView = $event as any"
    @open="reloadGoals"
  >
    <template #content>
      <div v-if="activeLearningView === 'study'" class="learning-detail">
        <p v-if="apiError" class="drawer-error">{{ apiError }}</p>

          <!-- AI 学习规划生成 -->
          <div class="settings-section">
            <AervoxSettingsHeading title="AI 学习规划" description="输入主题，生成「里程碑 + 任务」的项目式学习路线图" />
            <form class="focus-goal-form" @submit.prevent="generatePlan">
              <label class="sr-only" for="new-plan-topic">学习主题</label>
              <input class="aervox-field" id="new-plan-topic" v-model="newPlanTopic" placeholder="例如：用 Vue 写一个番茄钟应用" :disabled="planGenerating" />
              <select class="aervox-field" v-model="newPlanLevel" aria-label="学习水平" :disabled="planGenerating">
                <option value="beginner">入门</option>
                <option value="intermediate">进阶</option>
                <option value="advanced">熟练</option>
              </select>
              <select class="aervox-field" v-model.number="newPlanMinutes" aria-label="每日可用时间" :disabled="planGenerating">
                <option :value="15">15 分钟</option>
                <option :value="25">25 分钟</option>
                <option :value="45">45 分钟</option>
                <option :value="60">60 分钟</option>
              </select>
              <AervoxButton variant="primary" type="submit" class="practice-start" :disabled="planGenerating || !newPlanTopic.trim()">
                <Sparkles :size="15" />{{ planGenerating ? '正在生成…' : 'AI 生成规划' }}
              </AervoxButton>
            </form>
            <p v-if="planError" class="drawer-error">{{ planError }}</p>
            <p class="focus-section-desc">生成后按里程碑推进：勾选任务即可，完成一个阶段自动解锁下一阶段。</p>
          </div>

          <!-- 我的规划列表 -->
          <div class="settings-section">
            <h4>我的规划 <small>{{ learningPlans.length }}</small></h4>
            <ul class="focus-list plan-list">
              <AervoxCard as="li" v-for="plan in learningPlans" :key="plan.id" class="plan-card">
                <div class="goal-item-heading">
                  <span class="focus-item-title">{{ plan.title }}</span>
                  <span class="aervox-badge goal-status">{{ plan.dailyAvailableMinutes }} 分钟/天</span>
                </div>
                <p class="plan-description">{{ plan.description }}</p>
                <p class="plan-objective">学习目标：{{ plan.learningObjective }}</p>
                <div class="plan-gains">
                  <span v-for="gain in plan.gains" :key="gain" class="aervox-badge subnav-badge">{{ gain }}</span>
                </div>
                <div v-for="milestone in plan.milestones" :key="milestone.id" class="plan-milestone" :class="`is-${milestone.status}`">
                  <div class="plan-milestone-heading">
                    <span class="focus-item-title">{{ milestone.order + 1 }}. {{ milestone.title }}</span>
                    <span class="aervox-badge goal-status" :class="{ 'is-completed': milestone.status === 'completed' }">{{ planMilestoneStatusLabel(milestone.status) }}</span>
                  </div>
                  <small v-if="milestone.completionCriteria">完成标准：{{ milestone.completionCriteria }}</small>
                  <label
                    v-for="task in milestone.tasks"
                    :key="task.id"
                    class="plan-task"
                    :class="{ done: task.status === 'done', locked: milestone.status === 'locked' }"
                  >
                    <input class="aervox-checkbox"
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
                  <AervoxButton variant="danger" type="button" class="danger" :disabled="planBusyId === plan.id" @click="archivePlan(plan.id)"><X :size="14" />归档</AervoxButton>
                </div>
              </AervoxCard>
              <li v-if="learningPlans.length === 0" class="focus-empty">还没有学习规划，输入主题让 AI 生成一份路线图。</li>
            </ul>
          </div>
        </div>

        <div v-else-if="activeLearningView === 'mistake'" class="learning-detail">
        <div class="settings-section">
            <AervoxSettingsHeading title="错题管理与重练" description="针对性练习未掌握题目，记录错因洞察" />

            <div class="focus-section-title-row">
              <div class="mistake-filter-summary">
                <span>当前错题 <strong>{{ visibleMistakes.length }}</strong> 题</span>
                <span v-if="selectedMistakeIds.length" class="aervox-badge mistake-selected-badge">已选 {{ selectedMistakeIds.length }} 题</span>
              </div>
              <AervoxButton variant="primary"
                class="practice-start"
                type="button"
                :disabled="practiceBusy || !hasActiveMistakes"
                @click="startMistakePractice"
              >
                <RotateCcw :size="15" />{{ selectedMistakeIds.length ? `重练所选 ${selectedMistakeIds.length} 题` : '重练错题' }}
              </AervoxButton>
            </div>

            <div class="mistake-filter-bar">
              <AervoxSegmentedControl
                :model-value="mistakeFilter"
                label="错题状态筛选"
                :options="[{ value: 'active', label: '待掌握' }, { value: 'mastered', label: '已掌握' }, { value: 'dismissed', label: '已忽略' }, { value: 'all', label: '全部' }]"
                @update:model-value="mistakeFilter = $event as typeof mistakeFilter"
              />

              <label class="mistake-reason-filter">错因：
                <select class="aervox-field" v-model="mistakeReasonFilter" aria-label="按错因筛选">
                  <option value="all">全部错因</option>
                  <option v-for="option in mistakeReasonOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
              </label>
            </div>

            <p v-if="practiceError" class="drawer-error">{{ practiceError }}</p>

            <!-- 练习作答面板 -->
            <AervoxCard v-if="practiceReport" class="practice-report">
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
            </AervoxCard>
            <AervoxCard v-else-if="practiceSession && practiceReadyToComplete" class="practice-panel">
              <strong>本次答案已保存</strong>
              <p>你可以结束练习并查看本次报告。</p>
              <AervoxButton variant="secondary" type="button" :disabled="practiceBusy" @click="() => finishPractice()">生成练习报告</AervoxButton>
            </AervoxCard>
            <AervoxCard v-else-if="currentPracticeQuestion" class="practice-panel">
              <small>第 {{ practiceIndex + 1 }}/{{ practiceSession?.items.length }} 题</small>
              <strong>{{ currentPracticeQuestion.prompt }}</strong>
              <form v-if="!practiceFeedback" @submit.prevent="submitPracticeAnswer">
                <label class="sr-only" for="practice-answer">你的答案</label>
                <input class="aervox-field" id="practice-answer" v-model="practiceAnswer" placeholder="输入你的答案" :disabled="practiceBusy" />
                <AervoxButton variant="primary" type="submit" :disabled="practiceBusy || !practiceAnswer.trim()">提交答案</AervoxButton>
              </form>
              <div v-else class="practice-feedback">
                <p>{{ practiceFeedback.judgement === 'correct' ? '回答正确。' : practiceFeedback.judgement === 'incorrect' ? '这题暂不正确，已安排后续复习。' : '这题需要进一步确认，暂不计入掌握度。' }}</p>
                <AervoxButton variant="secondary" type="button" :disabled="practiceBusy" @click="nextPracticeQuestion">{{ practiceIndex + 1 === practiceSession?.items.length ? '查看报告' : '下一题' }}</AervoxButton>
              </div>
              <AervoxButton variant="ghost" class="practice-end" type="button" :disabled="practiceBusy" @click="() => finishPractice()">提前结束并查看报告</AervoxButton>
            </AervoxCard>

            <ul class="focus-list mistake-list">
              <AervoxCard as="li" v-for="item in visibleMistakes" :key="item.questionId">
                <div class="mistake-heading">
                  <label v-if="item.status === 'active'">
                    <input class="aervox-checkbox"
                      v-model="selectedMistakeIds"
                      type="checkbox"
                      :value="item.questionId"
                      :disabled="selectedMistakeIds.length >= 5 && !selectedMistakeIds.includes(item.questionId)"
                    />
                    <span class="focus-item-title">{{ item.prompt }}</span>
                  </label>
                  <span v-else class="focus-item-title">{{ item.prompt }}</span>
                  <span class="aervox-badge goal-status" :class="{ 'is-completed': item.status === 'mastered' }">
                    {{ item.status === 'mastered' ? '已掌握' : item.status === 'dismissed' ? '已忽略' : '待掌握' }}
                  </span>
                </div>
                <small>最近答案：{{ item.latestAnswer }} · 共答错 {{ item.wrongCount }} 次 · {{ item.latestAttemptAt.slice(0, 10) }}</small>
                <p class="mistake-insight-summary">错因：{{ mistakeReasonLabel(item.reasonCode) }}</p>
                <div class="mistake-insight-editor">
                  <label>错因
                    <select class="aervox-field"
                      :value="mistakeInsightDraft(item).reasonCode"
                      :disabled="mistakeBusyId === item.questionId"
                      @change="updateMistakeInsightDraft(item.questionId, { reasonCode: ($event.target as HTMLSelectElement).value })"
                    >
                      <option value="">清除错因记录</option>
                      <option v-for="option in mistakeReasonOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                    </select>
                  </label>
                  <label>补充说明
                    <input class="aervox-field"
                      :value="mistakeInsightDraft(item).note"
                      maxlength="500"
                      placeholder="例如：循环边界少比较了一次"
                      :disabled="mistakeBusyId === item.questionId"
                      @input="updateMistakeInsightDraft(item.questionId, { note: ($event.target as HTMLInputElement).value })"
                    />
                  </label>
                  <AervoxButton variant="secondary" type="button" :disabled="mistakeBusyId === item.questionId" @click="saveMistakeInsight(item)">保存错因</AervoxButton>
                </div>
                <div v-if="item.knowledgeId" class="goal-actions">
                  <AervoxButton variant="secondary" v-if="item.status === 'active'" type="button" :disabled="mistakeBusyId === item.questionId" @click="setMistakeStatus(item.questionId, 'mastered')"><Check :size="14" />标记已掌握</AervoxButton>
                  <AervoxButton variant="secondary" v-else-if="item.status === 'mastered'" type="button" :disabled="mistakeBusyId === item.questionId" @click="setMistakeStatus(item.questionId, 'active')"><RotateCcw :size="14" />继续学习</AervoxButton>
                  <AervoxButton variant="secondary" v-else type="button" :disabled="mistakeBusyId === item.questionId" @click="setMistakeStatus(item.questionId, 'active')"><RotateCcw :size="14" />恢复错题</AervoxButton>
                  <AervoxButton variant="secondary" v-if="item.status === 'active'" type="button" :disabled="mistakeBusyId === item.questionId" @click="setMistakeStatus(item.questionId, 'dismissed')">忽略</AervoxButton>
                </div>
                <small v-else>这道题尚未关联知识点，可以重练，但暂不能标记掌握。</small>
              </AervoxCard>
              <li v-if="visibleMistakes.length === 0" class="focus-empty">
                {{ mistakeFilter === 'mastered' ? '还没有已掌握的错题。' : '当前没有待处理错题。' }}
              </li>
            </ul>
          </div>
        </div>
      </template>
    </AervoxNavDialog>
  </template>
