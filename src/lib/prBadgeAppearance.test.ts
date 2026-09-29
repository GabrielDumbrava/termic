import { describe, expect, it } from "vitest";
import { prBadgeAppearance } from "./prBadgeAppearance";

const ERR = "var(--color-err)";
const FAINT = "var(--color-fg-faint)";

describe("prBadgeAppearance", () => {
  it("never paints a draft red, whatever its checks say", () => {
    // The reported rule. A draft is not asking to be looked at, so red CI on
    // one is expected; painting it red spends the alarm colour on something
    // nobody needs to act on.
    for (const checks of ["failing", "pending", "passing", "none", null] as const) {
      const a = prBadgeAppearance("draft", checks);
      expect(a.color, `draft with checks=${checks}`).toBe(FAINT);
      expect(a.alarming).toBe(false);
    }
  });

  it("paints an open PR red only while its checks fail", () => {
    expect(prBadgeAppearance("open", "failing")).toEqual({ color: ERR, alarming: true });
    for (const checks of ["pending", "passing", "none", null] as const) {
      expect(prBadgeAppearance("open", checks).color, `open with checks=${checks}`)
        .toBe("var(--color-pr-open)");
    }
  });

  it("leaves a settled PR its own colour, failing checks included", () => {
    // Merged is merged even if HEAD's CI went red afterwards, and closed is
    // already red on its own account rather than as an alarm.
    expect(prBadgeAppearance("merged", "failing")).toEqual({
      color: "var(--color-pr-merged)", alarming: false,
    });
    expect(prBadgeAppearance("closed", "failing")).toEqual({ color: ERR, alarming: false });
  });

  it("is faint when there is no state yet", () => {
    // A task carrying a cached pr_url that has never been looked up.
    expect(prBadgeAppearance(null, null)).toEqual({ color: FAINT, alarming: false });
  });
});
