/** Learning application policy is independent of SQLite and HTTP. */
import { deriveMilestoneStatuses } from "@aervox/practice-review";
import type { LearningPlanPort, LocalContext } from "@aervox/repositories";
export function createLearningPlanService(repository: Pick<LearningPlanPort, "transitionPlanTask">) {
  return {
    setTaskStatus: (ctx: LocalContext, taskId: string, status: "todo" | "done") =>
      repository.transitionPlanTask(ctx, taskId, status, deriveMilestoneStatuses),
  };
}
