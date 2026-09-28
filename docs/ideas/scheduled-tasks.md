# Future work: scheduled tasks

Not built, not approved. This is the recurrence half of
[GH #300](https://github.com/simion/termic/issues/300). The one-shot half
shipped in 1.5.0 as scheduled queue messages ([ui.md](../ui.md), "Scheduled
queue messages"), and repeating schedules were left for their own design
pass. This file is that pass: what to build and why, written so it can be
argued with before anyone starts.

## The request

Recurring agent runs from inside Termic: a daily dashboard check, a
morning issue triage, a weekly dependency scan. Most of these are not
coding tasks. A plain-folder project with the right MCP servers
configured is enough, and the user picks the agent per schedule.

## Why scheduled messages cannot hold it

A scheduled message is one prompt into one existing chat, sent the next
time that chat is open and idle on or after a date. For a daily job that
is the wrong shape twice over:

- A daily run into the same session grows its context without bound. A
  month of dashboard checks in one transcript is a worse agent on day 30
  than on day 1.
- The promise is "the next time this chat is open", not "at 09:00". A
  recurring check is only useful if it runs near its slot.

## What already exists

The expensive parts are built. A scheduler composes them and reimplements
none of them.

- **The fire path.** `newTaskHandler` in `src/lib/cliRpc.ts` is what
  `termic new` runs: create the task, `markUnattendedSpawn` (which
  composes `UNATTENDED_SPAWN_ARGS` so a startup menu cannot swallow the
  prompt), wait for the PTY, `injectPromptTracked`. It already runs
  without stealing focus.
- **Task groups.** `Task.group` is `{ id, name?, color? }`, where `id` is
  the lead task's id and every member carries a copy
  ([data-model.md](../data-model.md)). Groups collapse
  (`setTaskGroupCollapsed`, stored in `localStorage`), a collapsed group's
  caption carries one of each mark its members' rows would draw
  (`groupBadgeKinds`, so a blocked run shows even when the group is shut),
  and an archived member keeps its tag so a restore finds its group again.
- **Per-task agent config.** `agent_args` (model and extra flags), `yolo`
  and the sandbox fields all live on the task record.
- **Stopping a task.** `stopTask` in `src/store/app.ts` unmounts it, which
  kills its PTYs and drops its scrollback. The record and the agent's
  transcript stay.
- **A place a caged agent can write.** Seatbelt allows `file-write*` on
  the task directory ([sandbox.md](../sandbox.md)), and a main-checkout
  task's directory is the project root, so a report folder inside the
  project is writable in every Seatbelt mode. A folder in Termic's own
  data dir would be denied.
- **Keeping a path out of git without touching `.gitignore`.**
  `ensure_git_excluded` in `src-tauri/src/lib.rs` appends a line to the
  repo's local `.git/info/exclude`, which is never committed. It already
  does this for the agent config links in worktrees.
- **Showing a file in a task.** `openPreviewTab` in `src/store/app.ts`
  opens a file as a tab in a task's view, and `MarkdownPreview` renders
  Markdown deny-by-default (`script`, `iframe`, `style` and the rest never
  reach the DOM).
- **Headless.** `termic new` launches Termic when it is not running, so a
  launchd agent with `StartCalendarInterval` around it already schedules
  runs with the app closed. That stays the answer for the closed-app case.

## Constraints (carried from #300, not open)

1. **No daemon.** A schedule fires only while Termic is running and the
   Mac is awake. Running includes windowless mode: closing the window
   with "Keep in Menu Bar" ([ui.md](../ui.md), "Close vs Quit") keeps the
   app, its agents and this ticker alive, and that is the in-app answer
   for a schedule without a window on screen. Nothing in this feature
   tries to reach past a quit: the launchd route above is the documented
   answer for that.
2. **The UI states the ceiling.** The create dialog says, in one line,
   that runs happen only while Termic is running (a window, or the menu
   bar) and missed runs are skipped.
3. **No `thread::sleep` poll loop in Rust** (performance.md bear trap 9).
   One JS ticker on the `initPrStatusPoller` model in `src/store/pr.ts`:
   started from `App` after `loadAll`, idempotent, one pass immediately
   and then every 60s.
4. **An idle pass writes nothing.** A pass where nothing is due must not
   touch the store (performance.md bear trap 8).
5. **Local time.** The same wall clock scheduled messages use
   (`localDateValue` in `src/lib/scheduledQueue.ts`).

## Decided

### A schedule is a parent task

Creating a schedule creates a parent task in the chosen project, and the
parent leads the group its runs join. "Schedule..." on an existing task's
context menu does the same with that task as the parent.

The parent is the template. Every run copies the parent's agent,
`agent_args`, `yolo` and sandbox settings, passed explicitly at create.
Explicitly is the point: `task_open_repo` and the other create paths take
no fallback for YOLO or the sandbox (the CLI passes nothing and must get
nothing), and a task created through the CLI or MCP does not inherit
either from the task that spawned it today. The scheduler runs in the
frontend and reads the parent's record, so inheriting is one line, but it
is a new rule and belongs in the docs when it ships.

The parent's own agent tab is where the user talks about the runs ("what
changed across the last seven?"). Creating a schedule does not start that
agent: the parent is created unmounted, like any task nobody has clicked,
and its agent starts when the user opens it. A schedule costs nothing
between runs.

**The schedule lives on the parent's task record**, as `Task.schedule`,
the same way a scheduled message lives on its tab record. That buys the
lifecycle for free: it rides the task file, it is profile-scoped because
tasks are, an archived parent is skipped by the ticker (the schedule is
paused), and a restore brings it back with every setting intact. Deleting
the parent deletes the schedule. The alternative, a separate
`schedules.json`, needs its own answer to each of those.

### Each run is a new task in the parent's group

- **Main checkout, never a worktree**, whatever the parent is. A worktree
  per run cuts a branch, costs disk and reruns the setup script every
  time, and a plain-folder project has no worktree mode at all. Several
  main-checkout tasks on one project are already allowed (no guard in
  `task_open_repo`).
- **Named for its slot**, e.g. `grafana-check 2026-09-28 09:00`. Task
  names must be unique among a project's live tasks (`createTask` in
  `cliRpc.ts` refuses a duplicate), so a fixed name would fail on day two.
- **Joins the parent's group**, which the schedule sets collapsed when it
  creates it. Clicking a run expands the group, which is existing
  behaviour.
- **Shares a directory** with the parent and every other run: the live
  checkout. That is what makes the report folder below work (every run
  can read the reports before it), and it is why each run writes to its
  own dated file instead of a fixed name.

### A run stops when it is done, and old runs are archived

Collapsing a group hides its runs and frees nothing. A mounted task keeps
its agent process, its scrollback and its React tree
([performance.md](../performance.md) 2b), so a month of a collapsed daily
schedule would still be 30 idle agents.

- A run that settles **done** is stopped with `stopTask`. A run that ends
  in **needs input** stays live and marks attention, because stopping it
  would throw away the question it is waiting on.
- Runs past the last N (default 7) are archived. Archived runs keep their
  group tag, so History lists them and a restore lands back in the group.
- **Archiving a run must skip the project's archive script.**
  `task_archive` runs it for main-checkout tasks too (the "Single-repo
  tasks: host's project archive_script fires" block in
  `src-tauri/src/lib.rs`), so auto-archiving a daily run would run, say,
  `npm run cleanup` in the user's live checkout every morning. It needs a
  `skip_scripts` argument, set only by the scheduler. A run never ran a
  setup script, so it has nothing to tear down.

### Overlap is skipped

If the previous run of a schedule is still working, or still waiting on
input, when the next slot comes due, the slot is skipped and recorded as
skipped. No second concurrent run, no queue.

### Missed runs stay missed

This is the opposite of scheduled messages, on purpose. A one-shot has no
next occurrence, so delivering late beats dropping it. A recurring check
does: tomorrow's 09:00 run replaces today's missed one, and a daily check
that fires at launch three days late and then again at 09:00 is noise.

- **A grace window decides what "missed" means.** The ticker runs once a
  minute and no timer runs while the Mac sleeps, so a Mac that wakes at
  09:03 must still get its 09:00 run. A slot the ticker first sees within
  the window (15 minutes) fires; later than that, it is missed. The
  window trades a Mac that woke late against a 09:00 check arriving at
  09:14, and 15 minutes is where that lands.
- **A skip is shown**, as "Missed 09:00" in the schedule's history. A
  silent skip looks like a broken schedule. Several missed slots in a row
  show as one entry ("Missed 3 runs").
- **Catch-up is opt-in, per schedule.** "Run once at launch if missed"
  fires one run, however many slots passed.

### Presets, not cron

v1 offers daily at a time, weekdays at a time, and weekly on a day at a
time. Cron is out: it needs a parser dependency and a syntax to validate
and explain, for cadences almost nobody needs.

The record stores the last slot it acted on (`last_slot`), and a pass acts
only on a slot later than that. That is the whole DST story: the repeated
hour when clocks go back cannot fire twice, and the hour that does not
exist when they go forward is rolled forward by `Date`, with no special
code.

### Where it lives

- A **Scheduled** entry in the sidebar's primary nav, under Dashboard and
  History (`Sidebar.tsx`). The view lists every schedule: name, project,
  cadence, next run, the last run's outcome and report (below), an
  enabled toggle, Run now, edit and delete.
- A create dialog: project, name, agent and model, the prompt (typed, or a
  prompt-library entry, like `termic new --prompt`), cadence, YOLO and
  the Seatbelt sandbox (seeded from the project the way New Task seeds
  them; no Docker, see below), the catch-up toggle, N, and how long to
  keep reports.
- "Schedule..." in a task's context menu, which opens the same dialog
  with that task as the parent.

### A run's result is a report file the agent writes

Not the agent's last message. `termic result` reads that from the
session transcript and only knows claude's; codex and gemini get an
error. A file is the same for every agent, so it is the only result that
keeps "pick the agent per schedule" true.

- **Where.** `.termic/schedules/<slug>/<YYYY-MM-DD_HHMM>.md` in the
  project, one folder per schedule. `slug` is fixed when the schedule is
  created, so renaming a schedule does not strand its reports.
- **How the agent knows.** Termic appends one fixed instruction to every
  run's prompt, naming the exact file to write and saying that earlier
  reports are in the same folder. It goes in the prompt, not an env var:
  an env var is only read by an agent that goes looking
  ([agent-orchestration.md](agent-orchestration.md), "Env vars are
  passive").
- **Memory across runs, without one long session.** Each run is a fresh
  session, and yesterday's report sits next to today's file, so "compare
  with the last run" is a prompt the user can write and the agent can
  act on.
- **Out of git.** Creating a schedule adds `.termic/schedules/` to the
  repo's `.git/info/exclude` through `ensure_git_excluded`, so reports
  never show up as untracked changes and never reach a commit. A
  plain-folder project needs nothing.
- **Markdown renders in Termic; HTML opens in the browser.** Opening a run
  opens its report as a tab in that run's task view (`openPreviewTab`), in
  front of the agent tab, and a `.md` report renders in `MarkdownPreview`.
  The agent may write `.html` instead when the report needs charts or
  layout Markdown cannot hold. That one opens in the browser the way a
  preview URL does, never in Termic's webview: the webview is outside the
  sandbox ([sandbox.md](../sandbox.md), "Known gap: the webview is outside
  the cage"), so agent-written HTML there would be agent-written script
  running next to the IPC bridge, and the CSP is not to be widened for it.
- **It also says whether the run worked.** A run that settles done with
  its report written is `fired`. One that settles done without writing it
  is `no_report`, which is the failure the settle heuristic alone cannot
  see: the agent stopped, but it did not do the job.
- **In the Scheduled view**, the last run's column shows the report's
  first heading (or its `<title>`), linked to the file.
- **Kept 30 days, then cleaned up automatically.** Each schedule has its
  own retention, set in its dialog: 7, 30 or 90 days, or forever, with 30
  as the default. The rules for the cleanup, since it deletes files in
  the user's project:
  - It deletes only files named like a report
    (`YYYY-MM-DD_HHMM.md` or `.html`) directly inside that schedule's
    own folder. Anything else there, whether the agent or the user put
    it there, is never touched, and neither is anything outside the
    folder or reached through a symlink.
  - Age comes from the date in the file name, not the file's modified
    time, so editing an old report does not reset its clock.
  - It runs after each run ends and once at launch. A disabled schedule
    is still cleaned up at launch, so its reports age out too.
  - A history entry whose report has been cleaned up says so, instead
    of linking to a missing file.
- **Deleting a schedule** asks whether to delete its reports too, and
  the answer defaults to keeping them. A kept folder is no longer cleaned
  up, because the schedule that owned it is gone, so the dialog says
  that.

### A finished run sends a notification

The scheduler rings once per run, with a message that says what
happened: "grafana-check: report ready", "grafana-check finished without
a report", or "grafana-check needs input". The generic done notification
for a run's tab is suppressed, so a run does not ring twice. A missed or
skipped slot never rings: it goes in the history, and a morning of "you
missed 3 runs" banners after a weekend is noise.

It goes through the same OS notification path and the same Settings
switch as every other notification (`desktopNotifications` in
`useAttentionNotifier`, off by default). One switch for all OS
notifications is the existing contract, so the create dialog does not
override it. When the switch is off, the dialog says so and links to it.
The unread mark on the run and its group appears either way.

### Local runs only in v1

A schedule's runs run on the host, bare or in the Seatbelt cage. Docker
is out of v1: "Schedule..." is disabled on a Docker task, with a tooltip
saying why, and the dialog does not offer it. A Docker parent's runs never
fall back to running locally. That would quietly take away the container
the user chose, which is worse than refusing.

Why out: several containers on one live checkout, one per run, is
untested, and Docker has its own rules for where an agent's files live
([gotchas.md](../gotchas.md), "Docker is a SECOND REALM"). The report
folder is inside the mounted checkout, so it probably works, but
"probably" is not a v1 rule. Adding Docker later means measuring both
first.

## Shape

### Data

`Task.schedule` (optional, absent on every task that is not a parent, so
existing task files are unchanged):

- `enabled`, `name`
- `slug` (the report folder's name, fixed at creation)
- `prompt` (text) or `prompt_id` (a prompt-library entry)
- `cadence`: `{ kind: "daily" | "weekdays" | "weekly", time: "HH:MM",
  weekday? }`
- `catch_up`, `keep_runs`
- `report_days`: 7, 30 or 90, or `null` for forever. Set to 30 when the
  schedule is created, so `null` always means the user chose forever
- `last_slot` (epoch ms)
- `history`: the last 30 entries of `{ slot, outcome: "fired" |
  "no_report" | "needs_input" | "missed" | "skipped" | "failed",
  run_task_id?, report? }`, where `report` is the file's path relative
  to the project

Runs need no new field: they carry the parent's group tag and
`spawned_by`, and `history` holds their ids.

### Rust

- `task_set_schedule { id, schedule | null }` overwrites the field. An
  unchanged value writes nothing. The frontend always sends the whole
  record, like `task_set_tab_scheduled`.
- The field must survive every other writer of the task file
  (`task_set_yolo`, rename, group joins): a `serde(default)` field on
  `Task` that every load-modify-save carries forward, with a cargo test
  pinning that.
- `task_archive` gains `skip_scripts: Option<bool>`.
- The first `task_set_schedule` for a project creates
  `.termic/schedules/<slug>/` and writes the exclude line. The line has
  to be relative to the repo root, and `ensure_git_excluded` looks for
  `.git` under the path it is handed, so a project that is a
  subdirectory of its repo ([data-model.md](../data-model.md): a project
  need not be the repo root) resolves the root first.
- `schedule_prune_reports { project_id, slug, older_than_days }` does the
  cleanup, async like every IO command. The rules above live in Rust, not
  in the caller: canonicalize the folder, refuse it if it resolves
  outside `<project>/.termic/schedules/`, match file names against the
  report pattern, never follow a symlink. It returns what it deleted, for
  the history.

### Ticker

`initScheduleTicker()`, next to the other pollers. For each live parent
with an enabled schedule, a pass computes the latest slot at or before
now. If that slot is later than `last_slot`, the pass fires it (within the
grace window, and no run still active), skips it (overlap), marks it
missed, or catches up once (if opted in and outside the window), then
writes `last_slot` and one history entry. Schedules due in the same
minute fire one after another; `withCreateLock` in `cliRpc.ts` already
serializes creates.

A separate watcher handles a run's end. On done: check for the report
file, record `fired` or `no_report`, send the one notification, stop the
run, then archive anything past `keep_runs`. On needs input: record it,
notify, and leave the run live.

### Tests

- vitest: slot math for all three cadences, both DST days, the grace
  window, `last_slot` monotonicity, the fire / skip / missed / catch-up
  decision, and an idle pass that writes nothing. The prompt suffix names
  the exact report path; the outcome is `fired` with the file and
  `no_report` without it; a run rings once, with the right message.
- cargo: `task_set_schedule` round-trip, other writers carrying the
  field, `skip_scripts`, the report folder and the exclude line
  (including a project below its repo root). `schedule_prune_reports`:
  deletes an old report and keeps a new one; ages by file name, not
  mtime; leaves a non-report file, a subfolder and a symlink alone; and
  refuses a slug that climbs out of the folder (`../`).
- e2e (the `e2e` skill): create a schedule and see the parent and its
  collapsed group; Run now and see a run join the group; the run stopped
  once done, with its report open as a tab when the run is opened;
  `keep_runs` archiving; disable; archiving the parent pauses it and a
  restore resumes it; "Schedule..." disabled on a Docker task. A spec
  cannot wait for 09:00, so the ticker takes an injectable clock, or the
  spec drives Run now plus one pass. A spec also cannot make a real
  agent write a report on demand, so it drives a shell agent that
  writes one.
- i18n: en and zh-CN, through the parity test.

### Docs, when it ships

`data-model.md` (`Task.schedule`, the inheritance rule, the report
folder, its exclude line and retention), `ipc.md` (`task_set_schedule`,
`skip_scripts`, `schedule_prune_reports`), `ui.md` (the Scheduled view,
the ticker rules, the notification), `e2e-coverage.md`. Delete this file
in the same commit.

### Cost

A few days, tests and docs included, for everything above. The report
file and the notification are what grew it past the first estimate,
roughly half a day between them. Cron and Docker runs would each be
separate work.

## Open questions

None left. Every question raised while writing this up has an answer
above. What is missing is the maintainer's decision to build it.
