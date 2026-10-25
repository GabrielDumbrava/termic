// Todos view: cross-project triage workspace for issues and PRs (docs/ideas/todos-view.md).
// Reads useTodos for cache and filter state; does not write to useApp (bear traps 5 and 8).

import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  Check,
  ChevronDown,
  CircleDot,
  ExternalLink,
  Folder,
  GitPullRequest,
  ListTodo,
  Play,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { useTodos, type TodoItem, type KindFilter, type ScopeFilter, type StatusFilter } from "@/store/todos";
import { openPath } from "@/lib/ipc";
import { Button } from "@/components/ui/Button";
import { Tip } from "@/components/ui/Tooltip";
import {
  DropdownRoot,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem,
  DropdownSeparator,
} from "@/components/ui/Dropdown";
import { cn } from "@/lib/utils";
import { i18n } from "@/lib/i18n";

function fmtDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(i18n.language, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
  }).format(d);
}

function fmtRelative(iso: string): string {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  if (isNaN(diffMs) || diffMs < 0) return fmtDate(iso);
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return fmtDate(iso);
}

export function TodosView() {
  const { t } = useTranslation("sidebar");
  const projects = useApp((s) => s.projects);
  const openNewTask = useUI((s) => s.openNewTask);
  const openReviewPr = useUI((s) => s.openReviewPr);

  const cache = useTodos((s) => s.cache);
  const selectedProjectId = useTodos((s) => s.selectedProjectId);
  const kindFilter = useTodos((s) => s.kindFilter);
  const scopeFilter = useTodos((s) => s.scopeFilter);
  const statusFilter = useTodos((s) => s.statusFilter);
  const searchQuery = useTodos((s) => s.searchQuery);
  const isRefreshing = useTodos((s) => s.isRefreshing);

  const setSelectedProjectId = useTodos((s) => s.setSelectedProjectId);
  const setKindFilter = useTodos((s) => s.setKindFilter);
  const setScopeFilter = useTodos((s) => s.setScopeFilter);
  const setStatusFilter = useTodos((s) => s.setStatusFilter);
  const setSearchQuery = useTodos((s) => s.setSearchQuery);
  const fetchVisibleTodos = useTodos((s) => s.fetchVisibleTodos);

  // Eager load when the view is mounted
  useEffect(() => {
    void fetchVisibleTodos(false);
  }, []);

  const gitProjects = useMemo(() => projects.filter((p) => !p.non_git), [projects]);
  const activeProject = gitProjects.find((p) => p.id === selectedProjectId) ?? null;

  // Reset orphaned project filter if the selected project was removed
  useEffect(() => {
    if (selectedProjectId && !gitProjects.some((p) => p.id === selectedProjectId)) {
      setSelectedProjectId(null);
    }
  }, [selectedProjectId, gitProjects, setSelectedProjectId]);

  const handleKindClick = (k: KindFilter) => {
    if (k === "issues" && scopeFilter === "review") {
      setScopeFilter("for_me");
    }
    setKindFilter(k);
  };

  const handleScopeClick = (s: ScopeFilter) => {
    if (s === "review" && kindFilter === "issues") {
      setKindFilter("prs");
    }
    setScopeFilter(s);
  };

  // Aggregate items from matching cache entries
  const { items, totalUnfiltered, errors } = useMemo(() => {
    const candidateProjects = gitProjects.filter((p) =>
      selectedProjectId ? p.id === selectedProjectId : true
    );

    const relevantKeys: string[] = [];
    for (const p of candidateProjects) {
      if (scopeFilter === "for_me") {
        if (kindFilter === "all" || kindFilter === "issues") {
          relevantKeys.push(`${p.id}:issues:assigned`);
        }
        if (kindFilter === "all" || kindFilter === "prs") {
          relevantKeys.push(`${p.id}:prs:review`);
          relevantKeys.push(`${p.id}:prs:mine`);
        }
      } else if (scopeFilter === "review") {
        if (kindFilter !== "issues") {
          relevantKeys.push(`${p.id}:prs:review`);
        }
      } else if (scopeFilter === "all" || scopeFilter === "open") {
        if (kindFilter === "all" || kindFilter === "issues") {
          relevantKeys.push(`${p.id}:issues:all`);
          relevantKeys.push(`${p.id}:issues:assigned`);
        }
        if (kindFilter === "all" || kindFilter === "prs") {
          relevantKeys.push(`${p.id}:prs:open`);
          relevantKeys.push(`${p.id}:prs:review`);
          relevantKeys.push(`${p.id}:prs:mine`);
        }
      }
    }

    const ACTION_WEIGHT: Record<string, number> = {
      assigned: 5,
      review_requested: 4,
      authored: 3,
      mentioned: 2,
      open: 1,
    };

    const itemsById = new Map<string, TodoItem>();
    const collectedErrors: Array<{ key: string; message: string }> = [];

    for (const k of relevantKeys) {
      const entry = cache[k];
      if (!entry) continue;
      if ((entry.status === "error" || entry.status === "unsupported") && entry.errorMessage) {
        collectedErrors.push({ key: k, message: entry.errorMessage });
      }
      for (const item of entry.items) {
        const existing = itemsById.get(item.id);
        if (!existing) {
          itemsById.set(item.id, item);
        } else {
          const existingWeight = ACTION_WEIGHT[existing.action] ?? 0;
          const newWeight = ACTION_WEIGHT[item.action] ?? 0;
          if (newWeight > existingWeight) {
            itemsById.set(item.id, item);
          }
        }
      }
    }

    const allItems = Array.from(itemsById.values());
    const totalUnfiltered = allItems.length;

    // Filter by status (all / open / closed)
    const statusFiltered = allItems.filter((item) => {
      if (statusFilter === "all") return true;
      const st = (item.state || "open").toLowerCase();
      const isClosed = st === "closed" || st === "merged";
      if (statusFilter === "open") return !isClosed;
      if (statusFilter === "closed") return isClosed;
      return true;
    });

    // Filter by text search if present
    const rawQ = searchQuery.trim().toLowerCase();
    const cleanQ = rawQ.replace(/^[#!]/, "");
    const filtered = rawQ
      ? statusFiltered.filter((item) => {
          const title = item.kind === "issue" ? item.issue.title : item.pr.title;
          const author = item.kind === "issue" ? item.issue.author : item.pr.author;
          const num = item.kind === "issue" ? String(item.issue.number) : String(item.pr.number);
          const ref = item.kind === "issue" ? `#${item.issue.number}` : `!${item.pr.number}`;
          const labels = item.kind === "issue" ? item.issue.labels.join(" ") : "";
          const pName = item.projectName;

          return (
            title.toLowerCase().includes(rawQ) ||
            author.toLowerCase().includes(rawQ) ||
            num.includes(cleanQ) ||
            ref.toLowerCase().includes(rawQ) ||
            labels.toLowerCase().includes(rawQ) ||
            pName.toLowerCase().includes(rawQ)
          );
        })
      : statusFiltered;

    // Sort newest updated first
    filtered.sort((a, b) => {
      const tA = new Date(a.kind === "issue" ? a.issue.updated_at : a.pr.updated_at).getTime() || 0;
      const tB = new Date(b.kind === "issue" ? b.issue.updated_at : b.pr.updated_at).getTime() || 0;
      return tB - tA;
    });

    return { items: filtered, totalUnfiltered, errors: collectedErrors };
  }, [gitProjects, selectedProjectId, scopeFilter, kindFilter, statusFilter, cache, searchQuery]);

  const { issueCount, prCount, assignedCount, reviewCount, authoredCount, projectCount } = useMemo(() => {
    let issues = 0;
    let prs = 0;
    let assigned = 0;
    let review = 0;
    let authored = 0;
    const projectIds = new Set<string>();

    for (const item of items) {
      if (item.kind === "issue") issues++;
      if (item.kind === "pr") prs++;
      if (item.action === "assigned") assigned++;
      if (item.action === "review_requested") review++;
      if (item.action === "authored") authored++;
      projectIds.add(item.projectId);
    }

    return {
      issueCount: issues,
      prCount: prs,
      assignedCount: assigned,
      reviewCount: review,
      authoredCount: authored,
      projectCount: projectIds.size,
    };
  }, [items]);

  function handleStartTask(item: TodoItem) {
    if (item.kind === "issue") {
      openNewTask(item.projectId, {
        issue: item.issue,
        mode: "worktree",
      });
    } else {
      openReviewPr(item.projectId, {
        number: item.pr.number,
        url: item.pr.url,
      });
    }
  }

  function handleOpenBrowser(item: TodoItem) {
    const url = item.kind === "issue" ? item.issue.url : item.pr.url;
    if (url) {
      void openPath(url);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--color-bg)] select-none" data-testid="todos-view">
      {/* Top Header */}
      <div className="shrink-0 flex items-center justify-between border-b border-[var(--color-border-soft)] px-6 py-3">
        <div className="flex items-center gap-2.5">
          <ListTodo className="h-5 w-5 text-[var(--color-accent)]" />
          <h1 className="text-[15px] font-semibold text-[var(--color-fg)]">{t("todos.title")}</h1>
          <span className="rounded-full bg-[var(--color-bg-2)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-fg-dim)]">
            {items.length}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Project selector */}
          <DropdownRoot>
            <DropdownTrigger asChild>
              <button
                type="button"
                data-testid="todos-project-filter"
                className="flex h-7 items-center gap-1.5 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-2.5 text-[12px] font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-fg)]"
              >
                <Folder className="h-3.5 w-3.5 text-[var(--color-fg-faint)]" />
                <span className="max-w-[150px] truncate">
                  {activeProject ? activeProject.name : t("todos.allProjects")}
                </span>
                <ChevronDown className="h-3 w-3 opacity-60" />
              </button>
            </DropdownTrigger>
            <DropdownMenu align="end" className="w-56">
              <DropdownItem onSelect={() => setSelectedProjectId(null)}>
                <span className="truncate">{t("todos.allProjects")}</span>
                {!selectedProjectId && <Check className="ml-auto h-3.5 w-3.5 text-[var(--color-accent)]" />}
              </DropdownItem>
              <DropdownSeparator />
              {gitProjects.map((p) => (
                <DropdownItem key={p.id} onSelect={() => setSelectedProjectId(p.id)}>
                  <span className="truncate">{p.name}</span>
                  {selectedProjectId === p.id && (
                    <Check className="ml-auto h-3.5 w-3.5 text-[var(--color-accent)]" />
                  )}
                </DropdownItem>
              ))}
            </DropdownMenu>
          </DropdownRoot>

          {/* Refresh button */}
          <Button
            size="sm"
            variant="secondary"
            disabled={isRefreshing}
            onClick={() => void fetchVisibleTodos(true)}
            data-testid="todos-refresh-button"
            className="h-7 text-[12px] gap-1.5"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
            <span>{isRefreshing ? t("todos.refreshing") : t("todos.refresh")}</span>
          </Button>
        </div>
      </div>

      {/* Filter and Search Controls Bar */}
      <div className="shrink-0 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border-soft)] px-6 py-2.5 bg-[var(--color-bg-2)]/30">
        <div className="flex flex-wrap items-center gap-3">
          {/* Kind Filter Pills */}
          <div className="flex items-center rounded-md bg-[var(--color-bg-1)] p-0.5 border border-[var(--color-border-soft)]">
            {(["all", "issues", "prs"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => handleKindClick(k)}
                data-testid={`todos-kind-${k}`}
                className={cn(
                  "rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors",
                  kindFilter === k
                    ? "bg-[var(--color-bg-2)] text-[var(--color-fg)] shadow-xs"
                    : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                )}
              >
                {k === "all"
                  ? t("todos.kindAll")
                  : k === "issues"
                    ? t("todos.kindIssues")
                    : t("todos.kindPrs")}
              </button>
            ))}
          </div>

          {/* Scope Filter Pills */}
          <div className="flex items-center rounded-md bg-[var(--color-bg-1)] p-0.5 border border-[var(--color-border-soft)]">
            {(["all", "for_me", "review"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => handleScopeClick(s)}
                data-testid={`todos-scope-${s}`}
                className={cn(
                  "rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors",
                  scopeFilter === s || (s === "all" && scopeFilter === "open")
                    ? "bg-[var(--color-bg-2)] text-[var(--color-fg)] shadow-xs"
                    : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                )}
              >
                {s === "all"
                  ? t("todos.scopeAll")
                  : s === "for_me"
                    ? t("todos.scopeForMe")
                    : t("todos.scopeReview")}
              </button>
            ))}
          </div>

          {/* Status Filter Pills */}
          <div className="flex items-center rounded-md bg-[var(--color-bg-1)] p-0.5 border border-[var(--color-border-soft)]">
            {(["all", "open", "closed"] as const).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                data-testid={`todos-status-${st}`}
                className={cn(
                  "rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors",
                  statusFilter === st
                    ? "bg-[var(--color-bg-2)] text-[var(--color-fg)] shadow-xs"
                    : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                )}
              >
                {st === "all"
                  ? t("todos.statusAll")
                  : st === "open"
                    ? t("todos.statusOpen")
                    : t("todos.statusClosed")}
              </button>
            ))}
          </div>
        </div>

        {/* Text Search Bar */}
        <div className="relative flex min-w-[220px] max-w-sm flex-1 items-center">
          <Search className="absolute left-2.5 h-3.5 w-3.5 text-[var(--color-fg-faint)] pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("todos.searchPlaceholder")}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            className="h-7 w-full rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-1)] pl-8 pr-7 text-[12px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] outline-none focus:border-[var(--color-accent)]"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute right-2 text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* Partial Error / Unsupported Notice */}
      {errors.length > 0 && (
        <div className="shrink-0 flex items-center gap-2 bg-[var(--color-warn)]/10 px-6 py-2 text-[12px] text-[var(--color-warn)] border-b border-[var(--color-warn)]/20">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {errors[0].message || t("todos.unsupportedNotice")}
          </span>
        </div>
      )}

      {/* Content Table / List */}
      <div className="flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center p-8 text-center">
            <div className="mb-3 rounded-full bg-[var(--color-bg-2)] p-3 text-[var(--color-fg-faint)]">
              <ListTodo className="h-8 w-8" />
            </div>
            <h3 className="text-[14px] font-medium text-[var(--color-fg)]">{t("todos.emptyTitle")}</h3>
            <p className="mt-1 max-w-sm text-[12.5px] text-[var(--color-fg-muted)]">
              {t("todos.emptyDescription")}
            </p>
          </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[var(--color-border-soft)] text-[11px] font-semibold uppercase tracking-wider text-[var(--color-fg-faint)] bg-[var(--color-bg)] sticky top-0 z-10">
                <th className="py-2 px-6 w-32">{t("todos.colAction")}</th>
                <th className="py-2 px-4">{t("todos.colTitle")}</th>
                <th className="py-2 px-4 w-44">{t("todos.colProject")}</th>
                <th className="py-2 px-4 w-28">{t("todos.colUpdated")}</th>
                <th className="py-2 px-6 w-36 text-right">{t("todos.startTask")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-subtle)]">
              {items.map((item) => {
                const title = item.kind === "issue" ? item.issue.title : item.pr.title;
                const number = item.kind === "issue" ? item.issue.number : item.pr.number;
                const author = item.kind === "issue" ? item.issue.author : item.pr.author;
                const updatedAt = item.kind === "issue" ? item.issue.updated_at : item.pr.updated_at;
                const labels = item.kind === "issue" ? item.issue.labels : [];
                const isDraft = item.kind === "pr" ? item.pr.draft : false;

                const actionLabel =
                  item.action === "assigned"
                    ? t("todos.actionAssigned")
                    : item.action === "review_requested"
                      ? t("todos.actionReview")
                      : item.action === "mentioned"
                        ? t("todos.actionMentioned")
                        : item.action === "authored"
                          ? t("todos.actionAuthored")
                          : t("todos.actionOpen");

                const badgeBg =
                  item.action === "assigned"
                    ? "bg-[var(--color-info)]/15 text-[var(--color-info)]"
                    : item.action === "review_requested"
                      ? "bg-[var(--color-warn)]/15 text-[var(--color-warn)]"
                      : item.action === "mentioned"
                        ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
                        : "bg-[var(--color-bg-2)] text-[var(--color-fg-muted)]";

                return (
                  <tr
                    key={item.id}
                    data-testid="todos-row"
                    className="group hover:bg-[var(--color-bg-hover)] transition-colors"
                  >
                    {/* Action Badge */}
                    <td className="py-2.5 px-6 whitespace-nowrap">
                      <span className={cn("inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium", badgeBg)}>
                        {actionLabel}
                      </span>
                    </td>

                    {/* Title + Number + Labels */}
                    <td className="py-2.5 px-4 min-w-0">
                      <div className="flex items-center gap-2">
                        {item.kind === "issue" ? (
                          <CircleDot className="h-4 w-4 shrink-0 text-[var(--color-fg-faint)]" />
                        ) : (
                          <GitPullRequest className="h-4 w-4 shrink-0 text-[var(--color-fg-faint)]" />
                        )}
                        <span className="font-mono text-[12px] text-[var(--color-fg-faint)] shrink-0">
                          {item.kind === "issue" ? `#${number}` : `!${number}`}
                        </span>
                        <span className="font-medium text-[13px] text-[var(--color-fg)] truncate max-w-xl">
                          {title}
                        </span>
                        {isDraft && (
                          <span className="rounded bg-[var(--color-bg-2)] px-1.5 py-0.5 text-[10px] uppercase font-semibold text-[var(--color-fg-faint)]">
                            draft
                          </span>
                        )}
                        {item.state && (item.state.toLowerCase() === "closed" || item.state.toLowerCase() === "merged") && (
                          <span className="rounded bg-[var(--color-warn)]/10 px-1.5 py-0.5 text-[10px] uppercase font-semibold text-[var(--color-warn)]">
                            {item.state.toLowerCase()}
                          </span>
                        )}
                        {labels.slice(0, 3).map((l) => (
                          <span
                            key={l}
                            className="hidden md:inline-block rounded bg-[var(--color-bg-2)] px-1.5 py-0.5 text-[10.5px] text-[var(--color-fg-muted)]"
                          >
                            {l}
                          </span>
                        ))}
                        <span className="text-[11.5px] text-[var(--color-fg-faint)] hidden lg:inline shrink-0">
                          by {author}
                        </span>
                      </div>
                    </td>

                    {/* Project */}
                    <td className="py-2.5 px-4 whitespace-nowrap">
                      <div className="flex items-center gap-1.5 text-[12px] text-[var(--color-fg-muted)]">
                        <Folder className="h-3.5 w-3.5 text-[var(--color-fg-faint)] shrink-0" />
                        <span className="truncate max-w-[150px]">{item.projectName}</span>
                      </div>
                    </td>

                    {/* Updated */}
                    <td className="py-2.5 px-4 whitespace-nowrap">
                      <Tip content={fmtDate(updatedAt)}>
                        <span className="text-[12px] text-[var(--color-fg-dim)] cursor-default">
                          {fmtRelative(updatedAt)}
                        </span>
                      </Tip>
                    </td>

                    {/* Actions */}
                    <td className="py-2.5 px-6 whitespace-nowrap text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => handleStartTask(item)}
                          data-testid="todos-start-task"
                          className="h-6 px-2 text-[11px] gap-1"
                        >
                          {item.kind === "issue" ? (
                            <>
                              <Play className="h-3 w-3" />
                              <span>{t("todos.startTask")}</span>
                            </>
                          ) : (
                            <>
                              <GitPullRequest className="h-3 w-3" />
                              <span>{t("todos.reviewPr")}</span>
                            </>
                          )}
                        </Button>
                        <Tip content={t("todos.openInBrowser")}>
                          <button
                            type="button"
                            onClick={() => handleOpenBrowser(item)}
                            data-testid="todos-open-browser"
                            className="rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-fg)]"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </button>
                        </Tip>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Sticky Footer */}
      <footer
        data-testid="todos-footer"
        className="shrink-0 flex items-center justify-between border-t border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-6 py-2 text-[12px] text-[var(--color-fg-muted)]"
      >
        <div className="flex items-center gap-2">
          <span className="font-medium text-[var(--color-fg)]">
            {t("todos.footerTotal", { count: items.length })}
          </span>
          <span className="text-[var(--color-border-subtle)]">•</span>
          <span>
            {t("todos.footerBreakdown", { issues: issueCount, prs: prCount })}
          </span>
          {items.length !== totalUnfiltered && (
            <>
              <span className="text-[var(--color-border-subtle)]">•</span>
              <span className="text-[var(--color-fg-faint)]">
                {t("todos.footerFiltered", { total: totalUnfiltered })}
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-3">
          {assignedCount > 0 && (
            <span className="inline-flex items-center rounded bg-[var(--color-info)]/10 px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-info)]">
              {t("todos.footerAssigned", { count: assignedCount })}
            </span>
          )}
          {reviewCount > 0 && (
            <span className="inline-flex items-center rounded bg-[var(--color-warn)]/10 px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-warn)]">
              {t("todos.footerReview", { count: reviewCount })}
            </span>
          )}
          {authoredCount > 0 && (
            <span className="inline-flex items-center rounded bg-[var(--color-bg-2)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-fg-muted)]">
              {t("todos.footerAuthored", { count: authoredCount })}
            </span>
          )}
          <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-fg-faint)]">
            <Folder className="h-3 w-3" />
            {t("todos.footerProjects", { count: projectCount })}
          </span>
        </div>
      </footer>
    </div>
  );
}
