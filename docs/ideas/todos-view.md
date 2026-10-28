# Todos view

A full-screen view in the main area for cross-project forge work items:
issues, pull requests waiting on review, pull requests assigned to you,
and open items across all configured repositories.

This document proposes lifting Termic's existing forge query
capabilities out of the modal New Task dialog into a first-class planning
and triage workspace, inspired by Orca's Tasks and My Todos surface.

## Motivation and background

Termic already provides deep integrations with GitHub, GitLab, and
Azure DevOps via their respective CLIs (`gh`, `glab`, `az`) in
`src-tauri/src/forge.rs`. Today, these integrations power two workflows:

1. Per-task PR status and inline review comments in the task tab strip.
2. The New Task dialog's "From issue", "Pull request", and "Existing
   branch" pickers.

While effective for kicking off a specific task when the user already
knows what to work on, this architecture has a major usability gap:

- **No cross-project visibility**: To see what is assigned to you across
  four projects, you must open "New Task", pick a project, switch to
  issue or PR mode, inspect the list, cancel, and repeat for each project.
- **No unified triage inbox**: Review requests from teammates and
  assigned bugs are scattered across browser tabs and email notifications.
- **No bird's-eye planning**: Developers cannot sit in one view at the
  start of the day to review pending reviews, assigned tickets, and team
  PRs before deciding which tasks to spawn.

A dedicated `Todos` view solves this by providing a unified, filterable
cross-project inbox with 1-click task creation and browser access.

## Goals and non-goals

### Goals

- **Unified aggregation**: Display issues, PRs assigned to the user,
  open PRs from teammates, and review requests across all active projects.
- **Fast, flexible filtering**: Filter by project, item kind (all, issues,
  PRs), and scope (assigned to me, review requested, created by me, all open).
- **Instant search**: In-memory text filtering across loaded titles, numbers,
  authors, and labels.
- **Direct task conversion**: 1-click action to spawn a worktree or
  checkout branch pre-seeded with the agent prompt and derived branch name,
  using Termic's existing `NewTaskDialog` seed and `startPrReview()` coordinators.
- **Zero background overhead**: Strict adherence to Termic's performance
  discipline: on-demand querying only, query-keyed caching, bounded
  subprocess concurrency, and zero background polling loops.

### Non-goals

- **Not a full issue tracker replacement**: Termic will not provide issue
  creation, editing, label modification, or comment management in this view.
  Items link out to the forge web UI for full ticket management.
- **No background notification daemon**: Termic does not run background
  watchers that ping GitHub or GitLab every 30 seconds.
- **Multi-repo project decomposition in V1**: Single-repo git projects
  are supported first (matching `NewTaskDialog` issue/PR mode). Multi-repo
  project member resolution is deferred to a follow-up.

## User workflows

### 1. Morning triage and planning

1. The developer opens Termic and clicks "Todos" in the left sidebar top rail.
2. The view loads the default filter: `Assigned to me` (the union of assigned
   issues and review-requested PRs) across `All projects`.
3. The developer scans their assigned issues and PR review requests.
4. Clicking "Start Task" on an issue opens `NewTaskDialog` pre-seeded with
   the issue title, description prompt, and derived branch name, allowing
   agent and sandbox selection before launching.

### 2. Code review turnaround

1. The developer switches the filter to `Review requested`.
2. A row displays `!412: Add telemetry for docker pty` in `termic/daemon`.
3. The developer clicks "Review Task": Termic invokes `startPrReview()`,
   fetching the remote PR branch, creating a review worktree, and arming
   the agent with the review prompt.

### 3. Cross-project status check

1. The developer switches to `All open` and filters by `termic/cli`.
2. They scan open PRs from other contributors to check what is in flight
   before opening a new feature branch.

## Scope and capability matrix

Different forges support different query scopes via their CLIs:

