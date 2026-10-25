The proposal fits Termic’s main-area navigation model, but **I would revise it before implementation**. The dedicated store, on-demand queries, and preserved terminal mounts are sound choices. The largest gaps are scope semantics, cache identity, unbounded subprocess fan-out, and task-creation flows that do not yet match the existing primitives.

This is a static review of the document and current code. I made no changes and ran no tests.

**1. Performance and React rendering discipline**

**High priority: the cache needs to represent queries, not the entire view.**

The proposed `items`, `loading`, and `lastFetchedAt` describe one dataset, while project, kind, and scope can select several different datasets. ([Design](/Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/docs/ideas/todos-view.md:140))

For example:

1. Fetch assigned issues.
2. Switch to review requests within two minutes.
3. A global TTL suppresses fetching, leaving the review view with incomplete or incorrect data.

Fetching everything initially would avoid that particular failure, but would substantially increase subprocesses, payload sizes, and rate-limit exposure.

Use cache entries for individual upstream queries, identified by:

```text
repository identity + kind + upstream scope + page/cursor + limit
```

Include an authentication/configuration generation where needed to invalidate answers after login, account changes, or remote changes. Each entry needs its own data, status, successful-fetch timestamp, error, and request generation.

Recommended behavior:

- A cache hit returns without a Zustand write.
- TTL is checked on access, with no expiration timer.
- Refresh retains the previous successful rows while fetching.
- A failed refresh preserves those rows and marks them stale.
- Failed attempts do not update the successful-fetch timestamp.
- Cache entries are bounded and removed lazily when projects disappear or entries are evicted.

**The separate store avoids the worst bear-trap-8 failure, but does not guarantee efficient rendering.**

A `todos.ts` update does not inherently notify `useApp` subscribers. That isolation is valuable. Also, a finite, user-triggered fetch is not itself an idle CPU leak.

The risks arise from implementation choices:

- Selecting the entire Todos store in the table.
- Returning fresh arrays from Zustand selectors, such as `s => s.items.filter(...)`.
- Running a fetch effect against an unstable query object or whole-store dependency.
- Writing unchanged filter values repeatedly.
- Replacing every item object after an identical refresh.
- Adding per-row relative-time timers or a permanently animated loading indicator.

Specify narrow subscriptions, stable empty constants, and equality guards. Select stable source data and derive filtered rows with `useMemo`, or use a selector that caches its result. Preserve item references when content is unchanged so memoized rows can skip unrelated updates. These directly follow [bear traps 5 and 8](/Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/docs/performance.md:10).

For local search, start with a memoized filter over bounded results. Debouncing is optional, not a requirement. It must never trigger forge requests. Relative timestamps can be computed at mount or refresh, with an absolute timestamp available in a tooltip.

**High priority: `Promise.allSettled` is failure isolation, not throttling.**

The proposed strategy starts every supplied operation immediately. Ten projects fetching issues and PRs can produce twenty simultaneous CLI processes, plus discovery work. ([Design](/Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/docs/ideas/todos-view.md:170))

Use a bounded work queue from the first implementation:

- Start with a small configurable implementation constant, perhaps **three concurrent list jobs**, then measure.
- Fetch only the selected project when one is selected.
- Fetch only kinds and scopes required by the current view.
- Deduplicate identical in-flight queries.
- Prioritize current-view work over obsolete queued work.
- Publish results per completed query, rather than per item or only after the slowest project finishes.
- Prevent repeated Refresh clicks from creating overlapping request waves.

Account for existing PR-status polling when choosing the budget. Termic already has a [bounded background poller](/Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/src/store/pr.ts:388); Todos should not expand its scope.

**Unmounting Todos does not cancel its subprocesses.**

The existing forge runner ends with `cmd.output()` and has no application-level deadline in that helper. A hung CLI can therefore occupy a worker and leave an aggregate request unresolved. ([Runner](/Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/src-tauri/src/forge.rs:226))

Specify backend execution deadlines and cleanup. Ignoring a stale promise, or applying a JavaScript timeout, does not terminate the underlying child process.

