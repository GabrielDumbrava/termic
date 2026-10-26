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

      const results = await Promise.all(projectIds.map(async projectId => {
        try {
          // Keep detached HEAD distinguishable from a failed branch query.
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
