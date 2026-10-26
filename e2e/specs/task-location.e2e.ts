import { execFileSync } from "node:child_process";
import {
  archiveTask,
  createWorktreeTask,
  openTask,
  requireTermicApi,
  snap,
  waitForAppShell,
  waitVisible,
} from "../helpers";

describe("sidebar task location cues (GH #73)", () => {
  let repoRoot = "";
  let originalBranch = "";
  let originalLocationMode: string | null = null;
  let mainBranch = "";
  let worktreeBranch = "";
  const taskIds: string[] = [];

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    const state = await browser.execute(() => {
      const t = window.__termic!;
      const project = t.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      const prefs = t.usePrefs.getState();
      const mode = prefs.taskLocationIcon;
      prefs.setTaskLocationIcon("both");
      return { root: project.root_path as string, mode: mode as string };
    });
    repoRoot = state.root;
    originalLocationMode = state.mode;
    originalBranch = execFileSync("git", ["branch", "--show-current"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  });

  after(async () => {
    for (const id of taskIds) {
      try {
        await archiveTask(id);
      } catch {
        /* cleanup should continue */
      }
    }
    if (repoRoot && originalBranch) {
      try {
        execFileSync("git", ["switch", originalBranch], {
          cwd: repoRoot,
          stdio: "pipe",
        });
      } catch {
        /* already on the original branch */
      }
      for (const branch of [mainBranch, worktreeBranch]) {
        if (!branch) continue;
        try {
          execFileSync("git", ["branch", "-D", branch], {
            cwd: repoRoot,
            stdio: "pipe",
          });
        } catch {
          /* not created */
        }
      }
    }
    if (originalLocationMode) {
      await browser.execute(
        (mode) =>
          window.__termic!.usePrefs.getState().setTaskLocationIcon(mode as any),
        originalLocationMode,
      );
    }
  });

  it("omits the base-branch mark and labels a different main-checkout branch", async () => {
    const suffix = Date.now();
    const defaultTask = await openTask(`e2e-location-default-${suffix}`, false);
    taskIds.push(defaultTask);
    await waitVisible(`[data-sidebar-task-id="${defaultTask}"]`);
    const defaultRow = await browser.execute((id) => {
      const row = document.querySelector(`[data-sidebar-task-id="${id}"]`);
      return {
        branchLabel:
          row?.querySelector('[data-testid="task-main-branch"]')?.textContent ??
          null,
        icon: row?.querySelector('[data-testid="task-location-icon"]') !== null,
      };
    }, defaultTask);
    expect(defaultRow).toEqual({ branchLabel: null, icon: false });
    await snap("task-location-default-main.png");
    await archiveTask(defaultTask);
    taskIds.splice(taskIds.indexOf(defaultTask), 1);

    mainBranch = `e2e/issue73-${suffix}`;
    execFileSync("git", ["switch", "-c", mainBranch], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    const mainTask = await openTask(`e2e-location-branch-${suffix}`, false);
    taskIds.push(mainTask);
    await waitVisible(`[data-sidebar-task-id="${mainTask}"]`);
    const shownBranch = await browser.execute((id) => {
      const row = document.querySelector(`[data-sidebar-task-id="${id}"]`);
      const label = row?.querySelector('[data-testid="task-main-branch"]');
      return {
        text: label?.textContent?.trim() ?? null,
        title: label?.getAttribute("title") ?? null,
        iconBranch: row?.querySelector('[data-testid="task-location-icon"][data-location="main"]')
          ?.getAttribute("data-branch") ?? null,
        rowBranch: label?.getAttribute("data-branch") ?? null,
      };
    }, mainTask);
    expect(shownBranch.text).toContain(mainBranch);
    expect(shownBranch.title).toContain(mainBranch);
    expect(shownBranch.iconBranch).toBe(mainBranch);
    expect(shownBranch.rowBranch).toBe(mainBranch);

    // The task remains open while an external Git switch changes the live
    // checkout. Returning focus refreshes its label without background polling.
    execFileSync("git", ["switch", originalBranch], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    await browser.execute(() => window.dispatchEvent(new Event("focus")));
    await browser.waitUntil(
      async () => await browser.execute((id) =>
        document.querySelector(`[data-sidebar-task-id="${id}"] [data-testid="task-main-branch"]`) === null,
      mainTask),
      { timeout: 10_000, timeoutMsg: "main-checkout branch cue did not clear after returning to the base branch" },
    );

    execFileSync("git", ["switch", mainBranch], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    await browser.execute(() => window.dispatchEvent(new Event("focus")));
    await browser.waitUntil(
      async () => await browser.execute((id, branch) =>
        document.querySelector(`[data-sidebar-task-id="${id}"] [data-testid="task-main-branch"]`)
          ?.getAttribute("data-branch") === branch,
      mainTask, mainBranch),
      { timeout: 10_000, timeoutMsg: "main-checkout branch cue did not refresh after switching back" },
    );
    await snap("task-location-non-default-main.png");
  });

  it("shows the worktree branch inline and in the location icon tooltip", async () => {
    const suffix = Date.now();
    worktreeBranch = `e2e/issue73-wt-${suffix}`;
    const task = await createWorktreeTask(
      `e2e-location-worktree-${suffix}`,
      worktreeBranch,
      false,
    );
    taskIds.push(task);
    await waitVisible(`[data-sidebar-task-id="${task}"]`);
    const branchCue = await browser.execute(
      (id) => {
        const row = document.querySelector(`[data-sidebar-task-id="${id}"]`);
        return {
          inline: row?.querySelector('[data-testid="task-worktree-branch"]')?.textContent?.trim() ?? null,
          tooltip: row?.querySelector('[data-testid="task-location-icon"][data-location="worktree"]')
            ?.getAttribute("title") ?? null,
        };
      },
      task,
    );
    expect(branchCue.inline).toContain(worktreeBranch);
    expect(branchCue.tooltip).toContain(worktreeBranch);
    await snap("task-location-worktree.png");
  });
});
