// How much of each account's subscription limits has been spent (GH #277).
//
// Keyed by AGENT ENTRY id AND ACCOUNT, not by task. Two tasks spending the
// same quota must read the same number, and two tasks on different quotas must
// never see each other's, so the key has to be exactly the thing the provider
// bills: the login.
//
// The account half arrived with the switcher (GH #278) and it was a real
// defect for the window in between. Before accounts, an agent entry WAS a
// login: holding a second one meant cloning the agent and relocating its
// config dir, so keying by entry id alone was correct and this file said so.
// Once one entry can hold several accounts that stopped being true, and two
// tasks of the same agent on different logins wrote into one slot: whichever
// spoke last painted its percentage under the other's name. Nothing failed,
// nothing looked wrong, and the number was somebody else's.
//
// The account in the key is the one the PROCESS was spawned with (Rust returns
// it from `pty_spawn`), never the one currently configured. A switch applies
// on the next spawn, so between the click and the restart those two differ,
// and the configured one would file the old account's spending under the new
// account's name.

import { create } from "zustand";
import type { AgentUsage } from "@/lib/agentUsage";
import { sameUsage } from "@/lib/agentUsage";

export interface UsageEntry extends AgentUsage {
  /** When this reading landed. Shown as staleness: the claude status line only
   *  speaks while a turn runs, so a footer with no running task is showing
   *  something that was true a while ago and should say so. */
  updatedAt: number;
  /** Which side reported it, for the tooltip and for debugging a wrong number
   *  without having to guess which transport produced it. */
  source: "statusline" | "rpc";
  /** The account this reading belongs to, `null` for the agent's ordinary
   *  login. Carried on the entry as well as in the key so a reader that has an
   *  entry in hand never has to parse the key back apart. */
  account: string | null;
  /** Has this account EVER reported a plan window? Sticky.
   *
   *  claude sends `cost` on every payload but `rate_limits` only once a turn
   *  has actually reached the API, so the first reading of a session carries
   *  money and no windows and is indistinguishable from a token-billed
   *  account. Without this the footer showed a dollar figure and then flipped
   *  to a percentage bar the moment the first response landed. */
  sawPlan: boolean;
  /** Has a reading PROVED this account has no plan? Sticky, and only ever
   *  set by claude's status line.
   *
   *  The proof is a session whose cost ROSE with no window alongside it. A
   *  rise means a turn reached the API, and a subscription reports its windows
   *  in that same payload (measured on 2.1.273: `0` with no windows before the
   *  first message, then windows and `0.119` together). Before that, a
   *  subscription and a token-billed account send the same thing.
   *
   *  This replaced a count of window-less readings ACROSS sessions. Every
   *  session sends one before its first message, so restoring two tasks after
   *  a relaunch "proved" a Max account was billed per token: the second task's
   *  footer showed `$0.00` and its panel said so. */
  noPlan: boolean;
}

/** The store key for one agent-entry-and-account pair.
 *
 *  Encoded as a JSON tuple rather than joined with a separator, so a collision
 *  is impossible by construction rather than by the argument that nobody would
 *  type the separator. Both halves are attacker-adjacent strings: an agent
 *  entry id and an account name are typed by the user in Settings, and the
 *  first draft of this key joined them with a NUL, which its own test then
 *  broke by naming an agent `claude\u0000x`. Unlikely is not the same as
 *  impossible, and the cost of ruling it out is one function call on a path
 *  that is not hot.
 *
 *  `null` is the agent's ordinary login, and encodes as itself rather than as
 *  an empty name, so "no account" and an account literally named "" (which
 *  `account_add` refuses anyway) could never be the same key. */
export function usageKey(agentId: string, account: string | null): string {
  return JSON.stringify([agentId, account]);
}

/** What one account has spent since termic launched.
 *
 *  In memory only, and that IS the definition: "since launch" is the store
 *  being empty at startup, not a persisted counter someone has to reset.
 *
 *  Two fields, because claude reports a session TOTAL rather than a delta.
 *  Summing readings would multiply the bill; taking the latest would lose
 *  everything when the agent restarts and its counter goes back to zero. So
 *  the live sessions are tracked individually and a finished one is banked. */
export interface CostEntry {
  /** Latest reported total, per live session. */
  bySession: Record<string, number>;
  /** Totals from sessions that have since restarted. */
  banked: number;
}

