// What a task's tabs add up to, for the one badge a row gets.
//
// Extracted from Sidebar.tsx so the dashboard draws the SAME badge from the
// SAME inputs. The two surfaces showing a task differently is the class of bug
// the `data-dashboard-task-id` hook was added for (see Dashboard.tsx), and
// there is no reason for a second copy of a three-line precedence rule.
//
// This is the agent's LIVE work state, not a lifecycle status: it answers
// "what is the machine doing right now", it is derived from tab state, and it
// dies with the process. Nothing here is persisted.

import type { Tab } from "./types";

/** The one badge a row draws, or null for "draw nothing".
 *
 *  Precedence: attention > done > working. A blocked agent is more actionable
 *  than a finished one, and both are more actionable than one still chugging.
 *  `cliAgentState.ts` ranks working ABOVE attention for the CLI wire; that
 *  divergence predates this helper and is deliberately not resolved here,
 *  because `TaskSummary.work_state` is a published contract. */
export type WorkBadgeReason = "attention" | "done" | "working";

export interface WorkStatePrefs {
  /** `settledHighlight` — gates attention AND done. Off means the whole
   *  work-done UI is disabled, so neither may draw. */
  settledHighlight: boolean;
  /** `workingIndicator` — its own opt-in, gating only the spinner.
   *
   *  Optional because only `taskWorking` reads it, and the callers that ask
   *  purely about attention/done (the sidebar's project and group rollup dots)
   *  would otherwise have to subscribe to a pref they do not use. Absent is
   *  treated as off, which is correct for those callers: they never draw a
   *  spinner. */
  workingIndicator?: boolean;
}

/** The agent is explicitly blocked on the user (Gemini "Action Required",
 *  Codex "Waiting", OSC 1337 RequestAttention). */
export const taskNeedsAttention = (tabs: Tab[], p: WorkStatePrefs): boolean =>
  p.settledHighlight
  && tabs.some(t => t.type === "terminal" && t.unread?.reason === "attention");

/** Some tab just settled: the agent stopped producing output and is waiting.
 *  Distinct from attention — different badge, different urgency. */
export const taskWorkDone = (tabs: Tab[], p: WorkStatePrefs): boolean =>
  p.settledHighlight
  && tabs.some(t => t.type === "terminal" && t.workState === "done");

/** An agent is mid-turn. */
export const taskWorking = (tabs: Tab[], p: WorkStatePrefs): boolean =>
  !!p.workingIndicator
  && tabs.some(t => t.type === "terminal" && t.workState === "working");

/** The whole precedence in one call: what this row should draw, or null.
 *
 *  Callers that need the individual flags (the sidebar logs all three to the
 *  work-state trace, and needs them separately to explain why nothing drew)
 *  use the predicates above; callers that just want a badge use this. */
export function taskWorkBadge(tabs: Tab[], p: WorkStatePrefs): WorkBadgeReason | null {
  if (taskNeedsAttention(tabs, p)) return "attention";
  if (taskWorkDone(tabs, p)) return "done";
  if (taskWorking(tabs, p)) return "working";
  return null;
}
