// The rules that move a task onto another account (GH #278).
//
// These functions ACT on the user's behalf, so the cases below are weighted
// towards the ones where the right answer is to do NOTHING. A missed switch
// costs a restart; a wrong one spends the wrong subscription.

import { describe, it, expect } from "vitest";
import { switchCandidate, isSpent, SWITCH_AT_PERCENT, type AccountReading } from "@/lib/autoSwitch";
import type { AgentAccountsView } from "@/lib/types";

const NOW = 1_800_000_000_000; // fixed epoch ms, so no test depends on the clock
const HOUR = 3_600_000;

const reading = (pct: number, opts: { resetsAt?: number | null; at?: number } = {}): AccountReading => ({
  session: { usedPercent: pct, resetsAt: opts.resetsAt === undefined ? (NOW + HOUR) / 1000 : opts.resetsAt },
  weekly: null,
  sessionCostUsd: null,
  updatedAt: opts.at ?? NOW,
});

const view = (
  names: string[],
  opts: Partial<AgentAccountsView> & { signedOut?: string[] } = {},
): AgentAccountsView => ({
  agentId: "claude",
  accounts: names.map(n => ({
    name: n,
    signedIn: !(opts.signedOut ?? []).includes(n),
    isDefault: n === names[0],
  })),
  supported: true,
  unsupportedReason: null,
  envVar: "CLAUDE_CONFIG_DIR",
  envIsSharedRoot: false,
  adoptedAccount: null,
  reportsUsage: true,
  autoSwitch: false,
  ...opts,
});

describe("isSpent", () => {
  it("respects a Codex credit budget and its billing reset", () => {
    const budget: AccountReading = {
      session: null, weekly: null, sessionCostUsd: null, updatedAt: NOW,
      budget: { usedPercent: 97, used: 7760, limit: 8000, resetsAt: (NOW + HOUR) / 1000 },
    };
    expect(isSpent(budget, NOW)).toBe(true);
    expect(isSpent(budget, NOW + 2 * HOUR)).toBe(false);
    expect(isSpent({ ...budget, budget: { ...budget.budget!, usedPercent: 8 } }, NOW)).toBe(false);
  });

  it("is false for an account nobody has heard from", () => {
    // Silence is not evidence. Treating it as spent would rule out every
    // account that has not run yet, which is all of them on a fresh install.
    expect(isSpent(undefined, NOW)).toBe(false);
  });

  it("is false below the line and true at it", () => {
    expect(isSpent(reading(SWITCH_AT_PERCENT - 1), NOW)).toBe(false);
    expect(isSpent(reading(SWITCH_AT_PERCENT), NOW)).toBe(true);
  });

  it("stops being true once the window has rolled over", () => {
    // The reading still says 99%, but its window reset an hour ago. Without
    // this an account is written off for the rest of the day over a number
    // from the morning.
    expect(isSpent(reading(99, { resetsAt: (NOW - HOUR) / 1000 }), NOW)).toBe(false);
    expect(isSpent(reading(99, { resetsAt: (NOW + HOUR) / 1000 }), NOW)).toBe(true);
  });

  it("stays true when the provider gave no reset clock", () => {
    // The cautious direction: we cannot show it recovered, and guessing that
    // it did rotates onto a maxed-out account, which fails invisibly.
    expect(isSpent(reading(99, { resetsAt: null }), NOW)).toBe(true);
  });

  it("judges by the window closest to its limit, not by the session one", () => {
    // 20% of five hours next to 97% of the week is spent, and a rule that
    // only looked at the session window would keep working right up until
    // the turn that fails.
    const weeklyHeavy: AccountReading = {
      session: { usedPercent: 20, resetsAt: (NOW + HOUR) / 1000 },
      weekly: { usedPercent: 97, resetsAt: (NOW + 48 * HOUR) / 1000 },
      sessionCostUsd: null,
      updatedAt: NOW,
    };
    expect(isSpent(weeklyHeavy, NOW)).toBe(true);
  });
});

describe("switchCandidate", () => {
  const base = { seen: {} as Record<string, AccountReading | undefined>, now: NOW };

  it("stays put while there is room", () => {
    expect(switchCandidate({
      ...base, view: view(["Work", "Personal"]), current: "Work", usage: reading(50),
    })).toBeNull();
  });

  it("names the other account once this one is spent", () => {
    expect(switchCandidate({
      ...base, view: view(["Work", "Personal"]), current: "Work", usage: reading(96),
    })).toBe("Personal");
  });

  it("does nothing with only one account, which is not a choice", () => {
    expect(switchCandidate({
      ...base, view: view(["Work"]), current: "Work", usage: reading(99),
    })).toBeNull();
  });

  it("does nothing for an agent that cannot hold a second login", () => {
    expect(switchCandidate({
      ...base,
      view: view(["Work", "Personal"], { supported: false }),
      current: "Work",
      usage: reading(99),
    })).toBeNull();
  });

  it("does nothing when the login was never named", () => {
    // An unnamed login has no place in the rotation: termic would be moving
    // someone off the account they have always used, onto one they created
    // for something else, without ever having been asked.
    expect(switchCandidate({
      ...base, view: view(["Work", "Personal"]), current: null, usage: reading(99),
    })).toBeNull();
  });

  it("never picks an account nobody has signed into", () => {
    // Strictly worse than the limit it is dodging: the agent cannot start at
    // all on an empty store.
    expect(switchCandidate({
      ...base,
      view: view(["Work", "Personal"], { signedOut: ["Personal"] }),
      current: "Work",
      usage: reading(99),
    })).toBeNull();
  });

  it("skips an account it already knows is spent", () => {
    expect(switchCandidate({
      ...base,
      view: view(["Work", "Personal", "Side"]),
      current: "Work",
      usage: reading(99),
      seen: { Personal: reading(97) },
    })).toBe("Side");
  });

  it("uses an account whose own window has since reset", () => {
    // Same 97% as above, but its window rolled over, so it is available
    // again and is the nearest one in the rotation.
    expect(switchCandidate({
      ...base,
      view: view(["Work", "Personal", "Side"]),
      current: "Work",
      usage: reading(99),
      seen: { Personal: reading(97, { resetsAt: (NOW - HOUR) / 1000 }) },
    })).toBe("Personal");
  });

  it("gives up rather than returning to a spent account", () => {
    expect(switchCandidate({
      ...base,
      view: view(["Work", "Personal"]),
      current: "Work",
      usage: reading(99),
      seen: { Personal: reading(99) },
    })).toBeNull();
  });

  it("rotates onward from where it is, rather than restarting at the top", () => {
    // Starting from B, the next account is C, not A. Without this a third
    // account is only ever reached by exhausting the first two in order, and
    // a two-account rotation bounces between the same pair forever.
    expect(switchCandidate({
      ...base, view: view(["A", "B", "C"]), current: "B", usage: reading(99),
    })).toBe("C");
    expect(switchCandidate({
      ...base, view: view(["A", "B", "C"]), current: "C", usage: reading(99),
    })).toBe("A");
  });
});
