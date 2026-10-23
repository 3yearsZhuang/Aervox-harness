/** Pure learning policy; persistence applies the complete result in one writer transaction. */
export function deriveMilestoneStatuses(
  milestones: readonly { id: string; order: number; status: string }[],
  tasks: readonly { milestoneId: string; status: string }[],
): Array<{ id: string; status: "completed" | "active" | "locked" }> {
  let predecessorsComplete = true;
  return [...milestones].sort((a, b) => a.order - b.order).flatMap((milestone) => {
    const ownTasks = tasks.filter((task) => task.milestoneId === milestone.id);
    const complete = ownTasks.length > 0 && ownTasks.every((task) => task.status === "done");
    const status = predecessorsComplete ? (complete ? "completed" : "active") : "locked";
    predecessorsComplete &&= complete;
    return milestone.status === status ? [] : [{ id: milestone.id, status }];
  });
}
