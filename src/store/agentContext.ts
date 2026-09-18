// How full each agent SESSION's context window is (lib/agentContext.ts).
//
// Keyed by TASK and AGENT, holding the reading from whichever of that agent's
// tabs spoke last. Not by account like usage: context belongs to one
// conversation, and two tasks on one login have nothing in common here.
//
// Not by tab either, although a reading comes from exactly one. The footer has
// one chip per agent per task, so the question it asks is "how full is the
// claude I am working with in this task", and the tab you worked in last is
// the answer. Keying by tab would make the chip pick between siblings on every
// render, which is a selector that returns a new object each time.
//
// Separate from the app store on purpose. This lands on every turn of every
// agent, and a write into the app store copies ~233 keys and re-runs every
// mounted task's selectors (docs/performance.md bear trap 8). Here a write
// wakes the handful of chips that select it.

import { create } from "zustand";
import { sameContext, type ContextReading } from "@/lib/agentContext";

export interface ContextEntry extends ContextReading {
  /** The tab that reported it, so closing THAT tab clears it and closing a
   *  sibling does not. */
  tabId: string;
  updatedAt: number;
}

/** JSON tuple for the same reason `usageKey` is one: both halves are strings a
 *  user can type (an agent entry id is user-named for a clone). */
export function contextKey(taskId: string, agentId: string): string {
  return JSON.stringify([taskId, agentId]);
}

interface AgentContextState {
  byTaskAgent: Record<string, ContextEntry>;
  report: (taskId: string, agentId: string, tabId: string, reading: ContextReading) => void;
  /** A tab went away. Drops the reading only if that tab was its source, so a
   *  sibling tab's number survives. */
  clearTab: (taskId: string, agentId: string, tabId: string) => void;
}

export const useAgentContext = create<AgentContextState>((set, get) => ({
  byTaskAgent: {},
  report: (taskId, agentId, tabId, reading) => {
    const key = contextKey(taskId, agentId);
    const cur = get().byTaskAgent[key];
    // The status line runs on every repaint of a streaming turn and most of
    // them move nothing. Bail before the write (bear trap 8).
    if (cur && cur.tabId === tabId && sameContext(cur, reading)) return;
    set(s => ({
      byTaskAgent: { ...s.byTaskAgent, [key]: { ...reading, tabId, updatedAt: Date.now() } },
    }));
  },
  clearTab: (taskId, agentId, tabId) => {
    const key = contextKey(taskId, agentId);
    if (get().byTaskAgent[key]?.tabId !== tabId) return;
    set(s => {
      const byTaskAgent = { ...s.byTaskAgent };
      delete byTaskAgent[key];
      return { byTaskAgent };
    });
  },
}));
