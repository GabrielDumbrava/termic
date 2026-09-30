// When a queued message should go out even though the agent still looks busy.
//
// The queue drains on work-done. A work-done that never arrives is therefore a
// queue that never drains, and that is a reported failure, not a theory: an
// agent "got stuck in a state and never received messages from other agents".
// The existing backstop (TerminalPane's absolute ceiling) clears a stuck
// spinner after twenty minutes, and only for a work-done-capable agent with a
// live PTY, which for a handoff between two agents is indistinguishable from
// never.
//
// The signal is OUTPUT, not the clock. An agent that is genuinely mid-turn
// prints something: a spinner frame, a token, a tool line. Total silence from
// the PTY is the honest evidence that the turn ended and the done was missed.
// Using elapsed time instead would interrupt exactly the case the queue exists
// to protect, an agent thinking hard for minutes, which this codebase has
// measured at 818 seconds on one turn.
//
// A pure function so the boundary is unit-testable; the caller supplies the
// clock and the pref.

export interface QueueStallInput {
  /** Is there anything waiting that this would release? */
  hasQueued: boolean;
  /** The tab's current work state. Only "working" blocks the drain. */
  workState: string | null | undefined;
  /** When the PTY last produced ANY bytes, epoch ms. Null when it never has. */
  lastOutputAt: number | null | undefined;
  /** When we last submitted a queued message, epoch ms. 0 when we never have. */
  lastQueueSendAt: number;
  now: number;
  /** `prefs.queueStallMs`. 0 disables the whole rule. */
  stallMs: number;
}

/** True when the agent has looked busy, and said nothing at all, for longer
 *  than the grace window, with something queued behind it. */
export function queueLooksStalled(i: QueueStallInput): boolean {
  if (i.stallMs <= 0) return false;          // the feature is off
  if (!i.hasQueued) return false;            // nothing to release
  if (i.workState !== "working") return false; // the ordinary path handles it
  // Never sent anything, so there is no turn of ours to be stuck in. The agent
  // was busy before the queue existed and the normal gate still applies.
  if (!i.lastQueueSendAt) return false;
  // Silence is measured from the LAST of the two: output we have seen, and the
  // moment we submitted. Measuring from output alone would fire immediately on
  // an agent that had been quiet before our message ever landed, which is the
  // opposite of waiting for it to finish.
  const since = Math.max(i.lastOutputAt ?? 0, i.lastQueueSendAt);
  return i.now - since >= i.stallMs;
}
