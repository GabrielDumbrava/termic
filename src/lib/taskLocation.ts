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
