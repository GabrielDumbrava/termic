import { describe, expect, it } from "vitest";
import { updateMainCheckoutBranches } from "./taskLocation";

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
