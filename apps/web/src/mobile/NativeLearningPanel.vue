<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { AervoxHttpError, createReviewStore, getClientTransport, type GoalDto, type KnowledgeItemDto, type LearningPlanDto, type PracticeReportDto, type PracticeSessionDto, type ReviewCompletionDto, type ReviewItemDto } from '@aervox/api-client';

const transport = getClientTransport();
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const reviewStore = createReviewStore(transport, timeZone);
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const questionCount = ref<number | null>(null);
const session = ref<PracticeSessionDto | null>(null);
const index = ref(0);
const answer = ref('');
const judgement = ref('');
const report = ref<PracticeReportDto | null>(null);
const ignoredReviews = ref<string[]>([]);
const reviews = computed(() => reviewStore.dueReviews.value.filter(item => !ignoredReviews.value.includes(item.id)));
const reviewsRead = reviewStore.resource.loaded;
const reviewConcept = ref('');
const reviewConceptError = ref(false);
const reviewKnowledge = shallowRef<KnowledgeItemDto | null>(null);
const reviewReceipt = shallowRef<{result: ReviewCompletionDto; isCorrect: boolean} | null>(null);
const reviewHistory = reviewStore.completedReviews;
const goals = ref<GoalDto[]>([]);
const plans = ref<LearningPlanDto[]>([]);
const question = computed(() => session.value?.items[index.value]);
const currentReview = computed(() => pendingReview.value?.item ?? reviews.value[0]);
let answered = new Set<string>();
let pendingAnswer: { questionId: string; body: {sessionId: string; answer: string; timeZone: string; elapsedSeconds: number; hintsUsed: number}; key: string } | undefined;
const pendingReview = shallowRef<{item: ReviewItemDto; isCorrect: boolean; timeZone: string; knowledge: Pick<KnowledgeItemDto, 'id' | 'concept' | 'sourceStatus' | 'createdAt'>} | null>(null);
const answerPending = ref(false);
const reviewPending = computed(() => pendingReview.value !== null);
let disposed = false;
let loadRevision = 0;
let knowledgeReadRevision = 0;
let questionStartedAt = 0;
const code = (value: unknown) => value instanceof AervoxHttpError ? value.code : undefined;
const sameReview = (left: ReviewItemDto, right: ReviewItemDto) => left.id === right.id && left.knowledgeId === right.knowledgeId
  && left.dueAt === right.dueAt && left.intervalDays === right.intervalDays && left.schedulerVersion === right.schedulerVersion
  && left.timezoneSnapshot === right.timezoneSnapshot && left.status === right.status;
const sameKnowledge = (left: Pick<KnowledgeItemDto, 'id' | 'concept' | 'sourceStatus' | 'createdAt'>, right: Pick<KnowledgeItemDto, 'id' | 'concept' | 'sourceStatus' | 'createdAt'>) => left.id === right.id
  && left.concept === right.concept && left.sourceStatus === right.sourceStatus && left.createdAt === right.createdAt;
const reviewDate = (item: ReviewItemDto) => {
  try { return new Intl.DateTimeFormat('zh-CN', {dateStyle: 'medium', timeStyle: 'short', timeZone: item.timezoneSnapshot}).format(new Date(item.dueAt)); }
  catch { return item.dueAt; }
};

