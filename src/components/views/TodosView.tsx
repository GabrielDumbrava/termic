// Todos view: cross-project triage workspace for issues and PRs (docs/ideas/todos-view.md).
// Filters live in useTodos and the lists in useForgeLists; does not write to
// useApp (bear traps 5 and 8).

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
import { useTodos, pickedProjects, todoQueries, todoRows, type TodoItem, type KindFilter, type ScopeFilter } from "@/store/todos";
import { forgeListKey, useForgeLists } from "@/store/forgeLists";
import { openPath } from "@/lib/ipc";
import { Button } from "@/components/ui/Button";
import { Tip } from "@/components/ui/Tooltip";
import {
  DropdownRoot,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem,
  DropdownCheckboxItem,
  DropdownSeparator,
} from "@/components/ui/Dropdown";
import { cn } from "@/lib/utils";
import { i18n } from "@/lib/i18n";

const TODOS_GRID = "grid grid-cols-[minmax(300px,1fr)_minmax(110px,160px)_76px_128px] items-center gap-x-4";

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
  const rtf = new Intl.RelativeTimeFormat(i18n.language, { numeric: "auto", style: "short" });
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return rtf.format(0, "second");
  if (diffMins < 60) return rtf.format(-diffMins, "minute");
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return rtf.format(-diffHours, "hour");
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return rtf.format(-diffDays, "day");
  return fmtDate(iso);
}

