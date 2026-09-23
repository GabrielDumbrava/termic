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

/** Window-drag regions, macOS only.
 *
 *  On macOS the title bar is hidden (an overlay title bar with traffic
 *  lights), so the app's own bar, and a dialog's backdrop, have to move the
 *  window. Windows keeps its native title bar, so none of that is needed,
 *  and it would do harm: WebView2 honours `-webkit-app-region: drag` (wry
 *  enables non-client region support), which turns every covered element
 *  into window caption, and a dialog's full-screen backdrop would swallow
 *  every click in the dialog. Spread `dragRegion()` where the macOS build
 *  wants a drag surface, `noDragRegion()` where it carves one out. */
export function dragRegion(): { "data-tauri-drag-region"?: boolean; style?: Record<string, string> } {
  return IS_MAC ? { "data-tauri-drag-region": true, style: { WebkitAppRegion: "drag" } } : {};
}

export function appRegionStyle(v: "drag" | "no-drag"): Record<string, string> {
  return IS_MAC ? { WebkitAppRegion: v } : {};
}

/** The one-line install command to show for a CLI the app looks for: Homebrew
 *  on macOS (and Linux, where it is the common cross-distro answer), winget
 *  on Windows, where Homebrew does not exist. */
export function installCommand(tool: string): string {
  if (!IS_WINDOWS) return `brew install ${tool}`;
  const winget: Record<string, string> = { gh: "GitHub.cli", glab: "GLab.GLab" };
  return `winget install ${winget[tool] ?? tool}`;
}
