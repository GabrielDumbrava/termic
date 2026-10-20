// What each agent is actually emitting, retained so Settings can show it.
//
// Every OSC 0/2 title already flows through TerminalPane's `onTitleChange`,
// gets classified, and is then dropped (only the newest survives, as the tab's
// `liveTitle`). That's the reason writing a custom agent's work-done signals is
// guesswork: the strings you need to match go past the exact point where you
// need to see them. This keeps a small ring of them.
//
// DELIBERATELY NOT a Zustand store. Claude's spinner repaints its title ~10x a
// second per live terminal; routing that through React state would re-render
// subscribers at spinner rate, and "an unnecessary sidebar re-render is a real
// regression" (CLAUDE.md). So: plain module state, mutated freely on the hot
// path, with a THROTTLED notification that only fires while something is
// actually watching (i.e. the Settings panel is open). When nobody subscribes,
// recording costs a Map lookup and a counter bump.

import type { SignalClass } from "./signalProposer";
import {
  HOOK_OSC_BODY, HOOK_OSC_DELEGATED_PREFIX, HOOK_OSC_DONE_BODY, HOOK_OSC_READY_BODY,
  HOOK_OSC_SESSION_PREFIX, HOOK_OSC_WORKING_BODY,
} from "./agentHooks";

/** One distinct title, with how often and how recently it was seen. A
 *  frequency table rather than a log: at spinner rate a chronological list is
 *  unreadable within seconds, and the counts are what tell you which strings
 *  matter. */
export interface TitleObservation {
  title: string;
  seen: number;
  firstAt: number;
  lastAt: number;
  /** How the live classifier read it. `null` = matched nothing, which is
   *  exactly the set a user needs to see to write new patterns. */
  classified: SignalClass | null;
  /** True if seen inside an active capture window. */
  captured?: boolean;
  /** Class inferred by the capture from turn boundaries, independent of
   *  `classified` (which is what the CURRENT patterns say, and is null for the
   *  agent you're trying to teach). */
  capturedAs?: SignalClass;
}

/** Distinct titles kept per agent. Past this the least-recently-seen is
 *  evicted. Generous enough to hold a full spinner wheel plus the idle and
 *  attention titles, small enough to stay a glance rather than a scroll. */
const MAX_PER_AGENT = 60;

/** Coalesce notifications. The UI wants "roughly live", not every frame. */
const NOTIFY_MS = 250;

interface CaptureState {
  agentId: string;
  startedAt: number;
  /** Set once the user submits, so titles from before the prompt (startup
   *  banners, leftover spinners) are never labelled busy. */
  submittedAt: number | null;
  endedAt: number | null;
}

const log = new Map<string, Map<string, TitleObservation>>();

/** What termic makes of a trusted hook body: the signal it is routed to
 *  (docs/agent-states.md "What the agent can say"), or `other` for a body
 *  nothing recognises, which is itself the finding. */
export type HookSignal = "working" | "done" | "delegated" | "attention" | "ready" | "session" | "usage" | "context" | "other";

export function hookSignal(body: string): HookSignal {
  if (body === HOOK_OSC_WORKING_BODY) return "working";
  if (body === HOOK_OSC_DONE_BODY) return "done";
  if (body === HOOK_OSC_READY_BODY) return "ready";
  if (body.startsWith(HOOK_OSC_DELEGATED_PREFIX)) return "delegated";
  // "agent needs your input" and "agent needs your permission: <tool>".
  if (body.startsWith(HOOK_OSC_BODY.slice(0, "agent needs your".length))) return "attention";
  if (body.startsWith(HOOK_OSC_SESSION_PREFIX)) return "session";
  if (body.startsWith("usage ")) return "usage";
  if (body.startsWith("ctx ")) return "context";
  return "other";
}

/** One hook report as it arrived: the trusted OSC 777 body, verbatim, and
 *  the tab it arrived on. */
export interface HookObservation { at: number; body: string; signal: HookSignal; tabId: string; tabLabel: string }

/** Hook reports kept per agent, grouped by TAB. A LOG, unlike the titles
 *  above: hooks arrive a few times a turn, not at spinner rate, and the order
 *  is the diagnosis ("working at 10:50, then only usage heartbeats" is how a
 *  tab parked on a usage limit reads). Per tab, not per agent, so a chatty
 *  tab's heartbeats cannot evict the quiet tab the question is about. */