| Scope | GitHub (`gh`) | GitLab (`glab`) | Azure DevOps (`az`) | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Assigned issues** | Supported (`--assignee @me`) | Supported (`scope=assigned_to_me`) | Supported (WIQL `@Me`) | Primary issue inbox |
| **Mentions (issues)** | Supported (`--mention @me`) | Not supported | Not supported | GitHub only in V1 |
| **Review requested (PR)** | Supported (`--review-requested @me`) | Supported (`reviewer_username`) | Unsupported | Azure shows explicit notice |
| **Authored PRs** | Supported (`--author @me`) | Supported (`scope=assigned_to_me`) | Supported (`--creator`) | "Created by me" PR list |
| **All open issues** | Supported (capped limit) | Supported (capped limit) | Supported (bounded WIQL) | Repo-wide open issues |
| **All open PRs** | Supported (capped limit) | Supported (capped limit) | Supported (capped limit) | Repo-wide open PRs |

**Default View ("For me")**:
The default inbox view presents:
`Assigned issues ∪ Review-requested PRs ∪ Authored open PRs`.
This provides a comprehensive personal dashboard across projects.

## Architecture and components

```
+-----------------------------------------------------------------------------------------+
| Todos                                                   [ All projects v ] [ Refresh 🔄 ]|
|                                                                                         |
| Kind:  [ All ] [ Issues ] [ PRs ]   |   Scope: [ For me ] [ Review requested ] [ All open ]
| [ 🔍 Search loaded items by title, #number, author...                                 ] |
+-----------------------------------------------------------------------------------------+
| ACTION / KIND    TITLE                                    PROJECT           UPDATED     |
| [assigned]       Fix memory leak in reader (#412)         termic/core       2 hours ago |
| [review]         Add telemetry for docker pty (!88)       termic/daemon     Yesterday   |
| [authored]       Update proxy test runner (#305)          termic/cli        3 days ago  |
+-----------------------------------------------------------------------------------------+
```

### 1. View layer and navigation

- **Top navigation rail**: A new `NavItem` in `src/components/sidebar/Sidebar.tsx`
  using the Lucide `ListTodo` icon. Placed alongside `Dashboard`,
  `History`, `Board`, and `Scheduled`.
- **View enum**: Add `"todos"` to `View["page"]` in `src/store/app.ts`.
- **MainArea overlay**: Mount `<TodosView />` in
  `src/components/task/MainArea.tsx` when `view === "todos"` and
  `activeTaskId === null`. Visited task terminals remain mounted underneath
  with `display: none` so PTYs never disconnect.
- **Command palette**: Register `"View: Todos"` (`view:todos`) in
  `src/components/dialogs/CommandPalette.tsx`.

### 2. Store and state management (`src/store/todos.ts`, `src/store/forgeLists.ts`)

As built, the state is split in two. `useTodos` holds only the filters
(`selectedProjectIds`, persisted under the scoped `todosProjects` key and
empty for all projects, plus kind, scope and search) and the table
`todoQueries()` that turns them into forge list queries. The lists live in
`useForgeLists`, shared with the New Task dialog's pickers and Review PR's
waiting list, and the view derives its rows from them with `todoRows()`,
naming each row after the project as it is called now.

```typescript
type ForgeListQuery =
  | { projectId: string; kind: "issues"; scope: IssueScope; limit?: number }
  | { projectId: string; kind: "prs"; scope: PrScope; limit?: number };

interface ForgeListEntry {
  query: ForgeListQuery;
  status: "loading" | "ok" | "error" | "unsupported";
  ok: IssueLookup | PrPickList | null; // last ok answer, kept through a failure
  okAt: number;                        // when `ok` was fetched
  fetchedAt: number;                   // when the last fetch finished; the TTL counts from here
  errorMessage?: string;
}
```

#### Cache invariants:
- **Cache key identity**: `projectId + kind + scope + limit`, with a
  missing limit normalized to the IPC's default (50 issues, 30 PRs), so a
  bare call and an explicit default are one query.
- **TTL check on access**: Checked synchronously; no background timers. A
  failure is cached for the TTL like a success; Refresh forces a retry.
- **Stale-while-revalidate**: When refreshing, previous results remain
  visible until the fresh response arrives, and a failed refresh keeps them.
