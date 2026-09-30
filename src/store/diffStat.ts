// Per-task change summaries (+N / -M / k files), for surfaces that show MANY
// tasks at once. The Kanban board is the first.
//
// A store of its own, outside `useApp`, for the reason `pr.ts` is: the app
// store is subscribed by every mounted task, and writing a number into it on
// a timer would re-run those selectors for every card on every tick. Nothing
// here touches `useApp`.
//
// It is also deliberately NOT the poller `pr.ts` is. A PR's state changes
// because a person somewhere else clicked something, so it has to be polled
// to be discovered. A diff changes because an agent on THIS machine wrote a
// file, and the cost of asking is two git processes per repo. So this is
// demand-driven with a staleness floor: the board asks for what it is about
// to draw, and a task nobody is looking at is never measured at all. A board
// left open on a busy task refreshes it; a board nobody has open costs
// nothing.

import { create } from "zustand";
import { taskDiffStat } from "@/lib/ipc";
import type { TaskDiffStat } from "@/lib/types";

/** How long a measurement stays good. Long enough that scrolling a board does
 *  not re-measure, short enough that a card watched while an agent works
 *  visibly moves. */
export const DIFF_STALE_MS = 20_000;
/** The most tasks measured per flush. A board can show more cards than this;
 *  the rest arrive on the next flush rather than forking 2xN git processes in
 *  one frame. */
export const MAX_PER_FLUSH = 6;

export interface DiffStatEntry {
  stat: TaskDiffStat | null;
  loading: boolean;
  /** Wall-clock ms of the last COMPLETED measurement, success or failure.
   *  Failure counts: a task whose repo has gone missing must not be retried
   *  on every flush. */
  fetchedAt: number;
  /** Set when the last attempt failed. The card shows nothing rather than
   *  zeros: "no changes" and "could not work it out" are different answers. */
  error: string | null;
}

interface DiffStatStore {
  byTask: Record<string, DiffStatEntry>;
  /** Measure one task unless a fresh enough answer is already in hand. */
  request: (taskId: string) => void;
  /** Measure these, oldest-first, up to MAX_PER_FLUSH. What a list view calls
   *  with the ids it is drawing. */
  requestMany: (taskIds: readonly string[]) => void;
  /** Drop a task's entry, so the next request measures again. For an action
   *  that just changed the tree (an archive, a branch switch). */
  invalidate: (taskId: string) => void;
}

const inFlight = new Set<string>();

async function measure(taskId: string) {
  if (inFlight.has(taskId)) return;
  inFlight.add(taskId);
  useDiffStat.setState(s => ({
    byTask: { ...s.byTask, [taskId]: { ...entryOf(s.byTask, taskId), loading: true } },
  }));
  let stat: TaskDiffStat | null = null;
  let error: string | null = null;
  try {
    stat = await taskDiffStat(taskId);
  } catch (e) {
    error = String(e);
  } finally {
    inFlight.delete(taskId);
    useDiffStat.setState(s => ({
      byTask: {
        ...s.byTask,
        // Keep the LAST GOOD numbers when a refresh fails. A card that has
        // been showing +40 should not blank because one measurement lost a
        // race with an archive; it should keep saying what it last knew.
        [taskId]: { stat: stat ?? s.byTask[taskId]?.stat ?? null, loading: false, fetchedAt: Date.now(), error },
      },
    }));
  }
}

function entryOf(byTask: Record<string, DiffStatEntry>, id: string): DiffStatEntry {
  return byTask[id] ?? { stat: null, loading: false, fetchedAt: 0, error: null };
}

/** Is this task due a measurement? Exported so the board's own tests can ask
 *  without driving the timer. */
export function isStale(entry: DiffStatEntry | undefined, now = Date.now()): boolean {
  if (!entry) return true;
  if (entry.loading) return false;
  return now - entry.fetchedAt >= DIFF_STALE_MS;
}

export const useDiffStat = create<DiffStatStore>((set, get) => ({
  byTask: {},

  request: (taskId) => {
    if (!taskId) return;
    if (!isStale(get().byTask[taskId])) return;
    void measure(taskId);
  },

  requestMany: (taskIds) => {
    const { byTask } = get();
    const now = Date.now();
    const due = taskIds
      .filter(id => !!id && isStale(byTask[id], now))
      // Oldest snapshot first, so a board bigger than the cap still cycles
      // through every card instead of starving the tail.
      .sort((a, b) => (byTask[a]?.fetchedAt ?? 0) - (byTask[b]?.fetchedAt ?? 0))
      .slice(0, MAX_PER_FLUSH);
    for (const id of due) void measure(id);
  },

  invalidate: (taskId) => set(s => {
    if (!s.byTask[taskId]) return s;
    const byTask = { ...s.byTask };
    delete byTask[taskId];
    return { byTask };
  }),
}));

/** Test seam: forget everything measured so far. */
export function resetDiffStats() {
  inFlight.clear();
  useDiffStat.setState({ byTask: {} });
}