/**
 * Should the FOOTER CHIP show money for this account?
 *
 *  ZERO IS A READING, not an absence, once the account is known to have no
 *  plan. Requiring `spend > 0` hid the whole chip on a per-token account
 *  between its session start and its first completed turn: the wire carries
 *  `- - - - 0` there, so there was nothing to show and nothing saying why,
 *  which is the state a user reads as "it does not report my account".
 *  Measured on an enterprise usage-based seat, which sends `- - - - 0` and
 *  then `- - - - 0.235401`.
 *
 *  Only for an account with no plan, which is the case the whole cost feed
 *  exists for: a token-billed account reports no percentages and its chip was
 *  empty. On a subscription the percentages are the readout and money in the
 *  chip is a second number competing with them; the popover still shows the
 *  spend, where it cannot flicker.
 *
 *  `noPlan` is what stops the flip. A window-less reading means nothing by
 *  itself: claude sends cost on every payload but rate_limits only once a turn
 *  has reached the API, so every session's FIRST reading looks plan-less. See
 *  `UsageEntry.noPlan` for what does count as proof.
 */
/** Is there anything REAL to show for this account yet?
 *
 *  Plan windows, or the proof that there is no plan (and so the spend is the
 *  readout). Anything short of that is "usage unknown": a reading that has not
 *  reached the API says nothing about the account. */
export function usageKnown(entry: UsageEntry | undefined, spend: number): boolean {
  return !!entry && (!!entry.session || !!entry.weekly || costChipVisible(entry, spend));
}

export function costChipVisible(entry: UsageEntry | undefined, spend: number): boolean {
  if (!entry) return false;
  if (entry.sawPlan) return false;
  // Only claude's status line reports cost at all. codex's feed is plan
  // windows and nothing else, so a window-less codex reading would otherwise
  // print "$0.00" for a number it never sent.
  if (entry.source !== "statusline") return false;
  if (!(spend >= 0)) return false;
  return entry.noPlan;
}

/** How long to wait before the FIRST pull for a credential, in ms.
 *
 *  The pull transports (codex, devin) poll from the chip, and the chip is
 *  per AGENT PER TASK while the reading it fetches is per CREDENTIAL and shared
 *  by every task on that login. The effect that owns the timer re-runs whenever
 *  the task becomes visible, so it used to `ask()` immediately on every task
 *  switch: switching between two tasks on one login respawned `codex
 *  app-server` to re-learn a number already sitting in the store, seconds old.
 *
 *  So the cadence follows the DATA's age rather than the mount. A cold entry
 *  still asks immediately (`Infinity` age, delay 0), which is the case that
 *  matters for a first paint; a warm one waits out the remainder of the
 *  interval, so staleness is still bounded by `intervalMs` rather than by
 *  `intervalMs` plus however long ago somebody last switched tasks.
 *
 *  Only a reading from the SAME pull transport counts. A statusline entry
 *  under this key is not evidence that a pull would return the same thing, and
 *  suppressing a pull on it would let one agent's push silence another's fetch.
 *
 *  Pure and exported because the failure mode is silent either way: too eager
 *  is a respawn nobody sees, too lazy is a number nobody notices is old. */
export function firstPollDelay(
  entry: { updatedAt: number; source: UsageEntry["source"] } | undefined,
  now: number,
  intervalMs: number,
): number {
  if (!entry || entry.source !== "rpc") return 0;
  const age = now - entry.updatedAt;
  // A clock that went backwards (NTP step, sleep/wake) reads as a negative
  // age. Treat it as fresh rather than letting it schedule a delay longer than
  // the interval it is bounded by.
  if (age < 0) return intervalMs;
  return Math.max(0, Math.min(intervalMs, intervalMs - age));
}

/** Everything spent on this account since launch. */
export function costTotal(e: CostEntry | undefined): number {
  if (!e) return 0;
  return e.banked + Object.values(e.bySession).reduce((a, b) => a + b, 0);
}

/** Fold one reading in.
 *
 *  A total that went DOWN means the agent restarted in that tab: claude's
 *  counter is per session and starts again at zero. The old total is banked
 *  before the new one takes its place, or every restart would silently erase
 *  the spend that came before it.
 *
 *  Pure, and exported, because this is the one piece of arithmetic here that
 *  can be wrong in a way nobody notices: the number just reads low. */
export function foldCost(prev: CostEntry | undefined, session: string, total: number): CostEntry {
  const cur: CostEntry = prev ?? { bySession: {}, banked: 0 };
  const last = cur.bySession[session];
  if (last !== undefined && total < last) {
    return { banked: cur.banked + last, bySession: { ...cur.bySession, [session]: total } };
  }
  return { banked: cur.banked, bySession: { ...cur.bySession, [session]: total } };
}

interface AgentUsageState {
  byAgent: Record<string, UsageEntry>;
  /** Spend per account since launch, keyed exactly like `byAgent`. */
  cost: Record<string, CostEntry>;
  report: (
    agentId: string,
    account: string | null,
    usage: AgentUsage,
    source: UsageEntry["source"],
    /** Which agent SESSION this reading is about, for the cost accumulator.
     *  The agent's own session id where it has reported one, because the cost
     *  is a per-session running total: keying by TAB double-counted a session
     *  resumed in another tab, which reported the same cumulative figure
     *  again. Falls back to the tab only when no session id exists yet. */
    session?: string,
  ) => void;
  clear: (agentId: string, account?: string | null) => void;
}