Finally, replace the assertion that `spawn_blocking` guarantees 60fps. It protects the IPC/event-loop path from blocking Rust IO; it does not bound JSON decoding, normalization, sorting, React work, or DOM layout. ([Performance claim](/Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/docs/ideas/todos-view.md:227))

**2. Architecture and alignment with existing primitives**

**High priority: the advertised scope model exceeds the current API.**

The default workflow says “Assigned to me” includes assigned issues and review requests, but these are different relationships. The document also promises assigned PRs and created-by-me issues, which the current scope enums do not implement.

| UI scope | Current issue support | Current PR support | Required decision |
|---|---|---|---|
| Assigned to me | `assigned` | No assigned scope | Restrict to issues or add backend support |
| Review requested | Not applicable | `review`, GitHub/GitLab | Handle Azure as unsupported |
| Created by me | No authored scope | `mine`, meaning authored | Add issue support or narrow the UI |
| All open | `all` | `open` | Define limits and completeness |
| Mentioned | GitHub issues only | No corresponding scope | Remove from v1 or specify it fully |

The Rust parsers silently default unknown issue scopes to `All`, and unknown PR scopes to `Mine`. An accidental shared-scope mapping can therefore return plausible but wrong results. Use an explicit, typed translation layer. ([Issue scopes](/Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/src-tauri/src/forge.rs:1690), [PR scopes](/Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/src-tauri/src/forge.rs:1819))

A practical default is **“For me” = assigned issues ∪ review-requested PRs**, with that union stated explicitly. If authored PRs belong there too, name that decision.

**`action` cannot accurately represent user relationships.**

An item can be assigned, authored, and mentioned simultaneously. Moreover, current list payloads do not include enough relationship metadata to reconstruct these facts from an “all open” response.

Use query membership to establish why an item appears. If badges are needed, allow multiple reasons and distinguish “unknown” from “false.” Do not infer “assigned” from authorship or from whichever filter happens to be selected.

**Preserve existing forge payloads instead of flattening away useful fields.**

`TodoItem` drops issue `comments` and query-level `remote_url`. Both matter to issue prompt construction, particularly Azure’s explicit project/org commands. Its PR fields are optional even when `kind === "pr"`, permitting invalid states.

Prefer a discriminated union retaining `ForgeIssue` or `ForgePr`, alongside repository/project routing metadata. Store `remote_url` and provider information with the query/source metadata. Read project display names from current project metadata rather than duplicating them permanently in every cached item.

**Use the existing review coordinator.**

The proposed sequence fetches through `projectFetchPrBranch()`, then describes `fetchPrForReview()` as launching the worktree. That helper actually performs another lookup and branch fetch; it does not create a task. ([Proposed actions](/Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/docs/ideas/todos-view.md:204), [Helper](/Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/src/lib/prReview.ts:98))

The relevant coordinator is [`startPrReview()`](/Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/src/lib/prReviewTask.ts:58). It already handles review prompt composition, existing-task reuse, checkout choice, creation, prompt delivery, and grouping.

Extend `ReviewPrDialog` with a typed seed for the selected project and PR. Reuse that workflow instead of assembling a second review pipeline.

**Rust batch command or TypeScript orchestration?**

My recommendation is **bounded TypeScript orchestration for the first single-repository version**, with Rust retaining provider-specific execution, deadlines, and error classification.

That gives straightforward caching, query prioritization, progressive results, and stale-response handling while reusing current IPC commands.

Do not make “10+ projects” the architectural threshold for Rust batching:

- Concurrency must already be bounded below that threshold.
- One IPC call does not inherently reduce subprocess count.
- Existing per-project commands repeatedly load project records and resolve remotes. A batch can reduce that repeated work.
- A process-wide concurrency limit across profile windows requires Rust coordination.

If adding a Rust batch, make it accept explicit query descriptors and return **per-query results**. A single `ForgeScope` and top-level `Result` are insufficient for mixed issue/PR semantics and partial failures. Resolve project records once, reuse existing forge functions, and avoid holding locks across subprocess execution.

**3. UX and interaction details**

**Define valid filter combinations and their transitions.**

At present, `Issues + Review requested` has no meaningful interpretation. Specify one consistent rule: disable incompatible scopes with an explanation, or atomically switch the kind when selecting a scope that requires it.

