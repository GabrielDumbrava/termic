# Future work: scheduled prompts

Not built, not approved. Filed by a user as
[GH #300](https://github.com/simion/termic/issues/300); this file is the
write-up of what shipping it would actually cost, not a decision to ship it.

## The request

> I implement a feature or fix and would like to schedule a task a week out
> for CC to automatically look at logs related to the release. It seems that
> currently the queuing method doesn't allow for custom delays; perhaps it
> would be nice to add a CRON option to the queued message tab?

Two distinct features are bundled there, and they have very different
costs: a **one-shot delay** ("deliver this prompt in a week") and a
**recurrence** ("deliver this prompt every Monday"). The rest of this
document treats them separately, because the first is a day of work and
the second is a design argument.

## The message queue is the wrong home for it

The suggested placement, a cron field on the message queue, would be built
on sand. The queue is runtime-only state:

- `queue?: QueueItem[]` lives on the in-memory tab (`src/lib/types.ts`),
  alongside `queueActive` / `queueKick` / `queueForceKick`.
- It is never written to `persisted_tabs`. `persisted_tabs` is agent-tabs
  only by construction, and none of the queue fields are in it.
- It is keyed to a live PTY and drained by `TerminalPane` on each
  work-done. `queueActive` is deliberately reset on PTY respawn.

So the queue dies with the app, and it only advances while an agent is
running and emitting work-done. Every one of those properties is wrong for
a schedule measured in days: the app will have been quit, the Mac will have
slept, and the target task will very likely have no agent running at all.

A schedule is a **task-scoped, persisted** record that happens to deliver a
prompt. It is not a queue entry with a timestamp.

## What already exists (the expensive half is done)

The genuinely hard part of this feature is not the clock. It is "the agent
is not running, so restore its session, wait for the PTY, deliver the
prompt, and report whether delivery landed". That path is built, shipped
and exercised by the CLI:

- `termic send --resume` / `--fresh` (`termic-cli/src/lib.rs`) is the
  user-facing surface.
- `sendPromptHandler` in `src/lib/cliRpc.ts` is the implementation. It
  covers all three shapes: a live agent tab, an exited tab (programmatic
  Restart via a `respawnKick` bump), and a task with no agent tabs at all
  (`markUnattendedSpawn` + `mountTasks` + `ensureDefaultTab`).
- `waitForAgentPty` then `injectPromptTracked` handle the spawn wait and
  the tracked delivery; failures surface through `cli_prompt_report`, and
  `failCliQueuedPromptsInTabs` fails queued prompts fast when a task is
  stopped out from under them.
- The pair a background fire needs is already the default there:
  `unattended: true` composes the CLI's `UNATTENDED_SPAWN_ARGS` so a
  startup update menu cannot swallow the injected prompt, and `focus:
  false` stops the spawn from yanking the keyboard out from under whoever
  is typing.

A scheduler does not reimplement any of that. It calls it.

## Constraints (not open questions)

1. **No daemon.** The app is entirely on-device and adding a background
   service is out (see CLAUDE.md). A schedule fires only while termic is
   running, and that is the design, not a limitation to be worked around
   later. **Headless scheduling is the CLI's job**: a user who needs a
   prompt delivered with the app closed writes a launchd agent around
   `termic send`, and that is a documentation answer, not a missing
   feature. Nothing in this feature should try to close that gap.
2. **The UI must not lie about that ceiling.** If the picker says "in 1
   week" and the app is closed on that day, the user has to already know
   what happens. This is a copy problem as much as a code one.
3. **No `thread::sleep` poll loop in Rust.** A banned pattern; it burns
   wakeups and keeps the CPU out of deep sleep.
4. **One global JS ticker, on the `src/store/pr.ts` model.** A singleton
   started from `App` after `loadAll` resolves, idempotent, one pass
   immediately and then on an interval. `initPrStatusPoller` and the
   updater's hourly probe in `src/store/update.ts` are both precedents. A
   pass with nothing due must write nothing to the store: an unchanged
   value through a setter re-runs every mounted task's selectors.
5. **Profile-scoped storage.** Schedules belong under `profile_dir(id)`,
   not `global_dir()`, like `tasks/` and `settings.json`. A schedule
   targets a task, and tasks are profile-scoped.

## Decided: a fire that came due while the app was closed

**It fires on next launch, as soon as the app comes up.** A week-out
schedule is more likely than not to come due while termic is closed, so
this is the case that decides whether the feature is useful at all, and a
late delivery beats a dropped one: for the stated use case, reading the
release logs three days later is still worth doing. Dropping it silently
is the worst available answer, and asking on launch puts a decision in
front of someone who just wanted their app open.

The delay should be visible where the prompt lands, so a late fire reads
as late rather than as the app having sat on it.

One consequence to build for rather than rediscover: if several schedules
came due while the app was closed, launch fires all of them, and each one
can spawn an agent. A cold start that opens five agents at once is a bad
morning. The fire pass needs a cap, or staggering, or both, and that is an
implementation detail of this decision, not a reopening of it.

## The open design questions

These are the reason this is an idea and not a plan. None of them is
answered by picking a library.

### 1. The target task no longer exists

Archived, deleted, or its worktree removed by hand. Archiving is
recoverable and a scheduled prompt about a release is plausibly still
wanted after one, so "silently drop on archive" is probably wrong, but
"restore the task to deliver" is certainly wrong. Most likely answer: keep
the schedule, skip the fire, surface it.

### 2. Where a pending schedule is visible and cancellable

A schedule that fires in a week and cannot be found in the meantime is a
trap. It needs a list surface. Candidates: the task menu, a sidebar
affordance, or a Settings section. This is the bulk of the UI work, and
the part the request does not mention at all.

### 3. Recurrence semantics (if cron is in scope at all)

- What happens when a run is still working and the next one comes due?
  Skip, queue, or run concurrently in a second tab?
- Does a recurring schedule deliver into the same session (context grows
  without bound) or a fresh one each time (no memory of the last run)?
- Cron needs a parser dependency and a timezone answer, including DST.

## Shape of a plausible v1

One-shot only. Explicitly cut recurrence.

- A persisted record: id, task id, optional tab selector, prompt text,
  `fire_at` (absolute, resolved from a relative picker at creation), the
  `resume` / `fresh` choice, and a created-at. Stored profile-scoped, with
  Rust CRUD commands.
- A single ticker as described above; a due pass calls the existing
  `sendPromptHandler` path, which already spawns unattended and unfocused.
- A catch-up pass on launch, firing everything that came due while the app
  was closed, capped or staggered so a cold start cannot open five agents
  at once.
- A creation surface offering relative presets (in 1 hour / tomorrow / in
  a week) plus an absolute date, with one line of copy stating the "only
  while termic is running" ceiling and pointing at the CLI for headless.
- A list surface showing pending schedules with a cancel affordance.
- Docs: `data-model.md` gets the new entity, `ipc.md` gets the commands,
  and an e2e spec covers create, fire, cancel, and the catch-up pass.

Rough cost: about a day for the one-shot feature. The recurrence variant
is a separate piece of work with its own design pass, not a flag on this
one.

## Headless is the CLI's job

Not a workaround, the answer. A user who needs a prompt delivered with the
app closed writes a launchd agent (or `at`) around:

    open -a Termic && "$TERMIC_CLI" send my-task --resume -p "check the release logs for ..."

which starts the agent if it is not running and delivers the prompt. The
in-app feature is for discoverability, not capability: it saves writing a
plist, and it deliberately does not try to reach further than the running
app.
