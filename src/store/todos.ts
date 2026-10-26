// Transient store for Todos view: query-keyed caching, throttled concurrency,
// filter state, and item derivation. Does NOT write to useApp (bear traps 5 and 8).

import { create } from "zustand";
import { useApp } from "@/store/app";
import { projectForgeIssues, projectForgePrs } from "@/lib/ipc";
import type { ForgeIssue, ForgePr, IssueScope, PrScope, Project } from "@/lib/types";

export type TodoItem =
  | {
      id: string;
      kind: "issue";
      projectId: string;
      projectName: string;
      issue: ForgeIssue;
      action: "assigned" | "mentioned" | "open";
    }
  | {
      id: string;
      kind: "pr";
      projectId: string;
      projectName: string;
      pr: ForgePr;
      action: "review_requested" | "authored" | "open";
    };

export type KindFilter = "all" | "issues" | "prs";
export type ScopeFilter = "all" | "for_me" | "review" | "open";

export type TodoQueryKey = string; // `${projectId}:${kind}:${scope}`

export interface QueryCacheEntry {
  items: TodoItem[];
  fetchedAt: number;
  status: "idle" | "loading" | "ok" | "error" | "unsupported";
  errorMessage?: string;
}

export const TODOS_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
export const MAX_CONCURRENT_JOBS = 3;

interface QueryTask {
  key: TodoQueryKey;
  projectId: string;
  projectName: string;
  kind: "issues" | "prs";
  scope: string;
}

export interface TodosState {
  cache: Record<TodoQueryKey, QueryCacheEntry>;
  selectedProjectId: string | null;
  kindFilter: KindFilter;
  scopeFilter: ScopeFilter;
  searchQuery: string;
  isRefreshing: boolean;

  setSelectedProjectId: (id: string | null) => void;
  setKindFilter: (kind: KindFilter) => void;
  setScopeFilter: (scope: ScopeFilter) => void;
  setSearchQuery: (query: string) => void;
  fetchVisibleTodos: (force?: boolean) => Promise<void>;
  clearCache: () => void;
}

export function makeQueryKey(projectId: string, kind: "issues" | "prs", scope: string): TodoQueryKey {
  return `${projectId}:${kind}:${scope}`;
}

export const useTodos = create<TodosState>((set, get) => ({
  cache: {},
  selectedProjectId: null,
  kindFilter: "all",
  scopeFilter: "for_me",
  searchQuery: "",
  isRefreshing: false,

  setSelectedProjectId: (id) => {
    if (get().selectedProjectId === id) return;
    set({ selectedProjectId: id });
    void get().fetchVisibleTodos(false);
  },

  setKindFilter: (kind) => {
    if (get().kindFilter === kind) return;
    set({ kindFilter: kind });
    void get().fetchVisibleTodos(false);
  },

  setScopeFilter: (scope) => {
    if (get().scopeFilter === scope) return;
    set({ scopeFilter: scope });
    void get().fetchVisibleTodos(false);
  },

  setSearchQuery: (query) => {
    if (get().searchQuery === query) return;
    set({ searchQuery: query });
  },

  clearCache: () => {
    jobQueue.length = 0;
    set({ cache: {}, isRefreshing: false });
  },

  fetchVisibleTodos: async (force = false) => {
    const { selectedProjectId, kindFilter, scopeFilter, cache } = get();
    const allProjects = useApp.getState().projects;

    // Filter candidate projects (only git-enabled projects)
    const candidateProjects = allProjects.filter((p) => {
      if (p.non_git) return false;
      if (selectedProjectId && p.id !== selectedProjectId) return false;
      return true;
    });

    if (candidateProjects.length === 0) return;

    // Determine query tasks
    const tasks: QueryTask[] = [];
    for (const p of candidateProjects) {
      if (scopeFilter === "for_me") {
        if (kindFilter === "all" || kindFilter === "issues") {
          tasks.push({
            key: makeQueryKey(p.id, "issues", "assigned"),
            projectId: p.id,
            projectName: p.name,
            kind: "issues",
            scope: "assigned",
          });
        }
        if (kindFilter === "all" || kindFilter === "prs") {
          tasks.push({
            key: makeQueryKey(p.id, "prs", "review"),
            projectId: p.id,
            projectName: p.name,
            kind: "prs",
            scope: "review",
          });
          tasks.push({
            key: makeQueryKey(p.id, "prs", "mine"),
            projectId: p.id,
            projectName: p.name,
            kind: "prs",
            scope: "mine",
          });
        }
      } else if (scopeFilter === "review") {
        tasks.push({
          key: makeQueryKey(p.id, "prs", "review"),
          projectId: p.id,
          projectName: p.name,
          kind: "prs",
          scope: "review",
        });
      } else if (scopeFilter === "all" || scopeFilter === "open") {
        if (kindFilter === "all" || kindFilter === "issues") {
          tasks.push({
            key: makeQueryKey(p.id, "issues", "all"),
            projectId: p.id,
            projectName: p.name,
            kind: "issues",
            scope: "all",
          });
          tasks.push({
            key: makeQueryKey(p.id, "issues", "assigned"),
            projectId: p.id,
            projectName: p.name,
            kind: "issues",
            scope: "assigned",
          });
        }
        if (kindFilter === "all" || kindFilter === "prs") {
          tasks.push({
            key: makeQueryKey(p.id, "prs", "open"),
            projectId: p.id,
            projectName: p.name,
            kind: "prs",
            scope: "open",
          });
          tasks.push({
            key: makeQueryKey(p.id, "prs", "review"),
            projectId: p.id,
            projectName: p.name,
            kind: "prs",
            scope: "review",
          });
          tasks.push({
            key: makeQueryKey(p.id, "prs", "mine"),
            projectId: p.id,
            projectName: p.name,
            kind: "prs",
            scope: "mine",
          });
        }
      }
    }

    const now = Date.now();
    const tasksToRun = tasks.filter((t) => {
      if (force) return true;
      const entry = cache[t.key];
      if (!entry) return true;
      if (entry.status === "loading") return false;
      return now - entry.fetchedAt >= TODOS_CACHE_TTL_MS;
    });

    if (tasksToRun.length === 0) return;

    // Filter out tasks already queued
    const tasksToEnqueue = tasksToRun.filter(
      (t) => !jobQueue.some((q) => q.task.key === t.key)
    );

    if (tasksToEnqueue.length === 0) return;

    // Mark tasks as loading
    set((s) => {
      const nextCache = { ...s.cache };
      for (const t of tasksToEnqueue) {
        const existing = nextCache[t.key];
        nextCache[t.key] = {
          items: existing?.items ?? [],
          fetchedAt: existing?.fetchedAt ?? 0,
          status: "loading",
        };
      }
      return { cache: nextCache, isRefreshing: true };
    });

    await new Promise<void>((resolve) => {
      let remaining = tasksToEnqueue.length;
      for (const task of tasksToEnqueue) {
        jobQueue.push({
          task,
          resolve: () => {
            remaining--;
            if (remaining === 0) resolve();
          },
        });
      }
      pumpQueue(set, get);
    });
  },
}));

