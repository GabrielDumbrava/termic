// What colour the PR glyph on a task row takes, and whether it is an alarm.
//
// A pure function rather than a ternary chain inside TaskPrBadge, because the
// one rule here that is easy to break by accident ("a draft never turns red")
// is worth a test, and this repo has no component-render setup: the choices are
// a real unit test on a function or a regex over the component's source.

/** The four states `PrStatus.state` can carry, plus "no lookup yet". */
export type PrBadgeState = "open" | "draft" | "merged" | "closed" | null;
export type PrChecks = "none" | "pending" | "passing" | "failing";

export interface PrBadgeAppearance {
  /** A CSS var reference, ready for `style={{ color }}`. */
  color: string;
  /** True when the colour is the error colour BECAUSE checks are failing, as
   *  opposed to a closed PR which is red on its own account. Callers use it for
   *  nothing but the tooltip's wording; it exists so the test can tell the two
   *  reds apart. */
  alarming: boolean;
}

export function prBadgeAppearance(state: PrBadgeState, checks: PrChecks | null): PrBadgeAppearance {
  const failing = checks === "failing";
  switch (state) {
    case "merged":
      // Done. CI at HEAD stops being the thing worth flagging.
      return { color: "var(--color-pr-merged)", alarming: false };
    case "closed":
      return { color: "var(--color-err)", alarming: false };
    case "draft":
      // NEVER red, whatever the checks say. A draft is work its author has not
      // asked anyone to look at, so failing CI on one is expected rather than
      // alarming, and a sidebar of red drafts trains the eye to ignore the
      // colour that is supposed to mean "this needs you".
      return { color: "var(--color-fg-faint)", alarming: false };
    case "open":
      // The glyph is the only PR signal visible without opening the Git tab, so
      // a broken build must not look identical to a healthy one here.
      return failing
        ? { color: "var(--color-err)", alarming: true }
        : { color: "var(--color-pr-open)", alarming: false };
    default:
      // A cached `pr_url` with no lookup yet: an identity, not a state.
      return { color: "var(--color-fg-faint)", alarming: false };
  }
}
