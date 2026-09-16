// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { useUsageUnknownDismissed } from "./usageUnknownDismissed";
import { scoped } from "@/lib/profileScope";

describe("dismissing 'Usage unknown'", () => {
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* none */ }
    useUsageUnknownDismissed.setState({ byAgent: {} });
  });

  it("is per agent entry, so a clone is dismissed on its own", () => {
    useUsageUnknownDismissed.getState().setDismissed("claude-work", true);
    expect(useUsageUnknownDismissed.getState().byAgent["claude-work"]).toBe(true);
    expect(useUsageUnknownDismissed.getState().byAgent["claude"]).toBeUndefined();
  });

  it("can be undone", () => {
    const s = useUsageUnknownDismissed.getState();
    s.setDismissed("claude", true);
    s.setDismissed("claude", false);
    expect(useUsageUnknownDismissed.getState().byAgent).toEqual({});
  });

  it("writes nothing when nothing changes", () => {
    useUsageUnknownDismissed.getState().setDismissed("claude", true);
    const before = useUsageUnknownDismissed.getState().byAgent;
    useUsageUnknownDismissed.getState().setDismissed("claude", true);
    expect(useUsageUnknownDismissed.getState().byAgent).toBe(before);
  });

  it("survives a relaunch", () => {
    useUsageUnknownDismissed.getState().setDismissed("claude-dia", true);
    expect(JSON.parse(localStorage.getItem(scoped("usageUnknownDismissed")) ?? "null")).toEqual(["claude-dia"]);
  });
});
