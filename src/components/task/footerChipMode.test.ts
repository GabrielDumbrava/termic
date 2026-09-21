import { describe, it, expect } from "vitest";
import { footerChipMode, FULL_CHIP_AGENT_LIMIT } from "@/components/task/footerChipMode";

// The task footer sheds width in a fixed order as a task gains agents, and the
// order is the point: detail goes before agents do. Reported with five agents
// in one task, where the old single rule (hide a secondary chip below 780px,
// a width measured for TWO agents) never fired and the group ran off the end
// of the bar and under the right panel.

const ids = (n: number) => Array.from({ length: n }, (_, i) => `agent${i}`);

describe("footerChipMode", () => {
  it("leaves a single-agent task alone: nothing to choose between", () => {
    expect(footerChipMode(["claude"], "claude", "claude")).toEqual({ secondary: false, compact: false });
  });

  it("never compacts or demotes the agent whose tab is on screen", () => {
    for (const n of [2, 3, 5, 9]) {
      const all = ids(n);
      expect(footerChipMode(all, all[2] ?? all[0], all[2] ?? all[0]))
        .toEqual({ secondary: false, compact: false });
    }
  });

  it("marks the others secondary but keeps their full chip at two agents", () => {
    const all = ids(2);
    expect(footerChipMode(all, all[0], all[1])).toEqual({ secondary: true, compact: false });
  });

  it("compacts secondary chips once a task runs more than the full-chip limit", () => {
    const all = ids(FULL_CHIP_AGENT_LIMIT + 1);
    const modes = all.map(id => footerChipMode(all, all[0], id));
    expect(modes[0]).toEqual({ secondary: false, compact: false });
    expect(modes.slice(1).every(m => m.secondary && m.compact)).toBe(true);
  });

  it("keeps compacting however many agents the task gains", () => {
    const all = ids(9);
    const compacted = all.filter(id => footerChipMode(all, all[0], id).compact);
    expect(compacted).toHaveLength(8);
  });

  it("compacts every chip when the active agent is not among them", () => {
    // Possible mid-switch: the active tab's cli is gone from the list for a
    // render. Every chip is then secondary, which must not throw or promote
    // an arbitrary one.
    const all = ids(4);
    const modes = all.map(id => footerChipMode(all, undefined, id));
    expect(modes.every(m => m.secondary && m.compact)).toBe(true);
  });
});
