import { describe, expect, it } from "vitest";
import { prBadgeAppearance, type PrBadgeState, type PrChecks } from "./prBadgeAppearance";

const ERR = "var(--color-err)";
const WARN = "var(--color-warn)";
const FAINT = "var(--color-fg-faint)";
const OPEN = "var(--color-pr-open)";
const MERGED = "var(--color-pr-merged)";

const STATES: PrBadgeState[] = ["open", "draft", "merged", "closed", null];
const CHECKS: (PrChecks | null)[] = ["failing", "pending", "passing", "none", null];

describe("prBadgeAppearance", () => {
  it("never returns red, for ANY combination", () => {
    // The whole rule, asserted over the whole matrix rather than case by case.
    // Red on this glyph was wrong twice over: a failing build on an open PR is
    // something to go and look at rather than a broken task, and a closed PR
    // wants nothing at all. A list dotted with red you are not meant to act on
    // teaches you to stop seeing red.
    for (const state of STATES) {
      for (const checks of CHECKS) {
        expect(prBadgeAppearance(state, checks).color, `${state} / ${checks}`).not.toBe(ERR);
      }
    }
  });

  it("gives a draft no colour at all, whatever its checks say", () => {
    // Not just "not red": not green either. A draft is work its author has not
    // asked anyone to look at, so neither its failures nor its passes are a
    // signal to anybody else yet.
    for (const checks of CHECKS) {
      const a = prBadgeAppearance("draft", checks);
      expect(a.color, `draft with checks=${checks}`).toBe(FAINT);
      expect(a.alarming).toBe(false);
    }
  });

  it("warns, not errors, on an open PR whose checks fail", () => {
    expect(prBadgeAppearance("open", "failing")).toEqual({ color: WARN, alarming: true });
  });

  it("leaves an open PR its own green while nothing is failing", () => {
    for (const checks of ["pending", "passing", "none", null] as const) {
      expect(prBadgeAppearance("open", checks), `open with checks=${checks}`)
        .toEqual({ color: OPEN, alarming: false });
    }
  });

  it("keeps merged purple even if HEAD's CI went red afterwards", () => {
    expect(prBadgeAppearance("merged", "failing")).toEqual({ color: MERGED, alarming: false });
  });

  it("treats closed as inert, not as an error", () => {
    // It used to be --color-err, which said "something needs you here" about a
    // PR that by definition wants nothing.
    for (const checks of CHECKS) {
      expect(prBadgeAppearance("closed", checks), `closed with checks=${checks}`)
        .toEqual({ color: FAINT, alarming: false });
    }
  });

  it("is faint when there is no state yet", () => {
    // A task carrying a cached pr_url that has never been looked up.
    expect(prBadgeAppearance(null, null)).toEqual({ color: FAINT, alarming: false });
  });

  it("marks only the open+failing case as alarming", () => {
    for (const state of STATES) {
      for (const checks of CHECKS) {
        const want = state === "open" && checks === "failing";
        expect(prBadgeAppearance(state, checks).alarming, `${state} / ${checks}`).toBe(want);
      }
    }
  });
});