let activeJobs = 0;
const jobQueue: Array<{
  task: QueryTask;
  resolve: () => void;
}> = [];

function pumpQueue(
  set: (fn: (s: TodosState) => Partial<TodosState>) => void,
  get: () => TodosState
) {
  while (activeJobs < MAX_CONCURRENT_JOBS && jobQueue.length > 0) {
    const nextItem = jobQueue.shift();
    if (!nextItem) break;
    activeJobs++;
    set(() => ({ isRefreshing: true }));

    const { task, resolve } = nextItem;
    const prevEntry = get().cache[task.key];

    void executeTask(task, prevEntry)
      .then((result) => {
        set((s) => ({
          cache: {
            ...s.cache,
            [task.key]: result,
          },
        }));
      })
      .catch((err) => {
        set((s) => ({
          cache: {
            ...s.cache,
            [task.key]: {
              items: s.cache[task.key]?.items ?? [],
              fetchedAt: Date.now(),
              status: "error",
              errorMessage: String(err),
            },
          },
        }));
      })
      .finally(() => {
        activeJobs--;
        resolve();
        pumpQueue(set, get);
        if (activeJobs === 0 && jobQueue.length === 0) {
          set(() => ({ isRefreshing: false }));
        }
      });
  }
}

async function executeTask(task: QueryTask, prevEntry?: QueryCacheEntry): Promise<QueryCacheEntry> {
  const now = Date.now();
  if (task.kind === "issues") {
    const res = await projectForgeIssues(task.projectId, 50, task.scope as IssueScope);
    if (res.status !== "ok") {
      const isUnsupported =
        res.status === "unsupported-remote" ||
        res.message.toLowerCase().includes("not supported") ||
        res.message.toLowerCase().includes("unsupported");
      return {
        items: prevEntry?.items ?? [],
        // A failure is cached for the TTL like a success, or every filter
        // change re-ran the failing CLI. Refresh still forces a retry.
        fetchedAt: now,
        status: isUnsupported ? "unsupported" : "error",
        errorMessage: res.message || res.status,
      };
    }

    const items: TodoItem[] = res.issues.map((i) => ({
      id: `${task.projectId}:issue:${i.number}`,
      kind: "issue" as const,
      projectId: task.projectId,
      projectName: task.projectName,
      issue: i,
      action: task.scope === "assigned" ? "assigned" : task.scope === "mentions" ? "mentioned" : "open",
    }));

    return {
      items,
      fetchedAt: now,
      status: "ok",
    };
  } else {
    const res = await projectForgePrs(task.projectId, { scope: task.scope as PrScope, limit: 30 });
    if (res.status !== "ok") {
      const isUnsupported =
        res.status === "unsupported-remote" ||
        res.message.toLowerCase().includes("not supported") ||
        res.message.toLowerCase().includes("unsupported");
      return {
        items: prevEntry?.items ?? [],
        // A failure is cached for the TTL like a success, or every filter
        // change re-ran the failing CLI. Refresh still forces a retry.
        fetchedAt: now,
        status: isUnsupported ? "unsupported" : "error",
        errorMessage: res.message || res.status,
      };
    }

    const items: TodoItem[] = res.prs.map((p) => ({
      id: `${task.projectId}:pr:${p.number}`,
      kind: "pr" as const,
      projectId: task.projectId,
      projectName: task.projectName,
      pr: p,
      action: task.scope === "review" ? "review_requested" : task.scope === "mine" ? "authored" : "open",
    }));

    return {
      items,
      fetchedAt: now,
      status: "ok",
    };
  }
}
