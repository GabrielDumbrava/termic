// Agents whose "Usage unknown" label the user has dismissed.
//
// Someone who does not want agent hooks yet should not pay a footer's width
// for a label they have already read, but they should keep a way back to the
// panel that installs them. So a dismissal does not hide the chip: it shrinks
// it to a faint icon that still opens the same panel.
//
// Its own tiny store rather than a field on `prefs`: the chip subscribes to one
// boolean per agent, and a key on the big prefs store would re-run every prefs
// selector in the window on a click nobody else cares about
// (docs/performance.md bear trap 8).
//
// Per agent ENTRY id (a clone is dismissed on its own, it has its own config
// dir and its own hooks) and per profile, like the rest of the footer's
// remembered state. localStorage, so a blocked or cleared store only brings the
// label back.

import { create } from "zustand";
import { scoped } from "@/lib/profileScope";

const LS_KEY = scoped("usageUnknownDismissed");

function read(): Record<string, true> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return {};
    return Object.fromEntries(parsed.filter((v): v is string => typeof v === "string").map(id => [id, true]));
  } catch { return {}; }
}

function write(ids: Record<string, true>): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(Object.keys(ids))); } catch { /* label comes back */ }
}

interface UsageUnknownDismissedState {
  byAgent: Record<string, true>;
  setDismissed: (agentId: string, dismissed: boolean) => void;
}

export const useUsageUnknownDismissed = create<UsageUnknownDismissedState>((set, get) => ({
  byAgent: read(),
  setDismissed: (agentId, dismissed) => {
    // Bail on no change, so a double click writes nothing.
    if ((get().byAgent[agentId] === true) === dismissed) return;
    const next = { ...get().byAgent };
    if (dismissed) next[agentId] = true; else delete next[agentId];
    write(next);
    set({ byAgent: next });
  },
}));