const MAX_HOOKS_PER_TAB = 30;
const MAX_TABS_PER_AGENT = 12;
const hooks = new Map<string, Map<string, HookObservation[]>>();
let capture: CaptureState | null = null;
const listeners = new Set<() => void>();
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let version = 0;

/** Snapshot for `useSyncExternalStore`. A plain counter so a component can
 *  subscribe WITHOUT this module holding a permanent listener — with one, the
 *  throttle timer below would keep rearming for the life of the app every time
 *  a spinner repainted, which is the exact cost this design exists to avoid. */
export function getSignalLogVersion(): number {
  return version;
}

function notify() {
  version++;
  if (listeners.size === 0 || notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    for (const l of listeners) l();
  }, NOTIFY_MS);
}

/** Subscribe to buffer changes. Returns an unsubscribe. */
export function subscribeSignalLog(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && notifyTimer) {
      clearTimeout(notifyTimer);
      notifyTimer = null;
    }
  };
}

/**
 * Record a title observed for `agentId`.
 *
 * `classified` is what the CURRENT patterns make of it, which for an agent
 * with no signals yet is always null. That's fine and is the point: the
 * unmatched rows are the ones worth turning into patterns.
 *
 * Called on the terminal hot path — keep it allocation-light.
 */
export function recordTitle(
  agentId: string,
  rawTitle: string,
  classified: SignalClass | null,
  now = Date.now(),
): void {
  const title = rawTitle.trim();
  if (!agentId || !title) return;

  let byTitle = log.get(agentId);
  if (!byTitle) {
    byTitle = new Map();
    log.set(agentId, byTitle);
  }

  const inCapture =
    capture !== null && capture.agentId === agentId && capture.endedAt === null;
  // Only label busy AFTER a submit. A spinner painted while the CLI boots
  // looks identical to one painted while it works, and mislabelling startup
  // noise as busy is how you get a pattern that never lets the agent go idle.
  const capturedAs: SignalClass | undefined = inCapture
    ? capture!.submittedAt !== null
      ? "busy"
      : undefined
    : undefined;

  const existing = byTitle.get(title);
  if (existing) {
    existing.seen++;
    existing.lastAt = now;
    existing.classified = classified;
    if (inCapture) {
      existing.captured = true;
      // Never downgrade a label: a title seen both before and after the submit
      // keeps the more specific one.
      if (capturedAs && !existing.capturedAs) existing.capturedAs = capturedAs;
    }
    // Re-insert so Map iteration order stays least-recent-first for eviction.
    byTitle.delete(title);
    byTitle.set(title, existing);
  } else {
    byTitle.set(title, {
      title,
      seen: 1,
      firstAt: now,
      lastAt: now,
      classified,
      ...(inCapture ? { captured: true } : {}),
      ...(capturedAs ? { capturedAs } : {}),
    });
    if (byTitle.size > MAX_PER_AGENT) {
      const oldest = byTitle.keys().next().value;
      if (oldest !== undefined) byTitle.delete(oldest);
    }
  }
  notify();
}

/** Record a trusted hook body for `agentId`. Hot path for the heartbeat, so
 *  one push and one shift at most. */
export function recordHook(agentId: string, body: string, tabId: string, tabLabel: string, now = Date.now()): void {
  if (!agentId || !body) return;
  let byTab = hooks.get(agentId);
  if (!byTab) {
    byTab = new Map();
    hooks.set(agentId, byTab);
  }
  let list = byTab.get(tabId);
  if (!list) {
    list = [];
    byTab.set(tabId, list);
    if (byTab.size > MAX_TABS_PER_AGENT) {
      const oldest = byTab.keys().next().value;
      if (oldest !== undefined) byTab.delete(oldest);
    }
  } else {
    // Re-insert so Map order is least-recently-active first for eviction.
    byTab.delete(tabId);
    byTab.set(tabId, list);
  }
  list.push({ at: now, body, signal: hookSignal(body), tabId, tabLabel });
  if (list.length > MAX_HOOKS_PER_TAB) list.shift();
  notify();
}