function adoptSession(value: PracticeSessionDto | null) {
  // A projection refresh cannot replace an uncertain command or its key.
  if (pendingAnswer) return;
  session.value = value;
  answered = new Set(value?.answeredQuestionIds ?? []);
  index.value = value ? value.items.findIndex(item => !answered.has(item.id)) : 0;
  if (value && index.value === -1) index.value = value.items.length;
  answer.value = ''; judgement.value = ''; pendingAnswer = undefined; answerPending.value = false;
  questionStartedAt = Date.now();
}
async function readReviewConcept() {
  const item = currentReview.value;
  const revision = ++knowledgeReadRevision;
  reviewConcept.value = ''; reviewConceptError.value = false; reviewKnowledge.value = null;
  if (!item) return;
  try {
    const knowledge = await reviewStore.getKnowledgeItem(item.knowledgeId);
    if (disposed || revision !== knowledgeReadRevision || !currentReview.value || !sameReview(currentReview.value, item)) return;
    if (pendingReview.value && !sameKnowledge(knowledge, pendingReview.value.knowledge)) { reviewConceptError.value = true; return; }
    reviewConcept.value = knowledge.concept;
    reviewKnowledge.value = knowledge;
  } catch {
    if (!disposed && revision === knowledgeReadRevision && currentReview.value?.id === item.id) reviewConceptError.value = true;
  }
}
async function refresh() {
  if (loading.value || busy.value) return;
  const revision = ++loadRevision;
  loading.value = true; error.value = '';
  knowledgeReadRevision++; reviewConcept.value = ''; reviewKnowledge.value = null;
  const results = await Promise.allSettled([
    transport.request<{ items: PracticeSessionDto['items'] }>('GET', '/v1/practice/questions?count=3'),
    transport.request<PracticeSessionDto>('GET', '/v1/practice/sessions/active'),
    reviewStore.loadReviews(),
    transport.request<{ items: GoalDto[] }>('GET', '/v1/learning/goals'),
    transport.request<{ items: LearningPlanDto[] }>('GET', '/v1/learning-plans'),
  ]);
  if (disposed || revision !== loadRevision) return;
  const [questions, active, due, goalList, planList] = results;
  if (questions.status === 'fulfilled') questionCount.value = questions.value.items.length;
  if (active.status === 'fulfilled') adoptSession(active.value);
  else if (active.reason instanceof AervoxHttpError && active.reason.status === 404) adoptSession(null);
  if (due.status === 'rejected') reviewConceptError.value = true;
  if (goalList.status === 'fulfilled') goals.value = goalList.value.items;
  if (planList.status === 'fulfilled') plans.value = planList.value.items;
  if (results.some((result, position) => result.status === 'rejected'
    && !(position === 1 && result.reason instanceof AervoxHttpError && result.reason.status === 404))) {
    error.value = '部分学习记录没有读到，请刷新重试。';
  }
  loading.value = false;
  if (due.status === 'fulfilled') await readReviewConcept();
}
async function startPractice() {
  if (busy.value || loading.value) return;
  busy.value = true; error.value = ''; notice.value = ''; report.value = null;
  try {
    const value = await transport.request<PracticeSessionDto>('POST', '/v1/practice/sessions', { count: 3 });
    if (!disposed) adoptSession(value);
  } catch (cause) {
    if (!disposed) error.value = code(cause) === 'PRACTICE_NOT_ENOUGH_QUESTIONS'
      ? '题库不足 3 题，请先在数据管理中导入题库。' : '练习没有打开，请重试；已保存的进度会继续保留。';
  } finally { if (!disposed) busy.value = false; }
}
async function submitAnswer() {
  if (busy.value || !session.value || !question.value || judgement.value || !answer.value.trim()) return;
  pendingAnswer ??= { questionId: question.value.id,
    body: Object.freeze({sessionId: session.value.sessionId, answer: answer.value.trim(), timeZone,
      elapsedSeconds: Math.max(1, Math.round((Date.now() - questionStartedAt) / 1000)), hintsUsed: 0}), key: crypto.randomUUID() };
  const submission = pendingAnswer;
  answerPending.value = true; busy.value = true; error.value = '';
  try {
    const receipt = await transport.request<{ judgement: string }>('POST', `/v1/questions/${encodeURIComponent(submission.questionId)}/attempts`,
      submission.body, { headers: { 'Idempotency-Key': submission.key } });
    if (disposed) return;
    judgement.value = receipt.judgement === 'correct' ? '答对了' : receipt.judgement === 'incorrect' ? '这题答错了' : '这道题需要进一步核对';
    answered.add(submission.questionId);
    pendingAnswer = undefined; answerPending.value = false;
  } catch {
    if (!disposed) error.value = '这次作答尚未确认，请重试提交同一答案，或刷新读取已保存的进度。';
  } finally { if (!disposed) busy.value = false; }
}
function nextQuestion() {
  if (!session.value || busy.value) return;
  const next = session.value.items.findIndex(item => !answered.has(item.id));
  index.value = next === -1 ? session.value.items.length : next;
  answer.value = ''; judgement.value = '';
  questionStartedAt = Date.now();
}
async function finishPractice() {
  if (busy.value || !session.value) return;
  busy.value = true; error.value = '';
  try {
    const result = await transport.request<PracticeReportDto>('POST', `/v1/practice/sessions/${encodeURIComponent(session.value.sessionId)}/complete`, {});
    if (!disposed) { report.value = result; adoptSession(null); }
  } catch { if (!disposed) error.value = '报告没有读到，请重试。已提交的作答不会丢失。'; }
  finally { if (!disposed) busy.value = false; }
}
async function completeReview(isCorrect: boolean) {
  if (busy.value || loading.value || !currentReview.value || (!pendingReview.value && !reviewKnowledge.value?.concept.trim())) return;
  const item = currentReview.value;
  const displayed = reviewKnowledge.value;
  if (!pendingReview.value) reviewReceipt.value = null;
  busy.value = true; error.value = '';
  try {
    const existing = pendingReview.value;
    if (!existing) {
      await reviewStore.loadReviews();
      if (disposed) return;
      const current = reviewStore.dueReviews.value.find(candidate => candidate.id === item.id);
      if (!current || !sameReview(current, item)) {
        reviewConcept.value = ''; reviewKnowledge.value = null;
        error.value = '这条复习安排已变化，请刷新后重新打开。'; return;
      }
    }
    const knowledge = await reviewStore.getKnowledgeItem(item.knowledgeId);
    if (disposed) return;
    const expected = existing?.knowledge ?? displayed;
    if (!expected || !sameKnowledge(knowledge, expected)) {
      reviewKnowledge.value = existing ? null : knowledge;
      reviewConcept.value = existing ? '' : knowledge.concept;
      error.value = '知识内容已变化，请核对后再记录自评。'; return;
    }
    const completion = existing ?? {item: {...item}, isCorrect, timeZone,
      knowledge: {id: knowledge.id, concept: knowledge.concept, sourceStatus: knowledge.sourceStatus, createdAt: knowledge.createdAt}};
    pendingReview.value = completion;
    const result = await reviewStore.completeReview(completion.item.id, completion.isCorrect);
    if (disposed) return;
    if (result.completed.knowledgeId !== completion.item.knowledgeId) throw new Error('Review knowledge identity mismatch');
    reviewReceipt.value = {result, isCorrect: completion.isCorrect};
    pendingReview.value = null;
    notice.value = '这次自评已保存，下次复习安排已读到。';
    await readReviewConcept();
  } catch {
    if (!disposed) {
      reviewKnowledge.value = null; reviewConcept.value = ''; reviewConceptError.value = true;
      error.value = pendingReview.value ? '这次复习尚未确认，请重试原自评，或刷新读取已保存的记录。' : '复习安排或知识内容暂时不可用，请刷新重试。';
    }
  }
  finally { if (!disposed) busy.value = false; }
}
async function ignoreReview() {
  if (busy.value || reviewPending.value || !currentReview.value) return;
  ignoredReviews.value = [...ignoredReviews.value, currentReview.value.id];
  await readReviewConcept();
}
onMounted(() => { void refresh(); });
onBeforeUnmount(() => { disposed = true; loadRevision++; knowledgeReadRevision++; });
</script>

