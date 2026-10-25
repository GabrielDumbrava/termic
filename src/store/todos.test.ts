import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeQueryKey, TODOS_CACHE_TTL_MS, useTodos } from "./todos";
import { useApp } from "@/store/app";
import * as ipc from "@/lib/ipc";
import type { IssueLookup, PrPickList, Project } from "@/lib/types";

vi.mock("@/lib/ipc", () => ({
  projectForgeIssues: vi.fn(),
  projectForgePrs: vi.fn(),
}));

describe("todos store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTodos.getState().clearCache();
    useTodos.setState({
      selectedProjectId: null,
      kindFilter: "all",
      scopeFilter: "for_me",
      searchQuery: "",
      isRefreshing: false,
    });
  });

  it("builds consistent query keys", () => {
    expect(makeQueryKey("p1", "issues", "assigned")).toBe("p1:issues:assigned");
    expect(makeQueryKey("p2", "prs", "review")).toBe("p2:prs:review");
  });

  it("skips non-git projects", async () => {
    useApp.setState({
      projects: [
        { id: "p-nongit", name: "Plain Folder", non_git: true } as Project,
      ],
    });

    await useTodos.getState().fetchVisibleTodos();
    expect(ipc.projectForgeIssues).not.toHaveBeenCalled();
    expect(ipc.projectForgePrs).not.toHaveBeenCalled();
  });

  it("fetches assigned issues and review/mine PRs for scope 'for_me'", async () => {
    useApp.setState({
      projects: [
        { id: "p1", name: "Repo 1", non_git: false } as Project,
      ],
    });

    vi.mocked(ipc.projectForgeIssues).mockResolvedValueOnce({
      provider: "github",
      remote_url: "git@github.com:acme/repo1.git",
      status: "ok",
      message: "",
      issues: [
        {
          provider: "github",
          number: 10,
          title: "Fix bug",
          url: "https://github.com/acme/repo1/issues/10",
          body: "details",
          author: "alice",
          comments: 2,
          labels: ["bug"],
          updated_at: "2026-10-24T12:00:00Z",
        },
      ],
    } as IssueLookup);

    vi.mocked(ipc.projectForgePrs).mockResolvedValueOnce({
      provider: "github",
      remote_url: "git@github.com:acme/repo1.git",
      status: "ok",
      message: "",
      prs: [
        {
          provider: "github",
          number: 20,
          title: "PR review",
          url: "https://github.com/acme/repo1/pull/20",
          body: "review me",
          author: "bob",
          head_ref: "feature/review",
          cross_repository: false,
          draft: false,
          updated_at: "2026-10-24T13:00:00Z",
        },
      ],
    } as PrPickList);

    vi.mocked(ipc.projectForgePrs).mockResolvedValueOnce({
      provider: "github",
      remote_url: "git@github.com:acme/repo1.git",
      status: "ok",
      message: "",
      prs: [],
    } as PrPickList);

    await useTodos.getState().fetchVisibleTodos();

    expect(ipc.projectForgeIssues).toHaveBeenCalledWith("p1", 50, "assigned");
    expect(ipc.projectForgePrs).toHaveBeenCalledWith("p1", { scope: "review", limit: 30 });
    expect(ipc.projectForgePrs).toHaveBeenCalledWith("p1", { scope: "mine", limit: 30 });

    const cache = useTodos.getState().cache;
    expect(cache["p1:issues:assigned"]?.status).toBe("ok");
    expect(cache["p1:issues:assigned"]?.items).toHaveLength(1);
    expect(cache["p1:issues:assigned"]?.items[0].id).toBe("p1:issue:10");
    expect(cache["p1:prs:review"]?.items[0].id).toBe("p1:pr:20");
  });

  it("respects cache TTL and skips fresh queries", async () => {
    useApp.setState({
      projects: [{ id: "p1", name: "Repo 1", non_git: false } as Project],
    });

    useTodos.setState({
      cache: {
        "p1:issues:assigned": {
          items: [],
          fetchedAt: Date.now(),
          status: "ok",
        },
        "p1:prs:review": {
          items: [],
          fetchedAt: Date.now(),
          status: "ok",
        },
        "p1:prs:mine": {
          items: [],
          fetchedAt: Date.now(),
          status: "ok",
        },
      },
    });

    await useTodos.getState().fetchVisibleTodos(false);
    expect(ipc.projectForgeIssues).not.toHaveBeenCalled();
    expect(ipc.projectForgePrs).not.toHaveBeenCalled();

    // If force is true, it re-queries
    vi.mocked(ipc.projectForgeIssues).mockResolvedValue({
      provider: "github",
      remote_url: "",
      status: "ok",
      message: "",
      issues: [],
    } as IssueLookup);
    vi.mocked(ipc.projectForgePrs).mockResolvedValue({
      provider: "github",
      remote_url: "",
      status: "ok",
      message: "",
      prs: [],
    } as PrPickList);

    await useTodos.getState().fetchVisibleTodos(true);
    expect(ipc.projectForgeIssues).toHaveBeenCalledTimes(1);
  });

  it("preserves cached rows when a refresh returns an error status", async () => {
    useApp.setState({
      projects: [{ id: "p1", name: "Repo 1", non_git: false } as Project],
    });

    useTodos.setState({
      kindFilter: "issues",
      scopeFilter: "for_me",
      cache: {
        "p1:issues:assigned": {
          status: "ok",
          fetchedAt: 1000,
          items: [
            {
              id: "p1:issue:99",
              kind: "issue",
              projectId: "p1",
              projectName: "Repo 1",
              action: "assigned",
              issue: {
                provider: "github",
                number: 99,
                title: "Existing cached issue",
                url: "https://github.com/acme/repo1/issues/99",
                body: "Body",
                author: "alice",
                comments: 0,
                labels: [],
                updated_at: "2026-10-24T10:00:00Z",
              },
            },
          ],
        },
      },
    });

    vi.mocked(ipc.projectForgeIssues).mockResolvedValueOnce({
      provider: "github",
      remote_url: "",
      status: "error",
      message: "Network unreachable",
      issues: [],
    } as unknown as IssueLookup);

    await useTodos.getState().fetchVisibleTodos(true);

    const entry = useTodos.getState().cache["p1:issues:assigned"];
    expect(entry?.status).toBe("error");
    expect(entry?.errorMessage).toBe("Network unreachable");
    expect(entry?.items).toHaveLength(1);
    expect(entry?.items[0].id).toBe("p1:issue:99");
  });

  it("updates statusFilter via setStatusFilter", () => {
    expect(useTodos.getState().statusFilter).toBe("all");
    useTodos.getState().setStatusFilter("open");
    expect(useTodos.getState().statusFilter).toBe("open");
    useTodos.getState().setStatusFilter("closed");
    expect(useTodos.getState().statusFilter).toBe("closed");
  });

  it("queues both broad and user queries when scope is 'all'", async () => {
    useApp.setState({
      projects: [{ id: "p1", name: "Repo 1", non_git: false } as Project],
    });

    useTodos.setState({
      scopeFilter: "all",
      kindFilter: "all",
    });

    vi.mocked(ipc.projectForgeIssues).mockResolvedValue({
      provider: "github",
      remote_url: "",
      status: "ok",
      message: "",
      issues: [],
    } as IssueLookup);

    vi.mocked(ipc.projectForgePrs).mockResolvedValue({
      provider: "github",
      remote_url: "",
      status: "ok",
      message: "",
      prs: [],
    } as PrPickList);

    await useTodos.getState().fetchVisibleTodos(true);

    expect(ipc.projectForgeIssues).toHaveBeenCalledWith("p1", 50, "all");
    expect(ipc.projectForgeIssues).toHaveBeenCalledWith("p1", 50, "assigned");
    expect(ipc.projectForgePrs).toHaveBeenCalledWith("p1", { scope: "open", limit: 30 });
    expect(ipc.projectForgePrs).toHaveBeenCalledWith("p1", { scope: "review", limit: 30 });
    expect(ipc.projectForgePrs).toHaveBeenCalledWith("p1", { scope: "mine", limit: 30 });
  });
});
