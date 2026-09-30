// The one-time "add Termic to your applications menu?" ask, Linux AppImage
// only.
//
// It is a prompt and not a silent write on purpose. Integrating means putting
// files in someone's `~/.local/share`, which is theirs; doing that uninvited
// is the kind of thing a packaged app gets complained about for. So: ask once,
// take no for an answer permanently, and leave the same action in Settings →
// General for anyone who says no now and wants it later.
//
// Asked ONCE, ever, recorded in localStorage. Not "once per launch" and not
// "until they say yes": a prompt that returns is the thing people actually
// resent, and Settings is where an unanswered question belongs after the
// first time.

import { desktopIntegrationStatus, desktopIntegrationAdd } from "@/lib/ipc";
import { useUI } from "@/store/ui";
import { i18n } from "@/lib/i18n";

const LS_ASKED = "desktopEntryPrompted";

function asked(): boolean {
  try { return localStorage.getItem(LS_ASKED) === "1"; } catch { return false; }
}
function markAsked() {
  try { localStorage.setItem(LS_ASKED, "1"); } catch { /* private mode */ }
}

/** Decide whether to ask, without any of the IO. Exported for the test: the
 *  rule is four conditions and every one of them has a way of being wrong. */
export function shouldPrompt(i: {
  available: boolean;
  integrated: boolean;
  alreadyAsked: boolean;
}): boolean {
  if (!i.available) return false;   // not a Linux AppImage
  if (i.integrated) return false;   // already done, by us or by Gear Lever
  if (i.alreadyAsked) return false; // answered once; Settings owns it now
  return true;
}

/** Ask once, on startup. Safe to call on every platform and every launch:
 *  everything that makes it a no-op is checked here rather than by the caller.
 *
 *  Deliberately fire-and-forget. A failure to read the status, or to write the
 *  entry, must not hold up or break app startup: the worst case is that the
 *  user does it from Settings instead. */
export async function maybePromptDesktopEntry(): Promise<void> {
  if (asked()) return;
  let st;
  try { st = await desktopIntegrationStatus(); } catch { return; }
  if (!shouldPrompt({ available: st.available, integrated: st.integrated, alreadyAsked: false })) return;

  // Recorded BEFORE the answer, not after. If the app is closed while the
  // dialog stands, or the write throws, the question has still been put to
  // this person and re-asking on the next launch is the behaviour this exists
  // to avoid.
  markAsked();

  const ok = await useUI.getState().askConfirm({
    title: i18n.t("dialogs:desktopEntry.title"),
    message: i18n.t("dialogs:desktopEntry.message", { path: st.desktop_path }),
    confirmLabel: i18n.t("dialogs:desktopEntry.confirm"),
    cancelLabel: i18n.t("dialogs:desktopEntry.cancel"),
    checkbox: undefined,
  });
  if (!ok) return;

  try {
    await desktopIntegrationAdd();
    useUI.getState().pushToast(i18n.t("dialogs:desktopEntry.done"), "success");
  } catch (e) {
    useUI.getState().pushToast(i18n.t("dialogs:desktopEntry.failed", { error: String(e) }), "error");
  }
}
