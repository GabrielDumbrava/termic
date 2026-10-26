export type MainCheckoutBranchState =
  | { kind: "unknown" }
  | { kind: "default" }
  | { kind: "different"; branch: string };

type MainCheckoutTask = {
  project_id: string;
  branch: string;
  is_main_checkout?: boolean;
  archived: boolean;
};

/** Replace the in-memory branch snapshot for active main-checkout tasks.
 *  Worktree branches are task-owned and archived rows are historical, so
 *  neither should follow the project's live checkout. Returns the original
 *  array when nothing changed to avoid churning task selectors. */
export function updateMainCheckoutBranches<T extends MainCheckoutTask>(
  tasks: T[],
  branches: ReadonlyMap<string, string>,
): T[] {
  let changed = false;
  const next = tasks.map(task => {
    if (!task.is_main_checkout || task.archived) return task;
    const branch = branches.get(task.project_id);
    if (branch === undefined || branch === task.branch) return task;
    changed = true;
    return { ...task, branch };
  });
  return changed ? next : tasks;
}

/** Classify the branch the main checkout is currently on.
 *  Project defaults are stored as remote refs (usually `origin/main`), while
 *  the checked-out branch is the local name (`main`). */
export function mainCheckoutBranchState(
  branch: string | null | undefined,
  baseBranch: string | null | undefined,
  remote: string | null | undefined,
): MainCheckoutBranchState {
  if (!branch) return { kind: "unknown" };
  if (!baseBranch) return { kind: "different", branch };

  const remotePrefix = remote ? `${remote}/` : "";
  const localBase =
    remotePrefix && baseBranch.startsWith(remotePrefix)
      ? baseBranch.slice(remotePrefix.length)
      : baseBranch;

  return branch === localBase
    ? { kind: "default" }
    : { kind: "different", branch };
}
