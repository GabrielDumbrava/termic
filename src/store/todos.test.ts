import { describe, it, expect, vi, beforeEach } from "vitest";
import { coveredProjects, makeQueryKey, parseTodosProjects, pickedProjects, TODOS_CACHE_TTL_MS, useTodos } from "./todos";
import { useApp } from "@/store/app";
import * as ipc from "@/lib/ipc";
import type { IssueLookup, PrPickList, Project } from "@/lib/types";

vi.mock("@/lib/ipc", () => ({
  projectForgeIssues: vi.fn(),
  projectForgePrs: vi.fn(),
}));

// node vitest has no localStorage. Installed before the store module runs, so
// its init-time read of the saved project filter sees this stub too.
const stored = vi.hoisted(() => {
  const map = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
  };
  return map;
});

const okIssues = { provider: "github", remote_url: "", status: "ok", message: "", issues: [] } as unknown as IssueLookup;
const okPrs = { provider: "github", remote_url: "", status: "ok", message: "", prs: [] } as unknown as PrPickList;

describe("todos store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stored.clear();
    useTodos.getState().clearCache();
    useTodos.setState({
      selectedProjectIds: [],
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

  it("caches a failed fetch for the TTL instead of re-running it on every filter change", async () => {
    useApp.setState({
      projects: [{ id: "p1", name: "Repo 1", non_git: false } as Project],
    });
    useTodos.setState({ kindFilter: "issues", scopeFilter: "for_me" });
    vi.mocked(ipc.projectForgeIssues).mockResolvedValue({
      provider: "github",
      remote_url: "",
      status: "error",
      message: "gh: not logged in",
      issues: [],
    } as unknown as IssueLookup);

    await useTodos.getState().fetchVisibleTodos(false);
    expect(ipc.projectForgeIssues).toHaveBeenCalledTimes(1);
    expect(useTodos.getState().cache["p1:issues:assigned"]?.fetchedAt).toBeGreaterThan(0);

    await useTodos.getState().fetchVisibleTodos(false);
    expect(ipc.projectForgeIssues).toHaveBeenCalledTimes(1);

    // Refresh still retries.
    await useTodos.getState().fetchVisibleTodos(true);
    expect(ipc.projectForgeIssues).toHaveBeenCalledTimes(2);
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

  describe("project selection", () => {
    const projects = [
      { id: "p1", name: "Repo 1", non_git: false } as Project,
      { id: "p2", name: "Repo 2", non_git: false } as Project,
      { id: "p3", name: "Repo 3", non_git: false } as Project,
      { id: "p-plain", name: "Plain Folder", non_git: true } as Project,
    ];

    it("fetches only the picked projects", async () => {
      useApp.setState({ projects });
      vi.mocked(ipc.projectForgeIssues).mockResolvedValue(okIssues);
      vi.mocked(ipc.projectForgePrs).mockResolvedValue(okPrs);
      useTodos.setState({ selectedProjectIds: ["p1", "p3"], kindFilter: "issues" });

      await useTodos.getState().fetchVisibleTodos(true);

      const fetched = vi.mocked(ipc.projectForgeIssues).mock.calls.map((c) => c[0]).sort();
      expect(fetched).toEqual(["p1", "p3"]);
    });

    it("fetches every git project when nothing is picked", async () => {
      useApp.setState({ projects });
      vi.mocked(ipc.projectForgeIssues).mockResolvedValue(okIssues);
      useTodos.setState({ kindFilter: "issues" });

      await useTodos.getState().fetchVisibleTodos(true);

      const fetched = vi.mocked(ipc.projectForgeIssues).mock.calls.map((c) => c[0]).sort();
      expect(fetched).toEqual(["p1", "p2", "p3"]);
    });

    it("fetches only the newly picked project when one is added to a cached selection", async () => {
      useApp.setState({ projects });
      vi.mocked(ipc.projectForgeIssues).mockResolvedValue(okIssues);
      useTodos.setState({
        kindFilter: "issues",
        selectedProjectIds: ["p1"],
        cache: { "p1:issues:assigned": { items: [], fetchedAt: Date.now(), status: "ok" } },
      });

      useTodos.getState().setSelectedProjectIds(["p1", "p2"]);
      await vi.waitFor(() => expect(useTodos.getState().isRefreshing).toBe(false));

      expect(vi.mocked(ipc.projectForgeIssues).mock.calls.map((c) => c[0])).toEqual(["p2"]);
    });

    it("treats a selection naming only removed projects as every project", () => {
      expect(pickedProjects(projects, ["gone"])).toEqual([]);
      expect(coveredProjects(projects, ["gone"]).map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
      // A removed id beside a live one narrows to the live one.
      expect(coveredProjects(projects, ["gone", "p2"]).map((p) => p.id)).toEqual(["p2"]);
      // A non-git project cannot be picked, even by a stored id.
      expect(pickedProjects(projects, ["p-plain"])).toEqual([]);
    });

    it("persists the selection and clears the key for every project", () => {
      useTodos.getState().setSelectedProjectIds(["p2", "p1"]);
      expect(JSON.parse(stored.get("todosProjects") ?? "null")).toEqual(["p2", "p1"]);

      useTodos.getState().setSelectedProjectIds([]);
      expect(stored.has("todosProjects")).toBe(false);
    });

    it("does not write an unchanged selection", () => {
      useTodos.getState().setSelectedProjectIds(["p1"]);
      const before = useTodos.getState();
      const listener = vi.fn();
      const unsub = useTodos.subscribe(listener);
      useTodos.getState().setSelectedProjectIds(["p1"]);
      unsub();
      expect(listener).not.toHaveBeenCalled();
      expect(useTodos.getState()).toBe(before);
    });

    it("reads the saved selection back on a fresh load", async () => {
      useTodos.getState().setSelectedProjectIds(["p3", "p1"]);
      vi.resetModules();
      const fresh = await import("./todos");
      expect(fresh.useTodos.getState().selectedProjectIds).toEqual(["p3", "p1"]);
    });

    it("parses malformed stored values as every project", () => {
      expect(parseTodosProjects(null)).toEqual([]);
      expect(parseTodosProjects("")).toEqual([]);
      expect(parseTodosProjects("{not json")).toEqual([]);
      expect(parseTodosProjects('{"p1":true}')).toEqual([]);
      expect(parseTodosProjects('"p1"')).toEqual([]);
      expect(parseTodosProjects('["p1", 7, null, "", "p2", "p1"]')).toEqual(["p1", "p2"]);
    });
  });
});
