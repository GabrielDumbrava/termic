import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  projects: [] as Array<{ id: string; non_git?: boolean }>,
  tasks: [] as Array<{
    id: string;
    project_id: string;
    branch: string;
    is_main_checkout: boolean;
    archived: boolean;
  }>,
  projectGitCurrentBranch: vi.fn(),
  setState: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
  projectGitCurrentBranch: h.projectGitCurrentBranch,
}));

vi.mock("@/store/app", () => ({
  useApp: {
    getState: () => ({ projects: h.projects, tasks: h.tasks }),
    setState: h.setState,
  },
}));

import { refreshMainCheckoutBranches } from "@/lib/mainCheckoutBranches";

describe("refreshMainCheckoutBranches", () => {
  beforeEach(() => {
    h.projects = [
      { id: "plain-folder", non_git: true },
      { id: "git-repo", non_git: false },
    ];
    h.tasks = [
      { id: "plain-task", project_id: "plain-folder", branch: "HEAD", is_main_checkout: true, archived: false },
      { id: "detached-task", project_id: "git-repo", branch: "main", is_main_checkout: true, archived: false },
    ];
    h.projectGitCurrentBranch.mockReset().mockResolvedValue(null);
    h.setState.mockReset();
  });

  it("clears stale labels for plain folders while retaining HEAD for detached Git checkouts", async () => {
    await refreshMainCheckoutBranches();

    expect(h.projectGitCurrentBranch).toHaveBeenCalledTimes(1);
    expect(h.projectGitCurrentBranch).toHaveBeenCalledWith("git-repo");
    expect(h.setState).toHaveBeenCalledWith({
      tasks: [
        { ...h.tasks[0], branch: "" },
        { ...h.tasks[1], branch: "HEAD" },
      ],
    });
  });
});
