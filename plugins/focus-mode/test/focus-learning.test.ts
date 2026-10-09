import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createFocusLearning } from '../src/ui/useFocusLearning';

/**
 * CR-060 §B9b：刷题 / 错题 / 学习规划状态机自宿主迁入本插件包后的行为契约。
 * 用替身 api 实例驱动，验证状态编排与错误映射（宿主不再持有这些状态）。
 */
function stubApi(overrides: Record<string, unknown> = {}) {
  return {
    mistakes: ref([]),
    learningPlans: ref([]),
    error: ref(null),
    submitPracticeAnswer: vi.fn(async () => ({ judgement: 'correct', nextStep: '继续' })),
    completePracticeSession: vi.fn(async () => ({ answeredCount: 1, questionCount: 1, remainingCount: 0, correctCount: 1, incorrectCount: 0, unverifiableCount: 0, accuracy: 1, avgTimeSpentSec: 5, totalHintsUsed: 0, guidance: { difficulty: 'maintain', reasonCode: 'ok', message: '保持' }, nextStep: '结束' })),
    loadAll: vi.fn(async () => undefined),
    startMistakePractice: vi.fn(async () => ({ sessionId: 's1', items: [{ id: 'q1', prompt: '1+1' }, { id: 'q2', prompt: '2+2' }] })),
    setMistakeStatus: vi.fn(async () => undefined),
    setMistakeInsight: vi.fn(async () => undefined),
    generateLearningPlan: vi.fn(async () => undefined),
    setPlanTaskStatus: vi.fn(async () => undefined),
    archiveLearningPlan: vi.fn(async () => undefined),
    ...overrides,
  } as never;
}

describe('useFocusLearning（CR-060 §B9b 自宿主迁入）', () => {
  it('错题视图按状态与错因过滤，并给出可读错因标签', () => {
    const api = stubApi({
      mistakes: ref([
        { questionId: 'q1', status: 'active', reasonCode: 'concept_gap' },
        { questionId: 'q2', status: 'mastered', reasonCode: 'careless' },
        { questionId: 'q3', status: 'active', reasonCode: 'careless' },
      ]),
    });
    const learning = createFocusLearning(api);

    expect(learning.activeMistakeCount.value).toBe(2);
    expect(learning.visibleMistakes.value.map((m) => m.questionId)).toEqual(['q1', 'q3']);

    learning.mistakeReasonFilter.value = 'careless';
    expect(learning.visibleMistakes.value.map((m) => m.questionId)).toEqual(['q3']);

    learning.mistakeFilter.value = 'mastered';
    learning.mistakeReasonFilter.value = 'all';
    expect(learning.visibleMistakes.value.map((m) => m.questionId)).toEqual(['q2']);

    expect(learning.mistakeReasonLabel('concept_gap')).toBe('概念不清');
    expect(learning.mistakeReasonLabel(null)).toBe('未记录错因');
  });

  it('无可用错题时不发起重练并给出提示', async () => {
    const api = stubApi({ mistakes: ref([]) });
    const learning = createFocusLearning(api);

    await learning.startMistakePractice();

    expect(learning.practiceError.value).toBe('当前没有可重练的错题。');
    expect((api as unknown as { startMistakePractice: ReturnType<typeof vi.fn> }).startMistakePractice).not.toHaveBeenCalled();
  });

  it('错题重练经宿主 api 端口启动并恢复会话索引', async () => {
    const api = stubApi({
      mistakes: ref([{ questionId: 'q1', status: 'active', reasonCode: null }]),
      startMistakePractice: vi.fn(async () => ({ sessionId: 's1', items: [{ id: 'q1', prompt: '一' }, { id: 'q2', prompt: '二' }] })),
    });
    const learning = createFocusLearning(api);

    await learning.startMistakePractice();

    expect(learning.practiceSession.value?.sessionId).toBe('s1');
    expect(learning.practiceIndex.value).toBe(0);
    expect(learning.practiceReadyToComplete.value).toBe(false);
    expect(learning.currentPracticeQuestion.value?.id).toBe('q1');
  });

  it('作答提交后进入下一题，末题后标记可收尾', async () => {
    const api = stubApi({
      mistakes: ref([{ questionId: 'q1', status: 'active', reasonCode: null }]),
      startMistakePractice: vi.fn(async () => ({ sessionId: 's1', items: [{ id: 'q1', prompt: '一' }] })),
    });
    const learning = createFocusLearning(api);
    await learning.startMistakePractice();

    learning.practiceAnswer.value = '42';
    await learning.submitPracticeAnswer();
    expect(learning.practiceFeedback.value).toEqual({ judgement: 'correct', nextStep: '继续' });

    learning.nextPracticeQuestion();
    expect(learning.practiceReadyToComplete.value).toBe(true);
  });

  it('生成学习规划时把后端错误码映射为可操作提示', async () => {
    const api = stubApi({
      generateLearningPlan: vi.fn(async () => {
        throw new Error('llm_disabled');
      }),
    });
    const learning = createFocusLearning(api);

    learning.newPlanTopic.value = '线性代数';
    await learning.generatePlan();
    expect(learning.planError.value).toContain('尚未配置 LLM');

    learning.newPlanTopic.value = '';
    await learning.generatePlan();
    expect(learning.planError.value).toContain('尚未配置 LLM');
  });

  it('换绑 api 实例时清空视图态，避免沿用上一个实例的数据', async () => {
    const apiA = stubApi({
      mistakes: ref([{ questionId: 'q1', status: 'active', reasonCode: null }]),
      startMistakePractice: vi.fn(async () => ({ sessionId: 'sA', items: [{ id: 'q1', prompt: '一' }] })),
    });
    const learning = createFocusLearning(apiA);
    await learning.startMistakePractice();
    expect(learning.practiceSession.value?.sessionId).toBe('sA');

    learning.dispose();
    const other = createFocusLearning(stubApi());
    expect(other.practiceSession.value).toBeNull();
    expect(learning.practiceSession.value).toBeNull();
    expect(learning.practiceError.value).toBeNull();
  });

  it('宿主未提供 api 端口时显式解绑，只读视图回落为空而不沿用上一实例', () => {
    const learning = createFocusLearning(stubApi({
      mistakes: ref([{ questionId: 'q1', status: 'active', reasonCode: null }]),
      learningPlans: ref([{ id: 'plan_1' }]),
    }));
    expect(learning.activeMistakeCount.value).toBe(1);
    expect(learning.learningPlans.value).toHaveLength(1);

    // 解绑后组件读到的是空视图，而不是上一个渲染器实例的错题与规划
    learning.dispose();
    expect(learning.activeMistakeCount.value).toBe(0);
    expect(learning.learningPlans.value).toEqual([]);
    expect(learning.apiError.value).toBeNull();
  });
});

it('两份学习状态持有各自 API，销毁其中一份不影响另一份', async () => {
  const a = stubApi({ mistakes: ref([{ questionId: 'qa', status: 'active' }]) });
  const b = stubApi({ mistakes: ref([{ questionId: 'qb', status: 'active' }]) });
  const first = createFocusLearning(a); const second = createFocusLearning(b);
  first.dispose();
  await second.startMistakePractice();
  expect(first.mistakes.value).toEqual([]);
  expect(second.mistakes.value[0]?.questionId).toBe('qb');
  expect((a as any).startMistakePractice).not.toHaveBeenCalled();
  expect((b as any).startMistakePractice).toHaveBeenCalledWith(['qb']);
});
