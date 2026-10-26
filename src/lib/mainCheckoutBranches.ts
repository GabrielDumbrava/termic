import { projectGitCurrentBranch } from "@/lib/ipc";
import { useApp } from "@/store/app";
import { updateMainCheckoutBranches } from "@/lib/taskLocation";

let refreshInFlight: Promise<void> | null = null;
let refreshAgain = false;

/** Refresh main-checkout task labels from Git when the app starts or returns
 *  to the foreground. This keeps externally switched branches current without
 *  polling repositories in the background. */
export function refreshMainCheckoutBranches(): Promise<void> {
  if (refreshInFlight) {
    refreshAgain = true;
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    do {
      refreshAgain = false;
      const projectIds = [...new Set(
        useApp.getState().tasks
          .filter(task => task.is_main_checkout && !task.archived)
          .map(task => task.project_id),
      )];
      if (projectIds.length === 0) continue;

      // `projectGitCurrentBranch` returns null for both detached HEAD and
      // non-Git projects. The project record distinguishes plain folders so
      // they can clear any stale branch snapshot instead of displaying HEAD.
      const nonGitProjectIds = new Set(
        useApp.getState().projects
          .filter(project => project.non_git)
          .map(project => project.id),
      );

      const results = await Promise.all(projectIds.map(async projectId => {
        if (nonGitProjectIds.has(projectId)) return [projectId, ""] as const;
        try {
          // In Git repos, a null branch means detached HEAD.
          return [projectId, (await projectGitCurrentBranch(projectId)) ?? "HEAD"] as const;
        } catch {
          return null;
        }
      }));
      const branches = new Map(
        results.filter((result): result is readonly [string, string] => result !== null),
      );
      const tasks = useApp.getState().tasks;
      const updated = updateMainCheckoutBranches(tasks, branches);
      if (updated !== tasks) useApp.setState({ tasks: updated });
    } while (refreshAgain);
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}
