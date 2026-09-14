// When to move a task onto another account, and which one (GH #278).
//
// Pure functions, no store and no ipc, for the same reason `accountPill.ts` is:
// this repo tests logic rather than rendered output, and these rules ACT on the
// user's behalf. A wrong answer here does not misdraw a chip, it silently
// spends the wrong subscription.
//
// The whole feature rests on one honest limitation: a switch takes effect on
// the NEXT spawn, because a running process cannot have its environment
// changed underneath it. So this never rescues the turn in flight. What it
// does is make sure that when the user restarts the agent (which a spent
// account forces them to do anyway) they are already on an account that can
// serve them, instead of hitting the same wall a second time and only then
// going looking for the switcher.

import type { AgentAccountsView } from "@/lib/types";
import { drivingWindow, type AgentUsage } from "@/lib/agentUsage";

/** Where an account counts as spent, for BOTH the offer and the automatic
 *  switch.
 *
 *  Deliberately one number rather than two. It is tempting to offer at 90 (the
 *  chip's existing "critical") and act at 95, on the grounds that an offer is
 *  cheap and an action is not. But the two answer the same question, "is this
 *  account done?", and giving them different answers produces a popover that
 *  offers a switch the automatic mode is simultaneously declining to make.
 *  There is no way to word that.
 *
 *  95 rather than 100 because the last few percent of a window are not usable
 *  in practice: a long turn that starts at 96% dies in the middle, which costs
 *  more than the sliver it was trying to use. */
export const SWITCH_AT_PERCENT = 95;

/** A reading of one account, as the usage store holds it. */
export interface AccountReading extends AgentUsage {
  /** Epoch ms, used only to reason about a reading with no reset clock. */
  updatedAt: number;
}

/** Is this account, on the evidence we have, out of room right now? */
export function isSpent(reading: AccountReading | undefined, now: number): boolean {
  if (!reading) return false; // never heard from it: not evidence of anything
  const driver = drivingWindow(reading);
  if (!driver) return false;
  if (driver.window.usedPercent < SWITCH_AT_PERCENT) return false;
  // A window that has already rolled over is not spent any more, whatever the
  // last reading said. This is what stops an account being written off for the
  // rest of the day over a number from this morning.
  const resetsAt = driver.window.resetsAt;
  if (resetsAt != null && resetsAt * 1000 <= now) return false;
  // No reset clock and over the line: still spent. The alternative is to guess
  // it recovered and rotate onto a maxed-out account, which fails in a way the
  // user cannot see (the switch reports success, the next turn dies anyway).
  // All three reporting agents send a reset clock, so this is the edge, not
  // the path, and the manual switch is always still there.
  return true;
}

/** The account to move to, or null to stay put.
 *
 *  Null is the answer in every uncertain case, and that is the point: doing
 *  nothing leaves the user exactly where they already are, while a wrong
 *  switch moves a work session onto a personal subscription. */
export function switchCandidate(args: {
  view: AgentAccountsView | null;
  /** The account in use, as `pillLabel` reports it. */
  current: string | null;
  /** What the CURRENT account has spent. */
  usage: AccountReading | undefined;
  /** Last reading per account name, for the ones we have heard from. */
  seen: Record<string, AccountReading | undefined>;
  now: number;
}): string | null {
  const { view, current, usage, seen, now } = args;
  if (!view || !view.supported || view.accounts.length < 2) return null;
  if (!current) return null;             // an unnamed login has no rotation
  if (!isSpent(usage, now)) return null; // nothing wrong yet

  // Rotate from where we are, so repeated switches walk the list rather than
  // bouncing between the first two entries.
  const names = view.accounts.map(a => a.name);
  const from = names.indexOf(current);
  const order = from < 0 ? names : [...names.slice(from + 1), ...names.slice(0, from)];

  for (const name of order) {
    if (name === current) continue;
    // Never switch to an account nobody has signed into. It would take a
    // working session to an agent that cannot start, which is strictly worse
    // than the limit the switch was trying to dodge.
    if (!view.accounts.find(a => a.name === name)?.signedIn) continue;
    if (isSpent(seen[name], now)) continue;
    return name;
  }
  return null;
}

/** One line for the user when a switch has been staged but NOTHING was
 *  running to restart, phrased so the delay is a stated fact rather than
 *  something they discover. */
export function switchedNotice(to: string): string {
  return `Nearly out of plan. Switched to ${to}, which applies when this agent next starts.`;
}

/** ...and when the agent was restarted onto it. Says that the conversation
 *  survived, because that is the part a user would otherwise have to verify
 *  by scrolling, and says the agent was told to carry on, because output
 *  appearing with nobody at the keyboard is otherwise alarming. */
export function switchedAndResumedNotice(to: string): string {
  return `Nearly out of plan. Restarted on ${to} and resumed this conversation, asking it to continue.`;
}