<template>
  <div class="native-learning-panel" :aria-busy="loading || busy">
    <div class="learning-heading">
      <p>学习记录保存在这台手机。先在数据管理中导入题库，就可以开始练习。</p>
      <component :is="'md-text-button'" type="button" :disabled="loading || busy" @click="refresh">刷新学习记录</component>
    </div>
    <p v-if="loading" role="status">正在读取学习记录…</p>
    <p v-if="error" class="learning-error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>

    <section aria-labelledby="native-practice-title">
      <h3 id="native-practice-title">练习</h3>
      <template v-if="session">
        <p>已恢复本次练习，已答 {{ answered.size }} / {{ session.items.length }} 题。</p>
        <template v-if="question">
          <h4>第 {{ index + 1 }} 题</h4>
          <p class="learning-prompt">{{ question.prompt }}</p>
          <label for="native-practice-answer">你的答案</label>
          <textarea id="native-practice-answer" v-model="answer" rows="3" :readonly="busy || answerPending || !!judgement" />
          <p v-if="judgement" role="status">{{ judgement }}</p>
          <component v-if="!judgement" :is="'md-filled-tonal-button'" type="button" :disabled="busy || !answer.trim()" @click="submitAnswer">{{ answerPending ? '重试提交答案' : '提交答案' }}</component>
          <component v-else :is="'md-filled-tonal-button'" type="button" :disabled="busy" @click="nextQuestion">{{ index + 1 < session.items.length ? '下一题' : '查看练习报告' }}</component>
        </template>
        <template v-else>
          <p>本组题已答完，查看报告完成这次练习。</p>
          <component :is="'md-filled-tonal-button'" type="button" :disabled="busy" @click="finishPractice">完成并查看报告</component>
        </template>
      </template>
      <template v-else>
        <p v-if="questionCount !== null && questionCount >= 3">题库已准备好，可以开始一组 3 题练习。</p>
        <p v-else-if="questionCount !== null">题库不足 3 题，请先在数据管理中导入题库。</p>
        <p v-else>题库状态尚未读到，请刷新重试。</p>
        <component :is="'md-filled-tonal-button'" type="button" :disabled="busy || loading || questionCount === null || questionCount < 3" @click="startPractice">开始 3 题练习</component>
      </template>
      <div v-if="report" class="learning-report" role="status">
        <h4>练习报告</h4>
        <p>已答 {{ report.answeredCount }} 题 · 答对 {{ report.correctCount }} 题 · 答错 {{ report.incorrectCount }} 题</p>
        <p v-if="report.unverifiableCount">{{ report.unverifiableCount }} 题需要进一步核对。</p>
        <p>{{ report.guidance.message }}</p>
      </div>
    </section>

    <section aria-labelledby="native-review-title">
      <h3 id="native-review-title">今日复习</h3>
      <p v-if="reviewStore.resource.error.value" class="learning-error">复习记录暂时没有读到，请刷新重试。</p>
      <p v-else-if="!reviewsRead">复习记录尚未读到，请刷新重试。</p>
      <p v-else-if="!reviews.length && !reviewPending">{{ reviewStore.dueReviews.value.length ? '本次已隐藏到期项；复习安排仍保留。' : '当前没有到期复习。' }}</p>
      <template v-else>
        <p v-if="reviewStore.dueReviews.value.length">{{ reviewStore.reviewSummary.value?.dueCount ?? reviewStore.dueReviews.value.length }} 项已到期 · 预计 {{ reviewStore.reviewSummary.value?.estimatedMinutes ?? reviewStore.dueReviews.value.length * 2 }} 分钟</p>
        <p v-if="currentReview">出现原因：本机已保存的复习安排在 {{ reviewDate(currentReview) }} 到期。调度 v{{ currentReview.schedulerVersion }}。</p>
        <p v-if="reviewConcept" class="learning-prompt">{{ reviewConcept }}</p>
        <p v-if="reviewKnowledge">{{ reviewKnowledge.sourceStatus === 'observed' ? '已保存的观察记录' : reviewKnowledge.sourceStatus === 'verified' ? '已核验的知识记录' : reviewKnowledge.sourceStatus === 'inferred' ? '已有算法推断' : '来源状态未识别' }}</p>
        <p v-else-if="reviewConceptError" class="learning-error">知识点没有读到，请刷新后再完成复习。</p>
        <p v-else>正在读取知识点…</p>
        <p>回想知识内容，再记录自己的掌握情况。自评与题目自动判分分别记录。</p>
        <p v-if="reviewPending" role="status">本次自评结果尚未确认，重试保留原自评。</p>
        <div class="learning-actions">
          <component :is="'md-filled-tonal-button'" type="button" :disabled="busy || (!reviewPending && !reviewConcept.trim())" @click="completeReview(true)">{{ reviewPending ? '重试原自评' : '记得' }}</component>
          <component v-if="!reviewPending" :is="'md-outlined-button'" type="button" :disabled="busy || !reviewConcept" @click="completeReview(false)">还需复习</component>
          <component v-if="!reviewPending" :is="'md-text-button'" type="button" :disabled="busy" @click="ignoreReview">本次先不看</component>
        </div>
      </template>
      <div v-if="reviewReceipt" class="learning-report" role="status">
        <h4>自评已保存</h4>
        <p>本次自评：{{ reviewReceipt.isCorrect ? '记得' : '还需复习' }}。</p>
        <p>下次复习：{{ reviewDate(reviewReceipt.result.nextReview) }}</p>
        <p>{{ reviewReceipt.result.nextReview.intervalDays }} 天间隔 · 调度 v{{ reviewReceipt.result.nextReview.schedulerVersion }} · {{ reviewReceipt.result.nextReview.timezoneSnapshot }}</p>
      </div>
      <div v-if="reviewsRead && !reviewStore.resource.error.value && reviewHistory.length" class="learning-report" aria-label="最近复习记录">
        <h4>最近复习记录</h4>
        <ul>
          <li v-for="item in reviewHistory" :key="item.id">
            <p>{{ item.completionIsCorrect === true ? '自评记得' : item.completionIsCorrect === false ? '自评还需复习' : '自评未记录' }}</p>
            <p v-if="item.nextReview">下次复习：{{ reviewDate(item.nextReview) }} · 调度 v{{ item.nextReview.schedulerVersion }}</p>
            <p v-else>下一复习记录尚不可用。</p>
          </li>
        </ul>
      </div>
    </section>

    <section v-if="goals.length" aria-labelledby="native-goals-title">
      <h3 id="native-goals-title">已有学习目标</h3>
      <ul><li v-for="goal in goals" :key="goal.id">{{ goal.topic }}</li></ul>
    </section>
    <section v-if="plans.length" aria-labelledby="native-plans-title">
      <h3 id="native-plans-title">已有学习计划</h3>
      <ul><li v-for="plan in plans" :key="plan.id">{{ plan.topic }}</li></ul>
    </section>
  </div>
</template>

<style scoped>
.native-learning-panel { display: grid; gap: 24px; min-width: 0; color: var(--md-sys-color-on-surface); }
.learning-heading p { margin: 0 0 8px; }
section { display: grid; gap: 12px; min-width: 0; padding-top: 16px; border-top: 1px solid var(--md-sys-color-outline-variant); }
h3, h4, p { margin: 0; }
h3 { font-size: 20px; line-height: 28px; }
p, li { font-size: 14px; line-height: 22px; overflow-wrap: anywhere; }
label { font-size: 14px; }
textarea { box-sizing: border-box; width: 100%; min-height: 88px; padding: 12px; border: 1px solid var(--md-sys-color-outline); border-radius: 12px; color: inherit; background: var(--md-sys-color-surface-container-high); font: inherit; }
.learning-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.learning-error { color: var(--md-sys-color-error); }
.learning-prompt { white-space: pre-wrap; }
.learning-report { display: grid; gap: 8px; padding: 16px; border-radius: 16px; background: var(--md-sys-color-surface-container); }
ul { margin: 0; padding-inline-start: 20px; }
</style>