/** Hook reports for one agent: one group per tab, most recently active tab
 *  first, rows newest first. */
export function hooksFor(agentId: string): { tabId: string; tabLabel: string; rows: HookObservation[] }[] {
  return [...(hooks.get(agentId)?.values() ?? [])].reverse()
    .map(list => ({ tabId: list[list.length - 1].tabId, tabLabel: list[list.length - 1].tabLabel, rows: [...list].reverse() }));
}

/** The whole list as text, for an issue. */
export function hooksAsText(agentId: string): string {
  const hhmmss = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false });
  return hooksFor(agentId)
    .map(g => [g.tabLabel, ...g.rows.map(r => `  ${hhmmss(r.at)}  ${r.signal.padEnd(9)}  ${r.body}`)].join("\n"))
    .join("\n\n");
}

/** The user pressed Enter in a terminal running `agentId`. Starts the labelled
 *  half of a capture: from here, titles are busy candidates. */
export function noteSubmit(agentId: string, now = Date.now()): void {
  if (capture && capture.agentId === agentId && capture.endedAt === null
      && capture.submittedAt === null) {
    capture.submittedAt = now;
    notify();
  }
}

/**
 * A turn finished for `agentId` (TerminalPane's `fireDone`).
 *
 * The title standing at that moment is the idle candidate. Note the bootstrap:
 * for an agent with no signals configured, "done" here came from the fallback
 * heuristics (byte-quiet 4 s, scrollback-stable 9 s). Those are too coarse to
 * drive a live spinner but perfectly good for labelling an offline sample,
 * which is what lets a capture teach an agent that currently signals nothing.
 */
export function noteDone(agentId: string, restingTitle: string | null, now = Date.now()): void {
  if (!capture || capture.agentId !== agentId || capture.endedAt !== null) return;
  // A "done" before any submit is startup settling, not the end of a turn.
  if (capture.submittedAt === null) return;

  const title = restingTitle?.trim();
  if (title) {
    const entry = log.get(agentId)?.get(title);
    // The resting title outranks the busy label it may have picked up while
    // the turn was still running: it's the one left standing at the end.
    if (entry) entry.capturedAs = "idle";
  }
  capture.endedAt = now;
  notify();
}

export function startCapture(agentId: string, now = Date.now()): void {
  // A capture is about THIS turn, so clear prior labels for the agent. The
  // observations themselves stay: the frequency table is still useful.
  for (const o of log.get(agentId)?.values() ?? []) {
    o.captured = false;
    o.capturedAs = undefined;
  }
  capture = { agentId, startedAt: now, submittedAt: null, endedAt: null };
  notify();
}

export function stopCapture(now = Date.now()): void {
  if (capture && capture.endedAt === null) capture.endedAt = now;
  notify();
}

export function clearCapture(): void {
  capture = null;
  notify();
}

export type CapturePhase = "off" | "waiting-for-submit" | "recording" | "done";

export function capturePhase(agentId: string): CapturePhase {
  if (!capture || capture.agentId !== agentId) return "off";
  if (capture.endedAt !== null) return "done";
  return capture.submittedAt === null ? "waiting-for-submit" : "recording";
}

/** Observations for one agent, most-recently-seen first. */
export function observationsFor(agentId: string): TitleObservation[] {
  return [...(log.get(agentId)?.values() ?? [])].sort((a, b) => b.lastAt - a.lastAt);
}

/** Samples grouped for `proposeSignals`, from the current capture only. */
export function captureSamples(agentId: string): { busy: string[]; idle: string[] } {
  const busy: string[] = [];
  const idle: string[] = [];
  for (const o of log.get(agentId)?.values() ?? []) {
    if (!o.captured) continue;
    if (o.capturedAs === "busy") busy.push(o.title);
    else if (o.capturedAs === "idle") idle.push(o.title);
  }
  return { busy, idle };
}

/** Test seam + a way for the UI to drop a noisy history. */
export function resetSignalLog(agentId?: string): void {
  if (agentId) { log.delete(agentId); hooks.delete(agentId); }
  else { log.clear(); hooks.clear(); }
  capture = null;
  notify();
}
