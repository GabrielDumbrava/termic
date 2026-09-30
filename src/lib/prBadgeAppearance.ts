// What colour the PR glyph on a task row takes, and whether it is an alarm.
//
// A pure function rather than a ternary chain inside TaskPrBadge, because the
// rules here are easy to break by accident ("a draft never takes a colour",
// "nothing on this glyph is ever red") and this repo has no component-render
// setup: the choices are a real unit test on a function or a regex over the
// component's source.
//
// NO RED, anywhere, deliberately. Red on this glyph was wrong twice over. A
// failing build on an open PR is something to go and look at, not a failure of
// the task the row represents, and a closed PR is inert rather than broken.
// Both of them drew the same alarm colour the app uses for "this is broken
// right now", and a list dotted with red that you are not meant to act on is
// how you teach someone to stop seeing red at all.

/** The four states `PrStatus.state` can carry, plus "no lookup yet". */
export type PrBadgeState = "open" | "draft" | "merged" | "closed" | null;
export type PrChecks = "none" | "pending" | "passing" | "failing";

export interface PrBadgeAppearance {
  /** A CSS var reference, ready for `style={{ color }}`. */
  color: string;
  /** True only for an OPEN pr whose checks are failing: the one case worth
   *  wording differently in the tooltip. Never set for draft (its checks are
   *  nobody's business yet) or closed (not a build problem). */
  alarming: boolean;
}

export function prBadgeAppearance(state: PrBadgeState, checks: PrChecks | null): PrBadgeAppearance {
  const failing = checks === "failing";
  switch (state) {
    case "merged":
      // Done. CI at HEAD stops being the thing worth flagging.
      return { color: "var(--color-pr-merged)", alarming: false };
    case "closed":
      // Inert, not broken. It used to be --color-err, which said "something
      // needs you here" about a PR that by definition wants nothing.
      return { color: "var(--color-fg-faint)", alarming: false };
    case "draft":
      // NEVER coloured, whatever the checks say. A draft is work its author
      // has not asked anyone to look at, so its build state is not a signal to
      // anyone else yet. Grey is the whole answer: no red, and no green
      // either, because "passing" on a draft is not an invitation.
      return { color: "var(--color-fg-faint)", alarming: false };
    case "open":
      // The glyph is the only PR signal visible without opening the Git tab,
      // so a broken build must not look identical to a healthy one here. Warn,
      // not err: go and look at this, as against this is on fire.
      return failing
        ? { color: "var(--color-warn)", alarming: true }
        : { color: "var(--color-pr-open)", alarming: false };
    default:
      // A cached `pr_url` with no lookup yet: an identity, not a state.
      return { color: "var(--color-fg-faint)", alarming: false };
  }
}