export function TodosView() {
  const { t } = useTranslation("sidebar");
  const projects = useApp((s) => s.projects);
  const openNewTask = useUI((s) => s.openNewTask);
  const openReviewPr = useUI((s) => s.openReviewPr);

  const entries = useForgeLists((s) => s.entries);
  const selectedProjectIds = useTodos((s) => s.selectedProjectIds);
  const kindFilter = useTodos((s) => s.kindFilter);
  const scopeFilter = useTodos((s) => s.scopeFilter);
  const searchQuery = useTodos((s) => s.searchQuery);

  const setSelectedProjectIds = useTodos((s) => s.setSelectedProjectIds);
  const setKindFilter = useTodos((s) => s.setKindFilter);
  const setScopeFilter = useTodos((s) => s.setScopeFilter);
  const setSearchQuery = useTodos((s) => s.setSearchQuery);
  const fetchVisibleTodos = useTodos((s) => s.fetchVisibleTodos);

  const gitProjects = useMemo(() => projects.filter((p) => !p.non_git), [projects]);
  // A removed project drops out here rather than out of the saved selection,
  // which is checked against the list only on read (see pickedProjects).
  const picked = useMemo(() => pickedProjects(gitProjects, selectedProjectIds), [gitProjects, selectedProjectIds]);
  const pickedIds = useMemo(() => new Set(picked.map((p) => p.id)), [picked]);

  // Built from what is on screen, so a toggle also drops any saved id whose
  // project is gone.
  const toggleProject = (id: string) =>
    setSelectedProjectIds(
      gitProjects.filter((p) => (p.id === id ? !pickedIds.has(id) : pickedIds.has(p.id))).map((p) => p.id)
    );

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

  const queries = useMemo(
    () => todoQueries(picked.length ? picked : gitProjects, kindFilter, scopeFilter),
    [picked, gitProjects, kindFilter, scopeFilter]
  );
  const querySig = useMemo(() => queries.map(forgeListKey).join("|"), [queries]);

  // On mount and whenever the lists the filters read change: a filter, the
  // picked projects, or a project list that arrived after the view did.
  // Within the TTL this fetches nothing.
  useEffect(() => {
    void fetchVisibleTodos(false);
  }, [querySig, fetchVisibleTodos]);

  const { items, totalUnfiltered, errors, pending } = useMemo(() => {
    const { items: allItems, errors, pending } = todoRows(queries, entries, gitProjects);

    const totalUnfiltered = allItems.length;

    // Filter by text search if present
    const rawQ = searchQuery.trim().toLowerCase();
    const cleanQ = rawQ.replace(/^[#!]/, "");
    const filtered = rawQ
      ? allItems.filter((item) => {
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
      : allItems;

    // Sort newest updated first
    filtered.sort((a, b) => {
      const tA = new Date(a.kind === "issue" ? a.issue.updated_at : a.pr.updated_at).getTime() || 0;
      const tB = new Date(b.kind === "issue" ? b.issue.updated_at : b.pr.updated_at).getTime() || 0;
      return tB - tA;
    });

    return { items: filtered, totalUnfiltered, errors, pending };
  }, [queries, entries, gitProjects, searchQuery]);

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
                  {picked.length === 0
                    ? t("todos.allProjects")
                    : picked.length === 1
                      ? picked[0].name
                      : t(picked.length === 1 ? "todos.projectsPicked_one" : "todos.projectsPicked_other", { count: picked.length })}
                </span>
                <ChevronDown className="h-3 w-3 opacity-60" />
              </button>
            </DropdownTrigger>
            <DropdownMenu align="end" className="w-56">
              {/* All closes the menu, a project row does not: All is a whole
                  answer that clears the rest, a project is one tick of several. */}
              <DropdownItem
                data-testid="todos-project-all"
                data-checked={picked.length === 0 ? "true" : "false"}
                onSelect={() => setSelectedProjectIds([])}
              >
                <span className="truncate">{t("todos.allProjects")}</span>
                {picked.length === 0 && <Check className="ml-auto h-3.5 w-3.5 text-[var(--color-accent)]" />}
              </DropdownItem>
              <DropdownSeparator />
              {gitProjects.map((p) => (
                <DropdownCheckboxItem
                  key={p.id}
                  data-testid="todos-project-option"
                  data-project-id={p.id}
                  checked={pickedIds.has(p.id)}
                  onCheckedChange={() => toggleProject(p.id)}
                >
                  <span className="truncate">{p.name}</span>
                </DropdownCheckboxItem>
              ))}
            </DropdownMenu>
          </DropdownRoot>

          {/* Refresh button */}
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => void fetchVisibleTodos(true)}
            data-testid="todos-refresh-button"
            className="h-7 text-[12px] gap-1.5"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", pending && "animate-spin")} />
            <span>{pending ? t("todos.refreshing") : t("todos.refresh")}</span>
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

          <div className="h-4 w-px bg-[var(--color-border-soft)]" />

          {/* Scope Filter Pills */}
          <div className="flex items-center rounded-md bg-[var(--color-bg-1)] p-0.5 border border-[var(--color-border-soft)]">
            {(["for_me", "review", "all"] as const).map((s) => (
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
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3" data-testid="todos-list">
        {items.length === 0 ? (
          // "No items" only once every list has answered: before that it would
          // be a claim about lists that are still on their way.
          <div
            data-testid={pending && totalUnfiltered === 0 ? "todos-loading" : "todos-empty"}
            className="flex h-full flex-col items-center justify-center p-8 text-center"
          >
            <div className="mb-3 rounded-full bg-[var(--color-bg-2)] p-3 text-[var(--color-fg-faint)]">
              <ListTodo className="h-8 w-8" />
            </div>
            {pending && totalUnfiltered === 0 ? (
              <h3 className="text-[14px] font-medium text-[var(--color-fg)]">{t("todos.loadingTitle")}</h3>
            ) : (
              <>
                <h3 className="text-[14px] font-medium text-[var(--color-fg)]">{t("todos.emptyTitle")}</h3>
                <p className="mt-1 max-w-sm text-[12.5px] text-[var(--color-fg-muted)]">
                  {t("todos.emptyDescription")}
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="w-full">
            {/* Column heads */}
            <div className={cn(TODOS_GRID, "px-3 pb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-fg-faint)] select-none")}>
              <span>{t("todos.colTitle")}</span>
              <span>{t("todos.colProject")}</span>
              <span className="text-right">{t("todos.colUpdated")}</span>
              <span />
            </div>

            <div className="space-y-0.5">
              {items.map((item) => {
                const title = item.kind === "issue" ? item.issue.title : item.pr.title;
                const number = item.kind === "issue" ? item.issue.number : item.pr.number;
                const author = item.kind === "issue" ? item.issue.author : item.pr.author;
                const updatedAt = item.kind === "issue" ? item.issue.updated_at : item.pr.updated_at;
                const labels = item.kind === "issue" ? item.issue.labels : [];
                const isDraft = item.kind === "pr" ? item.pr.draft : false;

                const iconColor = isDraft
                  ? "text-[var(--color-fg-faint)]"
                  : "text-emerald-500 dark:text-emerald-400";

                const hasAction = item.action !== "open";
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
                    ? "bg-[var(--color-info)]/12 text-[var(--color-info)] border-[var(--color-info)]/25"
                    : item.action === "review_requested"
                      ? "bg-[var(--color-warn)]/12 text-[var(--color-warn)] border-[var(--color-warn)]/25"
                      : item.action === "mentioned"
                        ? "bg-[var(--color-accent)]/12 text-[var(--color-accent)] border-[var(--color-accent)]/25"
                        : "bg-purple-500/12 text-purple-600 dark:text-purple-400 border-purple-500/25";

                const dotBg =
                  item.action === "assigned"
                    ? "bg-[var(--color-info)]"
                    : item.action === "review_requested"
                      ? "bg-[var(--color-warn)]"
                      : item.action === "mentioned"
                        ? "bg-[var(--color-accent)]"
                        : "bg-purple-500";

                return (
                  <div
                    key={item.id}
                    data-testid="todos-row"
                    className={cn(
                      TODOS_GRID,
                      "group rounded-md px-3 py-1.5 text-[13px] select-none transition-colors hover:bg-[var(--color-hover)]"
                    )}
                  >
                    {/* Title + Number + Role Badge + Status + Labels + Author */}
                    <div className="flex items-center gap-2 min-w-0">
                      {item.kind === "issue" ? (
                        <CircleDot className={cn("h-4 w-4 shrink-0", iconColor)} />
                      ) : (
                        <GitPullRequest className={cn("h-4 w-4 shrink-0", iconColor)} />
                      )}
                      <span className="font-mono text-[12px] text-[var(--color-fg-dim)] shrink-0">
                        {item.kind === "issue" ? `#${number}` : `!${number}`}
                      </span>
                      <span
                        className="font-medium text-[13px] text-[var(--color-fg)] truncate hover:text-[var(--color-accent)] transition-colors cursor-pointer"
                        onClick={() => handleStartTask(item)}
                        title={title}
                      >
                        {title}
                      </span>
                      {hasAction && (
                        <span
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium border shrink-0",
                            badgeBg
                          )}
                        >
                          <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", dotBg)} />
                          <span>{actionLabel}</span>
                        </span>
                      )}
                      {isDraft && (
                        <span className="rounded bg-[var(--color-bg-2)] px-1.5 py-0.5 text-[10px] uppercase font-semibold text-[var(--color-fg-faint)] border border-[var(--color-border-subtle)] shrink-0">
                          draft
                        </span>
                      )}
                      {labels.slice(0, 3).map((l) => (
                        <span
                          key={l}
                          className="hidden md:inline-flex items-center rounded-full bg-[var(--color-bg-2)] border border-[var(--color-border-subtle)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--color-fg-muted)] shrink-0"
                        >
                          {l}
                        </span>
                      ))}
                      <span className="text-[11.5px] text-[var(--color-fg-faint)] hidden lg:inline shrink-0 ml-auto pl-3">
                        by {author}
                      </span>
                    </div>

                    {/* Project */}
                    <div className="min-w-0">
                      <button
                        type="button"
                        onClick={() => setSelectedProjectIds([item.projectId])}
                        className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)] transition-colors max-w-full"
                        title={item.projectName}
                      >
                        <Folder className="h-3.5 w-3.5 text-[var(--color-fg-faint)] shrink-0" />
                        <span className="truncate">{item.projectName}</span>
                      </button>
                    </div>

                    {/* Updated */}
                    <div className="text-right text-[12px] tabular-nums text-[var(--color-fg-dim)] min-w-0">
                      <Tip content={fmtDate(updatedAt)}>
                        <span className="cursor-default truncate block">
                          {fmtRelative(updatedAt)}
                        </span>
                      </Tip>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center justify-end gap-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-150">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => handleStartTask(item)}
                        data-testid="todos-start-task"
                        className="h-6 px-2 text-[11px] font-medium gap-1 shadow-2xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] shrink-0"
                      >
                        {item.kind === "issue" ? (
                          <>
                            <Play className="h-3 w-3 fill-current" />
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
                          className="rounded-md p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)] transition-colors shrink-0"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </button>
                      </Tip>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Sticky Footer */}
      <footer
        data-testid="todos-footer"
        className="shrink-0 flex items-center justify-between border-t border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-6 py-2 text-[12px] text-[var(--color-fg-muted)]"
      >
        <div className="flex items-center gap-2">
          <span className="font-medium text-[var(--color-fg)]">
            {t(items.length === 1 ? "todos.footerTotal_one" : "todos.footerTotal_other", { count: items.length })}
          </span>
          <span className="text-[var(--color-border-subtle)]">•</span>
          <span>
            {t("todos.footerBreakdown", {
              issues: t(issueCount === 1 ? "todos.footerIssues_one" : "todos.footerIssues_other", { count: issueCount }),
              prs: t(prCount === 1 ? "todos.footerPrs_one" : "todos.footerPrs_other", { count: prCount }),
            })}
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
            {t(projectCount === 1 ? "todos.footerProjects_one" : "todos.footerProjects_other", { count: projectCount })}
          </span>
        </div>
      </footer>
    </div>
  );
}
