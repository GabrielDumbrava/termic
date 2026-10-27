// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return {
    ...actual,
    openPath: vi.fn().mockResolvedValue(undefined),
    projectForgeIssues: vi.fn().mockResolvedValue({ status: "ok", issues: [] }),
    projectForgePrs: vi.fn().mockResolvedValue({ status: "ok", prs: [] }),
  };
});

import { TodosView } from "./TodosView";
import { useApp } from "@/store/app";
import { useTodos } from "@/store/todos";
import { useUI } from "@/store/ui";
import { openPath } from "@/lib/ipc";
import type { Project } from "@/lib/types";
import type { TodoItem } from "@/store/todos";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("TodosView component", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);

    localStorage.clear();
    useTodos.getState().clearCache();
    useTodos.setState({
      selectedProjectIds: [],
      kindFilter: "all",
      scopeFilter: "for_me",
      searchQuery: "",
      isRefreshing: false,
    });
    useApp.setState({
      projects: [
        { id: "p1", name: "Backend API", non_git: false } as Project,
        { id: "p2", name: "Frontend Web", non_git: false } as Project,
      ],
    });
  });

  it("renders view title, project filter, and kind/scope pills", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(TodosView));
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(container.querySelector('[data-testid="todos-view"]')).toBeDefined();
    expect(container.querySelector('[data-testid="todos-project-filter"]')).toBeDefined();
    expect(container.querySelector('[data-testid="todos-refresh-button"]')).toBeDefined();
    expect(container.querySelector('[data-testid="todos-kind-all"]')).toBeDefined();
    expect(container.querySelector('[data-testid="todos-scope-for_me"]')).toBeDefined();

    await act(async () => {
      root.unmount();
    });
  });

  it("displays items from cache with action badges and labels", async () => {
    useTodos.setState({
      cache: {
        "p1:issues:assigned": {
          status: "ok",
          fetchedAt: Date.now(),
          items: [
            {
              id: "p1:issue:101",
              kind: "issue",
              projectId: "p1",
              projectName: "Backend API",
              action: "assigned",
              issue: {
                provider: "github",
                number: 101,
                title: "Fix memory leak in buffer pool",
                url: "https://github.com/acme/backend/issues/101",
                body: "Leaking memory during streaming",
                author: "alice",
                comments: 3,
                labels: ["bug", "p0"],
                updated_at: "2026-10-24T10:00:00Z",
              },
            },
          ],
        },
      },
    });

    const openNewTaskSpy = vi.spyOn(useUI.getState(), "openNewTask");

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(TodosView));
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(container.textContent).toContain("Fix memory leak in buffer pool");
    expect(container.textContent).toContain("#101");
    expect(container.textContent).toContain("Backend API");
    expect(container.textContent).toContain("by alice");
    expect(container.textContent).toContain("bug");

    const startBtn = container.querySelector('[data-testid="todos-start-task"]') as HTMLButtonElement;
    expect(startBtn).toBeDefined();
    await act(async () => {
      startBtn.click();
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(openNewTaskSpy).toHaveBeenCalledWith("p1", expect.objectContaining({
      mode: "worktree",
      issue: expect.objectContaining({ number: 101 }),
    }));

    await act(async () => {
      root.unmount();
    });
  });

  it("displays PR items with draft badge and handles review action and browser link", async () => {
    useTodos.setState({
      cache: {
        "p1:prs:review": {
          status: "ok",
          fetchedAt: Date.now(),
          items: [
            {
              id: "p1:pr:55",
              kind: "pr",
              projectId: "p1",
              projectName: "Backend API",
              action: "review_requested",
              pr: {
                provider: "github",
                number: 55,
                title: "Add telemetry metrics",
                url: "https://github.com/acme/backend/pull/55",
                body: "Telemetry metrics for PTY",
                author: "bob",
                head_ref: "feature/telemetry",
                cross_repository: false,
                draft: true,
                updated_at: "2026-10-24T11:00:00Z",
              },
            },
          ],
        },
      },
    });

    const openReviewPrSpy = vi.spyOn(useUI.getState(), "openReviewPr");

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(TodosView));
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(container.textContent).toContain("Add telemetry metrics");
    expect(container.textContent).toContain("!55");
    expect(container.textContent).toContain("draft");
    expect(container.textContent).toContain("by bob");

    const reviewBtn = container.querySelector('[data-testid="todos-start-task"]') as HTMLButtonElement;
    await act(async () => {
      reviewBtn.click();
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(openReviewPrSpy).toHaveBeenCalledWith("p1", {
      number: 55,
      url: "https://github.com/acme/backend/pull/55",
    });

    const browserBtn = container.querySelector('[data-testid="todos-open-browser"]') as HTMLButtonElement;
    await act(async () => {
      browserBtn.click();
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(openPath).toHaveBeenCalledWith("https://github.com/acme/backend/pull/55");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders empty state when there are no items", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(TodosView));
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(container.querySelector('[data-testid="todos-view"]')).toBeDefined();
    expect(container.querySelector('[data-testid="todos-row"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("matches issue reference numbers with leading # or !", async () => {
    useTodos.setState({
      searchQuery: "#101",
      cache: {
        "p1:issues:assigned": {
          status: "ok",
          fetchedAt: Date.now(),
          items: [
            {
              id: "p1:issue:101",
              kind: "issue",
              projectId: "p1",
              projectName: "Backend API",
              action: "assigned",
              issue: {
                provider: "github",
                number: 101,
                title: "Memory leak",
                url: "https://github.com/acme/backend/issues/101",
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

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(TodosView));
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(container.querySelector('[data-testid="todos-row"]')).not.toBeNull();
    expect(container.textContent).toContain("Memory leak");

    await act(async () => {
      root.unmount();
    });
  });

  it("preserves 'assigned' action badge over generic 'open' when deduplicating items", async () => {
    useTodos.setState({
      scopeFilter: "all",
      cache: {
        "p1:issues:all": {
          status: "ok",
          fetchedAt: Date.now(),
          items: [
            {
              id: "p1:issue:13",
              kind: "issue",
              projectId: "p1",
              projectName: "Backend API",
              action: "open",
              issue: {
                provider: "gitlab",
                number: 13,
                title: "Report daily budget",
                url: "https://gitlab.example.com/backend/issues/13",
                body: "Body",
                author: "alice",
                comments: 1,
                labels: [],
                updated_at: "2026-10-24T10:00:00Z",
              },
            },
          ],
        },
        "p1:issues:assigned": {
          status: "ok",
          fetchedAt: Date.now(),
          items: [
            {
              id: "p1:issue:13",
              kind: "issue",
              projectId: "p1",
              projectName: "Backend API",
              action: "assigned",
              issue: {
                provider: "gitlab",
                number: 13,
                title: "Report daily budget",
                url: "https://gitlab.example.com/backend/issues/13",
                body: "Body",
                author: "alice",
                comments: 1,
                labels: [],
                updated_at: "2026-10-24T10:00:00Z",
              },
            },
          ],
        },
      },
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(TodosView));
      await new Promise((r) => setTimeout(r, 10));
    });

    const rows = container.querySelectorAll('[data-testid="todos-row"]');
    expect(rows).toHaveLength(1);
    // Should display assigned badge, not open
    expect(rows[0].textContent).toContain("assigned");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders sticky footer with total count, breakdown, metrics and project count", async () => {
    useTodos.setState({
      scopeFilter: "all",
      cache: {
        "p1:issues:assigned": {
          status: "ok",
          fetchedAt: Date.now(),
          items: [
            {
              id: "p1:issue:1",
              kind: "issue",
              projectId: "p1",
              projectName: "Backend API",
              action: "assigned",
              issue: {
                provider: "github",
                number: 1,
                title: "Task 1",
                url: "",
                body: "",
                author: "a",
                comments: 0,
                labels: [],
                updated_at: "2026-10-24T10:00:00Z",
              },
            },
          ],
        },
        "p2:prs:review": {
          status: "ok",
          fetchedAt: Date.now(),
          items: [
            {
              id: "p2:pr:2",
              kind: "pr",
              projectId: "p2",
              projectName: "Frontend Web",
              action: "review_requested",
              pr: {
                provider: "github",
                number: 2,
                title: "PR 2",
                url: "",
                body: "",
                author: "b",
                head_ref: "feat",
                cross_repository: false,
                draft: false,
                updated_at: "2026-10-24T11:00:00Z",
              },
            },
          ],
        },
      },
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(TodosView));
      await new Promise((r) => setTimeout(r, 10));
    });

    const footer = container.querySelector('[data-testid="todos-footer"]');
    expect(footer).not.toBeNull();
    expect(footer?.textContent).toContain("2 items");
    expect(footer?.textContent).toContain("1 issue, 1 PR");
    expect(footer?.textContent).toContain("1 assigned");
    expect(footer?.textContent).toContain("1 review");
    expect(footer?.textContent).toContain("2 projects");

    await act(async () => {
      root.unmount();
    });
  });

  describe("project picker", () => {
    const issueIn = (projectId: string, projectName: string, number: number): TodoItem => ({
      id: `${projectId}:issue:${number}`,
      kind: "issue",
      projectId,
      projectName,
      action: "assigned",
      issue: {
        provider: "github",
        number,
        title: `Issue ${number} in ${projectName}`,
        url: "",
        body: "",
        author: "alice",
        comments: 0,
        labels: [],
        updated_at: "2026-10-24T10:00:00Z",
      },
    });

    beforeEach(() => {
      useApp.setState({
        projects: [
          { id: "p1", name: "Backend API", non_git: false } as Project,
          { id: "p2", name: "Frontend Web", non_git: false } as Project,
          { id: "p3", name: "Infra", non_git: false } as Project,
        ],
      });
      const entry = (item: TodoItem) => ({ status: "ok" as const, fetchedAt: Date.now(), items: [item] });
      useTodos.setState({
        kindFilter: "issues",
        cache: {
          "p1:issues:assigned": entry(issueIn("p1", "Backend API", 1)),
          "p2:issues:assigned": entry(issueIn("p2", "Frontend Web", 2)),
          "p3:issues:assigned": entry(issueIn("p3", "Infra", 3)),
        },
      });
    });

    async function render() {
      const root = createRoot(container);
      await act(async () => {
        root.render(createElement(TodosView));
        await new Promise((r) => setTimeout(r, 10));
      });
      return root;
    }

    const rowTitles = () =>
      Array.from(container.querySelectorAll('[data-testid="todos-row"]'), (r) => r.textContent ?? "");
    const triggerText = () => container.querySelector('[data-testid="todos-project-filter"]')?.textContent ?? "";

    it("shows only the rows of the picked projects, and names them on the trigger", async () => {
      useTodos.setState({ selectedProjectIds: ["p1", "p3"] });
      const root = await render();

      const rows = rowTitles();
      expect(rows).toHaveLength(2);
      expect(rows.some((r) => r.includes("Issue 1 in Backend API"))).toBe(true);
      expect(rows.some((r) => r.includes("Issue 3 in Infra"))).toBe(true);
      expect(rows.some((r) => r.includes("Frontend Web"))).toBe(false);
      expect(triggerText()).toContain("2 projects");

      await act(async () => useTodos.getState().setSelectedProjectIds(["p2"]));
      expect(rowTitles()).toHaveLength(1);
      expect(triggerText()).toContain("Frontend Web");

      await act(async () => useTodos.getState().setSelectedProjectIds([]));
      expect(rowTitles()).toHaveLength(3);
      expect(triggerText()).toContain("All projects");

      await act(async () => root.unmount());
    });

    it("narrows to one project from a row's project chip", async () => {
      useTodos.setState({ selectedProjectIds: ["p1", "p2"] });
      const root = await render();

      const chip = Array.from(container.querySelectorAll('[data-testid="todos-row"] button')).find(
        (b) => b.getAttribute("title") === "Frontend Web"
      ) as HTMLButtonElement;
      await act(async () => chip.click());

      expect(useTodos.getState().selectedProjectIds).toEqual(["p2"]);
      expect(rowTitles()).toHaveLength(1);

      await act(async () => root.unmount());
    });

    it("falls back to every project when the picked ones were removed, without forgetting the pick", async () => {
      useTodos.setState({ selectedProjectIds: ["removed-project-id"] });
      const root = await render();

      expect(rowTitles()).toHaveLength(3);
      expect(triggerText()).toContain("All projects");
      // Derived, not written back: the saved pick stays as it was.
      expect(useTodos.getState().selectedProjectIds).toEqual(["removed-project-id"]);

      await act(async () => root.unmount());
    });

    it("keeps the saved pick through a render before the project list has loaded", async () => {
      useApp.setState({ projects: [] });
      useTodos.setState({ selectedProjectIds: ["p3"] });
      const root = await render();

      expect(useTodos.getState().selectedProjectIds).toEqual(["p3"]);

      await act(async () => {
        useApp.setState({
          projects: [
            { id: "p1", name: "Backend API", non_git: false } as Project,
            { id: "p3", name: "Infra", non_git: false } as Project,
          ],
        });
      });
      expect(triggerText()).toContain("Infra");
      expect(rowTitles()).toEqual([expect.stringContaining("Issue 3 in Infra")]);

      await act(async () => root.unmount());
    });

    it("ticks projects in the open menu one click at a time, and All clears them", async () => {
      const root = await render();
      const trigger = container.querySelector('[data-testid="todos-project-filter"]') as HTMLButtonElement;
      await act(async () => {
        trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }));
      });

      const option = (id: string) =>
        document.querySelector(`[data-testid="todos-project-option"][data-project-id="${id}"]`) as HTMLElement;
      expect(option("p1")).not.toBeNull();
      expect(option("p1").getAttribute("role")).toBe("menuitemcheckbox");
      expect(option("p1").getAttribute("aria-checked")).toBe("false");

      await act(async () => option("p1").click());
      expect(useTodos.getState().selectedProjectIds).toEqual(["p1"]);
      // Still open after the tick, and the row reports the new state.
      expect(option("p1")).not.toBeNull();
      expect(option("p1").getAttribute("aria-checked")).toBe("true");

      await act(async () => option("p3").click());
      expect(useTodos.getState().selectedProjectIds).toEqual(["p1", "p3"]);

      await act(async () => option("p1").click());
      expect(useTodos.getState().selectedProjectIds).toEqual(["p3"]);
      expect(JSON.parse(localStorage.getItem("todosProjects") ?? "null")).toEqual(["p3"]);

      const all = document.querySelector('[data-testid="todos-project-all"]') as HTMLElement;
      await act(async () => all.click());
      expect(useTodos.getState().selectedProjectIds).toEqual([]);
      expect(localStorage.getItem("todosProjects")).toBeNull();

      await act(async () => root.unmount());
    });
  });
});
