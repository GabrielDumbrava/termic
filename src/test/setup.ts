// Runs before every unit-test file (vitest.config.ts `setupFiles`).
//
// The suite runs under node, whose `navigator.userAgent` is neither macOS
// nor Windows, so platform detection would switch the macOS Seatbelt
// sandbox off for every spec. Specs about Seatbelt semantics were written
// against macOS; the ones about the off-macOS clamp flip it themselves.
import { setSeatbeltAvailableForTests } from "@/lib/platform";

setSeatbeltAvailableForTests(true);
