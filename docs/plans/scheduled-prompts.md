# Plan: scheduled messages in the queue

Approved 2026-09-17. Tracked in
[GH #300](https://github.com/simion/termic/issues/300).

A message in an agent tab's queue can carry a "send after" date. It is
saved with the tab and sent the first time that chat is live and idle on
or after the date. One-shot first; recurrence is a follow-up (see the end).

## What the user asked for

> I just want to schedule a message in an existing chat. For example, I'd
> like to ask Claude a week later to check logs related to the implemented
> feature. It doesn't need to trigger at the exact scheduled time, as long
> as it sends as soon as I open the chat on or after the execution date.

Two facts in that reply set the whole design:

- **Existing chat, not a new task.** The prompt goes into the session that
  already holds the context, so it belongs to a tab, not to a free-floating
  schedule record.
- **"On or after, when I open it" is enough.** Nothing has to fire on its
  own. No clock wakes an agent nobody is watching.

## Why the queue works now

The earlier write-up rejected the queue because it is runtime-only: `queue`
lives on the in-memory tab and dies with the app. That is a storage problem,
not a placement problem. Saving the scheduled items fixes it, and the queue
then answers questions a standalone scheduler would have had to design:

- **Where it is visible and cancellable:** the tab's queue popover, with
  the remove button it already has.
- **The target task is gone:** the item lives on the tab. An archived task
  never mounts, so it never fires; restoring the task brings the item back;
  deleting the task deletes it.
- **Several came due while the app was closed:** nothing fires at launch.
  An item goes out only in a tab the user has opened, so a cold start
  cannot spawn five agents.

## What to build

### 1. Data

- `QueueItem.notBefore?: number` (epoch ms) in `src/lib/types.ts`. Absent
  means an ordinary queue item, unchanged in every way.
- Scheduled items are one-shot: `repeat` and `remaining` are 1. The picker
  does not offer repeat for them.
- `PersistedTab.scheduled: Vec<ScheduledMessage>` in `lib.rs`, serde
  default empty, fields `{ id, text, not_before, created }`. Only items with
  `notBefore` are saved; ordinary items stay in memory as today.
- Written by a dedicated command, `task_set_tab_scheduled(id, tab_id,
  items)`, on the `task_set_tab_session_id` model. `task_set_tabs` must
  PRESERVE `scheduled` across rewrites, matched by tab id, exactly as it
  preserves `session_id`. Letting it write the field would let a tab rename
  racing a schedule write drop the schedule.
- On load, hydrate `scheduled` into `tab.queue` as items with `notBefore`.

### 2. Creating one

`MessageQueueButton.tsx` gets a "Send after" control next to add: presets
(tomorrow, in 3 days, in a week) plus a date picker, resolved to an absolute
`notBefore` at creation. One line of copy under it, no em dashes:

> Sends the next time this chat is open on or after <date>.

That sentence is the whole ceiling, stated where the choice is made. It
must not say "at" a time.

### 3. Sending

Changes to `sendNextQueued` in `TerminalPane.tsx`:

- **Pick the first due item**, not `q[0]`. An item with `notBefore > now`
  is skipped over, and ordinary items behind it still drain.
- **Scheduled items do not need `queueActive`.** A due scheduled item sends
  whenever the agent is idle; the user armed it when they created it.
- **Future items do not end the queue.** If the only items left are not
  due, do not set `queueActive: false` and do not toast "Message queue
  finished".
- **Respawn does not pause them.** The respawn block (it currently pauses
  the queue and fails CLI prompts) leaves scheduled items alone: resuming a
  chat after a reopen is exactly the moment they exist for.
- **Wait for readiness before the first send after a spawn.** A resumed TUI
  is not ready at its first idle, and claude's startup dialogs eat
  keystrokes (the trust picker answers `No, exit` on the submit). Use
  `waitForAgentReady` from `src/lib/agentReady.ts` with
  `hooksOwnReadiness`, the same recipe as `seedPromptWhenReady`. On
  `blocked` or `lost`, do NOT consume the item: leave it queued and retry on
  the next idle. Send with `deliverMessage(..., { verifyEcho })` as the seed
  path does.
- **Remove on delivery, then persist.** Drop the item from `tab.queue` and
  write `task_set_tab_scheduled` after the write lands, not before.
- **Say it was late.** If `now - notBefore` is over an hour, toast
  "Scheduled message sent (due N days ago)". The prompt text is never
  modified.

### 4. The one clock

A chat that is already open and idle when the date passes has nothing to
kick it. One global ticker, on the `src/store/pr.ts` model: a singleton
started from `App` after `loadAll`, idempotent, once a minute. Each pass
walks mounted tabs and bumps `queueKick` only on a tab that holds a due
scheduled item. **A pass with nothing due writes nothing to the store**
(docs/performance.md bear trap 8). Per-tab `setTimeout`s are out: a delay
over ~24.8 days overflows, and timers do not track sleep.

### 5. Closing a tab that holds schedules

Closing an agent tab with scheduled items asks first: "This tab has N
scheduled messages. Closing it deletes them." Stopping or archiving the
task does not ask, because both keep the tab record.

## Constraints

1. **No daemon, no Rust timer.** Sending happens only inside a running app,
   in a tab the user opened. Headless delivery stays the CLI's job, below.
2. **No `thread::sleep` poll loop.** The ticker is JS, and it writes
   nothing when nothing is due.
3. **No new store for schedules.** They ride on the task file, which is
   already profile-scoped.

## Tests (same commit as the code)

- Unit: due-item selection (future items skipped, ordinary items behind
  them drain, future-only queue is not "finished"); `blocked`/`lost` keep
  the item; the ticker writes nothing on an empty pass.
- `cargo test`: `task_set_tabs` preserves `scheduled`; serde default on old
  task files.
- e2e: schedule with a past-dated `notBefore` (test hook) → relaunch →
  open task → delivered once; future item stays and survives relaunch;
  cancel from the popover removes it from disk; closing the tab prompts.

## Must be checked by hand

The readiness wait on a resumed claude session, including one that shows
a startup update or trust dialog. No suite catches a prompt typed into a
splash screen.

## Docs to update when it ships

`data-model.md` (the `scheduled` field on persisted tabs), `ipc.md`
(`task_set_tab_scheduled`), `ui.md` if the queue popover section describes
its controls. Then delete this plan and close #300.

## Headless is the CLI's job

A user who needs a prompt delivered with the app closed writes a launchd
agent (or `at`) around:

    open -a Termic && "$TERMIC_CLI" send my-task --resume -p "check the release logs for ..."

which starts the agent if it is not running and delivers the prompt.

## Follow-up, not in this plan: recurrence

The queue already answers the two semantic questions: a run that comes due
while the agent is working waits for its done, and it goes into the same
session. Missed runs collapse to one send. Offer presets ("daily / weekly
at HH:MM") computed with plain `Date` math rather than raw cron strings,
which avoids a parser dependency and gets local time and DST right by
construction. A separate plan once one-shot has shipped.
