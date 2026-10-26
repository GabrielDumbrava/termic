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

describe("sidebar task location glyph and branch name (GH #73)", () => {
  let repoRoot = "";
  let originalBranch = "";
  let originalLocationMode: string | null = null;
  let originalBranchMode: string | null = null;
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
      const branchMode = prefs.taskBranchName;
      prefs.setTaskLocationIcon("both");
      prefs.setTaskBranchName("none");
      return { root: project.root_path as string, mode: mode as string, branchMode: branchMode as string };
    });
    repoRoot = state.root;
    originalLocationMode = state.mode;
    originalBranchMode = state.branchMode;
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
    if (originalBranchMode) {
      await browser.execute(
        (mode) =>
          window.__termic!.usePrefs.getState().setTaskBranchName(mode as any),
        originalBranchMode,
      );
    }
    if (originalLocationMode) {
      await browser.execute(
        (mode) =>
          window.__termic!.usePrefs.getState().setTaskLocationIcon(mode as any),
        originalLocationMode,
      );
    }
  });

  const rowCue = (id: string) =>
    browser.execute((taskId) => {
      const row = document.querySelector(`[data-sidebar-task-id="${taskId}"]`);
      const branch = row?.querySelector('[data-testid="task-branch"]');
      const icon = row?.querySelector('[data-testid="task-location-icon"]');
      return {
        location: icon?.getAttribute("data-location") ?? null,
        iconTitle: icon?.getAttribute("title") ?? null,
        branch: branch?.getAttribute("data-branch") ?? null,
        placement: branch?.getAttribute("data-placement") ?? null,
        branchWidth: branch?.getBoundingClientRect().width ?? 0,
        branchClipped: !!branch && branch.scrollWidth > branch.clientWidth,
        label: row?.querySelector('[data-testid="task-label"]')?.textContent ?? null,
        height: row?.getBoundingClientRect().height ?? 0,
      };
    }, id);
  const setBranchMode = (mode: string) =>
    browser.execute((m) => window.__termic!.usePrefs.getState().setTaskBranchName(m as any), mode);

  it("never clips a short branch beside a long name", async () => {
    const id = await openTask(`e2e-location-a-very-long-task-name-that-truncates-${Date.now()}`, false);
    taskIds.push(id);
    await waitVisible(`[data-sidebar-task-id="${id}"]`);
    for (const mode of ["inline", "right"]) {
      await setBranchMode(mode);
      await browser.waitUntil(async () => (await rowCue(id)).placement === mode, { timeout: 5_000 });
      const cue = await rowCue(id);
      expect(cue.branch).toBe(originalBranch);
      expect(cue.branchClipped).toBe(false);
    }
    await setBranchMode("none");
    await archiveTask(id);
    taskIds.splice(taskIds.indexOf(id), 1);
  });

  it("keeps the main-checkout glyph on the default branch, with no branch text by default", async () => {
    const id = await openTask(`e2e-location-default-${Date.now()}`, false);
    taskIds.push(id);
    await waitVisible(`[data-sidebar-task-id="${id}"]`);
    const cue = await rowCue(id);
    expect(cue.location).toBe("main");
    expect(cue.iconTitle).toContain(originalBranch);
    expect(cue.branch).toBeNull();
  });

  it("places a worktree's branch inline, right or below, never inside the label", async () => {
    const suffix = Date.now();
    worktreeBranch = `e2e/issue73-wt-${suffix}`;
    const id = await createWorktreeTask(`e2e-location-worktree-${suffix}`, worktreeBranch, false);
    taskIds.push(id);
    await waitVisible(`[data-sidebar-task-id="${id}"]`);

    const off = await rowCue(id);
    expect(off.location).toBe("worktree");
    expect(off.iconTitle).toContain(worktreeBranch);
    expect(off.branch).toBeNull();

    for (const mode of ["inline", "right", "below"]) {
      await setBranchMode(mode);
      await browser.waitUntil(async () => (await rowCue(id)).placement === mode, {
        timeout: 5_000,
        timeoutMsg: `branch did not move to ${mode}`,
      });
      const cue = await rowCue(id);
      expect(cue.branch).toBe(worktreeBranch);
      expect(cue.label).not.toContain(worktreeBranch);
      // Readable, not crushed to a letter beside a long name.
      expect(cue.branchWidth).toBeGreaterThan(50);
      // Only "below" earns a second line; the others keep the fixed row height.
      if (mode === "below") expect(cue.height).toBeGreaterThan(off.height);
      else expect(cue.height).toBe(off.height);
      await snap(`task-branch-${mode}.png`);
    }
    await setBranchMode("none");
  });

  it("follows an external switch of the main checkout on window focus", async () => {
    await setBranchMode("inline");
    const id = await openTask(`e2e-location-branch-${Date.now()}`, false);
    taskIds.push(id);
    await waitVisible(`[data-sidebar-task-id="${id}"]`);
    mainBranch = `e2e/issue73-${Date.now()}`;
    execFileSync("git", ["switch", "-c", mainBranch], { cwd: repoRoot, stdio: "pipe" });
    await browser.execute(() => window.dispatchEvent(new Event("focus")));
    await browser.waitUntil(async () => (await rowCue(id)).branch === mainBranch, {
      timeout: 10_000,
      timeoutMsg: "main-checkout branch did not refresh on focus",
    });
    await snap("task-branch-main-checkout.png");

    execFileSync("git", ["switch", originalBranch], { cwd: repoRoot, stdio: "pipe" });
    await browser.execute(() => window.dispatchEvent(new Event("focus")));
    await browser.waitUntil(async () => (await rowCue(id)).branch === originalBranch, {
      timeout: 10_000,
      timeoutMsg: "main-checkout branch did not refresh back",
    });
    await setBranchMode("none");
  });
});
