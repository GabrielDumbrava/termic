import type { TerminalTab } from "./types";
import { isTerminalStatusQueryOnly } from "./terminalStatusQuery";

// Raw liveness is read imperatively by readiness and queue watchdogs. It
// does not need a React notification for every cursor query from an idle TUI.
// Key by PTY, not tab, so a restart cannot inherit its previous clock.
const lastOutput = new Map<string, number>();

export function notePtyOutput(ptyId: string, at: number): void {
  lastOutput.set(ptyId, at);
}

export function lastPtyOutputAt(tab: Pick<TerminalTab, "ptyId" | "lastOutputAt">): number | null | undefined {
  const raw = tab.ptyId ? lastOutput.get(tab.ptyId) : undefined;
  return raw === undefined ? tab.lastOutputAt : Math.max(raw, tab.lastOutputAt ?? 0);
}

export function forgetPtyOutput(ptyId: string): void {
  lastOutput.delete(ptyId);
}

const PUBLISH_INTERVAL_MS = 500;

/** Per-PTY activity bookkeeping, independent of terminal rendering. Every
 * chunk advances raw liveness; only non-query output can publish a snapshot.
 * A trailer retains the last non-query time even if queries arrive meanwhile.
 * Timers and the raw clock belong to this instance and end with dispose(). */
export function createPtyOutputActivity(ptyId: string, publish: (at: number) => void) {
  let lastNonQueryAt = 0;
  let publishedAt: number | undefined;
  let trailer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const publishLatest = () => {
    trailer = undefined;
    if (disposed) return;
    publishedAt = Date.now();
    publish(lastNonQueryAt);
  };

  return {
    record(data: Uint8Array, at = Date.now()): void {
      if (disposed) return;
      notePtyOutput(ptyId, at);
      if (isTerminalStatusQueryOnly(data)) return;
      lastNonQueryAt = at;
      const elapsed = publishedAt === undefined ? PUBLISH_INTERVAL_MS : Math.max(0, at - publishedAt);
      if (elapsed >= PUBLISH_INTERVAL_MS) {
        // Hidden webviews can delay a trailer past its deadline. A fresh
        // leading write replaces it, so it cannot publish a second time.
        if (trailer !== undefined) clearTimeout(trailer);
        publishLatest();
      } else if (trailer === undefined) {
        trailer = setTimeout(publishLatest, PUBLISH_INTERVAL_MS - elapsed);
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (trailer !== undefined) clearTimeout(trailer);
      trailer = undefined;
      forgetPtyOutput(ptyId);
    },
  };
}