Also specify:

- Whether filters persist across navigation and application restarts.
- Whether project selection survives changing kind or scope.
- How a removed selected project falls back.
- What Refresh refreshes: preferably the current query selection.
- Whether search matches all loaded projects or only the selected project.
- A visible reset action and result count.

Persist small preferences per profile if desired; keep fetched data in memory.

`BoardFilterBar` is not merely a styled search box. It incorporates task-specific query parsing, qualifiers, completion, and counts. Reuse its visual primitives or extract a neutral input, rather than inheriting task-filter behavior accidentally. ([Component](/Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/src/components/views/BoardFilterBar.tsx:1))

**Choose one task-creation interaction before implementation.**

“Creates immediately” and “opens NewTaskDialog” are materially different flows.

For issues, I recommend a prefilled New Task dialog first. The existing dialog provides branch collision handling, prompt preview, agent selection, sandbox configuration, and an explicit YOLO step-back for external issue text. ([Issue seeding](/Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/src/components/dialogs/NewTaskDialog.tsx:1232))

`createQuickTask()` currently accepts neither an initial prompt nor the issue-source semantics, and applies normal project YOLO defaults. Calling it directly would not preserve the current issue workflow. ([Quick creation](/Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/src/lib/quickTask.ts:156))

Extend `NewTaskSeed` with an explicit issue source. Its current shape does not carry a selected issue or exact issue branch. Preserve:

- `uniqueBranch(issueBranch(issue, branchPrefix), existingBranches)`.
- `buildIssuesPrompt([issue], MAX_PROMPT_CHARS, remoteUrl)`.
- External-text handling and prompt readiness behavior.

For both issue and review creation, define cancellation, repeated clicks, partial failure, and return navigation. Once creation starts, follow the existing [pending-task flow](/Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/docs/ipc.md:251). Keep progress and failures scoped to that operation.

**Failure UX needs more than `errorByProject: string`.**

Existing lookup commands return ordinary failures as fulfilled payloads with a non-`ok` `status`. Handling only rejected `allSettled` results would silently turn authentication failures into empty lists. ([Existing response handling](/Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/src-tauri/src/lib.rs:14660))

Track failures per repository/kind/scope, since issues can succeed while PRs fail.

| State | Expected presentation |
|---|---|
| CLI missing | Provider-specific installation hint, including Azure’s extension |
| Unauthenticated | Host-aware login guidance and explicit retry |
| Unsupported scope | “Unavailable for this provider,” separate from zero matches |
| No/unsupported remote | Explain excluded repositories |
| Network failure | Preserve cached rows and show stale status |
| Rate limited | Explain cooldown and suppress request storms |
| Successful empty query | Genuine no-results state |
| Partial success | Show results plus loaded/failed/skipped source counts |

Azure reviews currently return an empty list, and GitLab review queries can fall back to empty on unsupported scope responses. An inbox must distinguish those capability limitations from “nothing needs your review.” ([Provider behavior](/Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/src-tauri/src/forge.rs:1902))

**4. Edge cases and missing contracts**

**Repository identity needs to be separate from project identity.**

`${projectId}:${kind}:${number}` distinguishes rows across projects, but duplicates the same remote item when multiple configured projects reference one repository.

Use a source identity containing provider, host, full repository namespace, and item kind/number. Keep project associations separately for filtering and task creation.

This matters for:

- Multiple clones or worktrees of one repository.
- Identical repository names on different enterprise hosts.
- Nested GitLab namespaces.
- A repository included in multiple multi-repo projects.
- Separate CLI identities or authentication contexts.

**Monorepos and multi-repo projects need different policies.**

For a monorepo, items normally belong to the whole repository. A package/subdirectory cannot be inferred reliably from issue text. State that explicitly.

Multi-repo projects are a larger gap: members are identified by `root_path` and need not exist as standalone projects. Current project forge commands resolve only the project root, and the New Task issue picker deliberately excludes multi-repo projects. ([Member model](/Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/src/lib/types.ts:234), [Dialog gating](/Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/src/components/dialogs/NewTaskDialog.tsx:705))

Choose either:

