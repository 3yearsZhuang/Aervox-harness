/**
 * 根据创建时固定的题组快照，计算恢复练习时的已答进度。
 * 重复作答只计为同一题已答，保持首次出现顺序以便向客户端展示。
 */
export function getPracticeSessionProgress(
  questionIds: string[],
  attempts: Array<{ questionId: string }>,
): { answeredQuestionIds: string[]; nextQuestionIndex: number } {
  const answeredQuestionIds = [...new Set(attempts.map((attempt) => attempt.questionId))];
  const answeredIds = new Set(answeredQuestionIds);
  const nextQuestionIndex = questionIds.findIndex((questionId) => !answeredIds.has(questionId));
  return {
    answeredQuestionIds,
    nextQuestionIndex: nextQuestionIndex === -1 ? questionIds.length : nextQuestionIndex,
  };
}
