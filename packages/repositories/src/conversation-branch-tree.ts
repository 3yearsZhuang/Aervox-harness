/** Per-read protection budgets; they do not restrict the persisted graph. */
export const BRANCH_TREE_MAX_SESSIONS = 1_000;
export const BRANCH_TREE_MAX_BRANCHES = 10_000;

export interface BranchTreeReadOptions {
  signal?: AbortSignal;
}

export class BranchTreeLimitError extends Error {
  constructor() {
    super("branch_tree_limit_exceeded");
    this.name = "BranchTreeLimitError";
  }
}