export const useAgentUsage = create<AgentUsageState>((set, get) => ({
  byAgent: {},
  cost: {},
  report: (agentId, account, usage, source, session) => {
    const key = usageKey(agentId, account);
    // This session's total BEFORE the reading below folds in: the rise is the
    // no-plan proof (`UsageEntry.noPlan`), so it has to be read first.
    const lastSessionCost = session ? get().cost[key]?.bySession[session] : undefined;
    // And this reading's OWN figure, before the carry below can substitute
    // another session's total for a missing one.
    const readCost = usage.sessionCostUsd;
    // Cost first, and independently of the bail below: a reading whose
    // percentages did not move can still carry a few more cents, and the
    // accumulator must see every one of them.
    if (usage.sessionCostUsd != null && session) {
      const prev = get().cost[key];
      const next = foldCost(prev, session, usage.sessionCostUsd);
      // A NEW session is written even at an unchanged total: its first figure
      // (usually 0) is the baseline the no-plan proof rises from. One write
      // per session, not per turn.
      if (costTotal(next) !== costTotal(prev) || prev?.bySession[session] === undefined) {
        set(s => ({ cost: { ...s.cost, [key]: next } }));
      }
    }
    const cur = get().byAgent[key];
    // Carry a window the new reading does NOT carry, when the last one did.
    //
    // Claude reports both windows together, and a payload can arrive with one
    // of them null: measured, a `used_percentage` of null drops that window,
    // and the likely moment is just after it resets. Replacing wholesale then
    // blanks a session percentage that was on screen a second earlier, which
    // reads as the feature breaking rather than as one absent field.
    //
    // Only ever ADDS back a window, never removes one, and only from the same
    // source, so codex's genuinely absent session window (free plan) stays
    // absent. The age shown is the entry's newest reading, so a carried
    // window is at most as old as that label already admits.
    if (cur && cur.source === source) {
      usage = {
        session: usage.session ?? cur.session,
        weekly: usage.weekly ?? cur.weekly,
        // Carried the same way, for the same reason: claude reports cost on
        // every turn but a turn that never reached the API carries none, and
        // blanking the figure on those would make it flicker.
        sessionCostUsd: usage.sessionCostUsd ?? cur.sessionCostUsd,
      };
    }
    // The status line fires on EVERY turn, and most turns move a percentage by
    // nothing at all. An unchanged write copies the whole store and re-runs
    // every subscriber's selector (docs/performance.md bear trap 8) on the
    // hottest path there is: a streaming agent.
    //
    // `updatedAt` is deliberately NOT part of the comparison. Refreshing it on
    // an unchanged reading would defeat the bail entirely, and the staleness it
    // feeds is about the NUMBER's age, not the poll's.
    const hasWindow = !!(usage.session || usage.weekly);
    // A restored session can start from a total it already had, so the proof
    // is a RISE within one session, never a nonzero figure on its own.
    const rose = source === "statusline" && !hasWindow
      && lastSessionCost !== undefined && readCost != null
      && readCost > lastSessionCost;
    const noPlan = (cur?.noPlan ?? false) || rose;
    // `noPlan` is compared as well: two sessions of one account can land on the
    // same total, and the one that PROVES something must not be dropped as a
    // repeat of the other.
    if (cur && cur.source === source && sameUsage(cur, usage) && cur.noPlan === noPlan) return;
    set(s => ({
      byAgent: {
        ...s.byAgent,
        [key]: {
          ...usage,
          source,
          updatedAt: Date.now(),
          account,
          sawPlan: (cur?.sawPlan ?? false) || hasWindow,
          noPlan,
        },
      },
    }));
  },
  // Drops ONE account's reading, or every reading for the agent when no
  // account is named. The second form is what a removed or reconfigured agent
  // needs: leaving an orphaned key behind would let a later agent of the same
  // id inherit a stranger's percentage.
  clear: (agentId, account) => {
    // Spend is deliberately NOT cleared here. `clear` runs when an agent entry
    // goes away, and "since launch" is a fact about the launch, not about
    // whether the agent is still configured.
    if (account !== undefined) {
      const key = usageKey(agentId, account);
      if (!(key in get().byAgent)) return;
      set(s => {
        const byAgent = { ...s.byAgent };
        delete byAgent[key];
        return { byAgent };
      });
      return;
    }
    const keys = Object.keys(get().byAgent).filter(k => {
      try { return (JSON.parse(k) as [string, string | null])[0] === agentId; }
      catch { return false; }
    });
    if (!keys.length) return;
    set(s => {
      const byAgent = { ...s.byAgent };
      for (const k of keys) delete byAgent[k];
      return { byAgent };
    });
  },
}));