- **V1:** single-repository projects only, with an explicit limitation.
- **Expanded scope:** enumerate member repositories and add backend addressing through project ID plus member identity. Define which member receives the checkout, prompt, and task configuration.

Azure work items require additional care: the existing query is **Azure project-scoped**, not repository-scoped. Several repositories in one Azure project can return identical work items. Deduplicate them by org/work-item identity and require an explicit task target.

**Pagination and completeness are currently unspecified.**

Current commands default to 50 issues and 30 PRs, with different maximum limits. GitLab list implementations request a single page. These picker-oriented limits cannot silently become an exhaustive inbox contract. ([IPC limits](/Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/src-tauri/src/lib.rs:14739))

For v1, a bounded snapshot with “Showing up to N per repository” and browser links is reasonable. Otherwise, add provider-specific continuation metadata and explicit Load more behavior.

Crucially, **Azure’s current issue limit does not bound network work**: `az boards query` hydrates every matching work item before the parser takes the requested number. Cross-project “All open” should address that backend path first, using the bounded WIQL/invoke approach already documented in the code. ([Azure limitation](/Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/src-tauri/src/forge.rs:2190))

Search must say it searches loaded results. Sorting loaded rows by update time cannot recover recently updated items excluded by an upstream creation-time limit. Azure PR `updated_at` currently falls back to creation time for open PRs, so the “Updated” column also needs an honest fallback label.

**Race handling must be explicit.**

Specify these invariants:

- A response updates only its captured query key.
- A superseded request cannot overwrite newer data for the same key.
- An old request’s `finally` cannot clear a newer request’s loading state.
- Switching scope or project drops obsolete queued jobs.
- Unmounting does not trigger navigation or task creation on late completion.
- Removed projects and changed remotes invalidate affected results.
- Read-query cancellation is distinct from an already-started task mutation.

For PR actions, define behavior when the PR closes, its source branch disappears, or its head changes after listing. Azure fork PRs are currently refused by the fetch command. Existing local review branches can also be reused without refetching, so “Review Task” must not promise the latest head without resolving that policy. ([Fetch behavior](/Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/src-tauri/src/lib.rs:14783))

**5. Concrete changes to make before implementation**

I would add these implementation contracts to the document:

1. **Scope/capability matrix:** exact default inbox membership, valid filter combinations, provider support, and unsupported-state behavior.
2. **Query/cache contract:** per-query entries, in-flight deduplication, TTL semantics, stale-data retention, invalidation, and bounded memory.
3. **Execution contract:** bounded concurrency, subprocess deadlines, refresh coalescing, and cancellation behavior.
4. **Source/target identity:** repository identity, project associations, multi-repo policy, Azure work-item scope, and task destination.
5. **Action contract:** typed issue/review dialog seeds, shared coordinators, prompt handling, duplicate-click protection, and pending-task transitions.
6. **Completeness contract:** explicit limits, ordering, loaded-only search, and pagination or browser escape hatches.

Expand the test plan with machine-independent invariants:

- Identical setters and fresh-cache reads notify zero subscribers.
- Todo search/results do not write to `useApp`.
- PTY output/title updates do not invalidate Todo rows.
- Concurrent requests for one key produce one upstream query.
- Active jobs never exceed the configured limit.
- Out-of-order responses cannot replace newer results.
- Fulfilled non-`ok` payloads produce failures, not empty-success states.
- Unmount leaves no Todos timers/listeners and prevents queued work from starting.
- Navigation preserves terminal mounts and PTYs, including pending-task transitions.
- Creation failure remains recoverable without blocking other tasks.

Keep timing/CPU measurements local or ungated, as [the performance rules require](/Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/docs/performance.md:55). Terminal flicker and focus behavior still need human verification.

Finally, correct a few smaller spec inaccuracies:

- `--color-border-subtle` is not currently defined; use an existing token.
- Use `prRef()` for provider-specific PR numbering.
- PR payloads currently have no labels, so label search coverage differs by kind.
- Localize the view and palette as well as sidebar navigation.
- The document’s SEMBR checklist conflicts with `CLAUDE.md`: repository documentation stays wrapped to approximately 72–78 columns.