The build and 141 targeted tests pass, but focused reproductions confirm unintended permission-bypass restoration, branch collisions, overlapping fetch pools, and cached-row loss. Filtering and unsupported-state handling also contain user-visible correctness bugs.

Full review comments:

- [P1] Preserve the permission hold while seeded issue text remains — /Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/src/components/dialogs/NewTaskDialog.tsx:702-705
  With a project whose default enables YOLO, open an issue from Todos, select “From an issue”, then switch back to “New branch”. The seed sets `yoloHeld` but leaves `issuePicks` empty, so `exitIssues()` restores YOLO without clearing the external issue prompt. Creating then sends that untrusted text with permission bypass despite no explicit opt-in. Initialize the seeded issue-selection state consistently, or retain the hold until the external text is removed.

- [P2] Apply branch collision handling to seeded issues — /Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/src/components/dialogs/NewTaskDialog.tsx:585-589
  When the issue's derived branch already exists, this seeds the same branch and immediately sets `branchEdited`, preventing the auto-derivation effect from resolving the collision when `projectGitBranches()` finishes. Unlike `fillFromPicks()`, this path never applies `uniqueBranch()`. Starting another task therefore reuses an existing branch or fails if it is already checked out. Resolve seeded-issue collisions after the branch list arrives.

- [P2] Share concurrency accounting across fetch invocations — /Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/src/store/todos.ts:202-204
  Changing scope while a fetch is pending starts another invocation with its own three-worker pool. For one project, switching from “For me” to “All open” already permits five simultaneous requests. Whichever invocation finishes first also sets `isRefreshing` to false while the other still runs, re-enabling Refresh prematurely. Use a shared queue and aggregate loading accounting so filter changes cannot bypass the concurrency bound.

- [P2] Preserve cached rows when a refresh returns an error status — /Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/src/store/todos.ts:262-266
  Forge commands report ordinary network/authentication failures as fulfilled non-`ok` payloads. These become entries with empty `items`, which replace previously successful cache entries; only rejected promises preserve old rows. A failed refresh consequently makes known issues or PRs disappear. Preserve the previous successful items and timestamp for non-`ok` responses in both branches of `executeTask()`.

- [P2] Reconcile the Issues filter with review-requested scope — /Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/src/components/views/TodosView.tsx:105-106
  Selecting “Issues” together with “Review requested” still fetches and renders PRs because this branch ignores `kindFilter`. Both pills remain selected, so the displayed results contradict the active kind filter. Disable incompatible combinations or atomically switch the kind to PRs when review scope is selected, keeping query construction and rendering consistent.

- [P2] Display unsupported-source notices instead of hiding them — /Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/src/components/views/TodosView.tsx:124-125
  The store deliberately classifies unsupported remotes or queries as `unsupported`, but this collection only includes `error` entries. Those sources therefore silently disappear, and an entirely unsupported selection displays “No items found” rather than explaining that it could not be queried. Include unsupported entries in the notice path so unavailable sources are distinguishable from successful empty results.

- [P2] Reset the project filter when its project is removed — /Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/src/components/views/TodosView.tsx:91-93
  After selecting a project, removing it elsewhere, and returning to Todos, `selectedProjectId` still contains the removed ID. The selector displays “All projects” because `activeProject` is null, but both fetching and aggregation continue filtering by the missing ID, leaving the view empty even after Refresh. Normalize an invalid selection back to null when the project list changes.

- [P2] Match issue references containing the displayed number prefix — /Users/vinodkumar.n/code/termic/tasks/termic/tasks-sidebar/src/components/views/TodosView.tsx:148-148
  The search placeholder advertises `#number`, but searching for `#101` cannot match issue 101 because `num` contains only `101`. Copying the displayed issue reference into search therefore hides the matching row unless another field coincidentally contains that reference. Normalize a leading reference marker or compare against the formatted reference as well.