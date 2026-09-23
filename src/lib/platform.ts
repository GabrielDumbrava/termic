// Which OS the webview runs on, detected once and synchronously from the
// user agent (Tauri's `platform()` is async). Kept dependency-free so the
// wire-type module (types.ts) can read it without pulling in anything else.
//
// No navigator (unit tests under node) counts as macOS, the platform every
// existing test was written against. (Unit tests under happy-dom report
// Linux; see setSeatbeltAvailableForTests.)

const UA = typeof navigator === "undefined" ? null : navigator.userAgent || "";

export const IS_MAC: boolean = UA === null || /Mac|iPhone|iPad|iPod/.test(UA);
export const IS_WINDOWS: boolean = UA !== null && /Windows/.test(UA);

/** The macOS Seatbelt sandbox exists only on macOS. Everywhere else a task
 *  offers Off and Docker, and a stored Seatbelt mode (a `.termic.yaml`
 *  committed from a Mac, a project default) reads as Off. The backend
 *  applies the same rule in `Task::effective_sandbox_mode`. */
export let SEATBELT_AVAILABLE: boolean = IS_MAC;

/** Test seam: the unit-test DOM reports Linux, so specs about Seatbelt
 *  semantics opt back in, and specs about the Windows clamp opt out. */
export function setSeatbeltAvailableForTests(v: boolean): void {
  SEATBELT_AVAILABLE = v;
}