- **Launch snapshot**: the ok answers are written to the scoped
  `forgeListSnapshot` key once the queue drains, under a hard budget of
  256K characters (personal lists first, then repo-wide ones). Bodies are
  cut one past the prompts' 4000-character cap, measured on the text the
  prompts measure (control characters stripped and trimmed, so a CRLF body
  loses its `\r` first) and ending on a non-blank character, so a prompt
  built from a restored row is the same text, truncation note included. Restored entries keep their fetch time,
  so they are stale and re-fetched by the first reader.
- **Isolated updates**: Updating a list writes only to `useForgeLists`.
  `useApp` subscribers are not notified, preventing idle terminal
  re-renders (Bear Trap 8).

### 3. Concurrency and execution bounds

Rather than unbounded `Promise.allSettled` fan-out:
1. **Concurrency limit**: every list fetch, from any caller, routes through
   one bounded work queue (maximum 3 concurrent CLI subprocesses), and a
   query already in flight is joined rather than fetched twice.
2. **Dialog priority**: the New Task and Review PR dialogs' fetches wait at
   the front of the queue, and a dialog joining a list Todos queued first
   moves it there, so an open dialog never waits out a Todos refresh. Todos'
   own requests run in order and are not discarded on a filter change.
3. **Graceful failure decoding**: Existing forge lookups return status
   within the payload (`status: "ok" | "auth_failed" | "cli_missing"`).
   The store parses the response payload directly and flags the entry
   as error or unsupported without treating non-ok results as empty arrays.

### 4. Row actions and task creation flows

#### For Issues: Prefilled `NewTaskDialog`
- Clicking "Start Task" opens `NewTaskDialog` with an extended
  `NewTaskSeed`:
  ```typescript
  interface NewTaskSeed {
    namePrefix?: string;
    baseBranch?: string;
    agent?: string;
    issue?: ForgeIssue; // seeds prompt and derived branch name
  }
  ```
- Ensures the user sees the derived branch, prompt preview, agent pick,
  and sandbox options before creation, matching Termic's safety model.

#### For PRs: `startPrReview()` Coordinator
- Clicking "Review PR" delegates to [`startPrReview()`](src/lib/prReviewTask.ts):
  - Fetches the PR branch using `projectFetchPrBranch()`.
  - Reuses an existing review task if one exists for this branch.
  - Generates the review briefing prompt.
  - Spawns the task cleanly using the standard pending-task coordinator.

### 5. Failure and empty states

The UI distinguishes between different failure and empty conditions:

| State | User-visible presentation |
| :--- | :--- |
| **CLI Missing** | Banner with install instructions (e.g. `brew install gh` / `brew install glab`). |
| **Auth Failed** | Login action button (e.g. `gh auth login`, `glab auth login`). |
| **Unsupported Scope** | Subtle notice: "Provider does not support review-requested queries via CLI". |
| **Network Failure** | Shows previous cached items with a "Stale" indicator and retry button. |
| **No Matches** | Clean empty state: "No items matching filter". |

## Testing plan

1. **Store unit tests (`src/store/todos.test.ts`)**:
   - Query-keyed cache operations and TTL logic.
   - Bounded queue throttling (assert no more than 3 active workers).
   - Race conditions: outdated responses cannot overwrite newer requests.
   - Zero subscriber notifications when selecting unchanged slices.
2. **Component unit tests (`src/components/views/TodosView.test.tsx`)**:
   - Filter pill switching and kind-to-scope compatibility guards.
   - In-memory search filtering over loaded results.
   - Partial failure rendering (one repo errors, others render).
3. **E2E verification (`e2e/specs/todos.e2e.ts`)**:
   - Full flow: open sidebar rail → Todos view → filter toggle → click "Start Task"
   - Confirm terminal PTYs remain mounted and alive in background.

## Documentation and copy checklist

- No em dashes anywhere in user-visible copy. Use commas, colons, or parentheses.
- SEMBR prose formatting in commit notes and review descriptions.
- Add translation keys to `src/locales/en/sidebar.ts` and `src/locales/zh-CN/sidebar.ts`.
