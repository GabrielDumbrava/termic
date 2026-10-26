import { describe, expect, it } from "vitest";
import { mainCheckoutBranchState, updateMainCheckoutBranches } from "./taskLocation";

describe("updateMainCheckoutBranches", () => {
  it("updates active main-checkout tasks without changing worktrees or history", () => {
    const tasks = [
      { id: "main", project_id: "p1", branch: "main", is_main_checkout: true, archived: false },
      { id: "worktree", project_id: "p1", branch: "feature", is_main_checkout: false, archived: false },
      { id: "archived", project_id: "p1", branch: "main", is_main_checkout: true, archived: true },
      { id: "other-project", project_id: "p2", branch: "main", is_main_checkout: true, archived: false },
    ];

    expect(updateMainCheckoutBranches(tasks, new Map([["p1", "feature/active"]]))).toEqual([
      { ...tasks[0], branch: "feature/active" },
      tasks[1],
      tasks[2],
      tasks[3],
    ]);
  });

  it("keeps the task array when no branch changed", () => {
    const tasks = [
      { id: "main", project_id: "p1", branch: "main", is_main_checkout: true, archived: false },
    ];

    expect(updateMainCheckoutBranches(tasks, new Map([["p1", "main"]]))).toBe(tasks);
  });
});

describe("mainCheckoutBranchState", () => {
  it("recognizes a local branch matching the project's remote default", () => {
    expect(mainCheckoutBranchState("main", "origin/main", "origin")).toEqual({
      kind: "default",
    });
  });

  it("keeps a non-default branch visible without stripping its path", () => {
    expect(
      mainCheckoutBranchState("feature/issue-73", "origin/main", "origin"),
    ).toEqual({ kind: "different", branch: "feature/issue-73" });
  });

  it("treats detached HEAD as a notable main-checkout state", () => {
    expect(mainCheckoutBranchState("HEAD", "origin/main", "origin")).toEqual({
      kind: "different",
      branch: "HEAD",
    });
  });

  it("does not guess when no branch has been recorded yet", () => {
    expect(mainCheckoutBranchState("", "origin/main", "origin")).toEqual({
      kind: "unknown",
    });
  });

  it("shows a known branch when no project default is configured", () => {
    expect(mainCheckoutBranchState("main", "", "origin")).toEqual({
      kind: "different",
      branch: "main",
    });
  });
});
