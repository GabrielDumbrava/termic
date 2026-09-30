import { describe, expect, it } from "vitest";
import { shouldPrompt } from "./desktopEntryPrompt";

const base = { available: true, integrated: false, alreadyAsked: false };

describe("shouldPrompt", () => {
  it("asks a Linux AppImage that has never been integrated or asked", () => {
    expect(shouldPrompt(base)).toBe(true);
  });

  it("never asks when this is not a Linux AppImage", () => {
    // macOS, Windows, a .deb, a dev build. The feature is absent there, not
    // offered and then refused.
    expect(shouldPrompt({ ...base, available: false })).toBe(false);
  });

  it("does not ask when something already integrated it", () => {
    // Us on a previous launch, or AppImageLauncher, or Gear Lever. Asking
    // would offer to do a thing that is already done.
    expect(shouldPrompt({ ...base, integrated: true })).toBe(false);
  });

  it("asks ONCE, whatever the answer was", () => {
    // The whole point. A prompt that comes back until you say yes is the
    // thing people resent; Settings owns the question after the first time.
    expect(shouldPrompt({ ...base, alreadyAsked: true })).toBe(false);
  });

  it("stays quiet when several reasons apply at once", () => {
    expect(shouldPrompt({ available: false, integrated: true, alreadyAsked: true })).toBe(false);
  });

  it("treats unavailable as decisive, even if it somehow looks integrated", () => {
    // A stale desktop file on a machine that is no longer running the
    // AppImage: there is nothing to point an Exec= at, so do not ask.
    expect(shouldPrompt({ available: false, integrated: true, alreadyAsked: false })).toBe(false);
  });
});
