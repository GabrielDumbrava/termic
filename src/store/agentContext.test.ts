import { beforeEach, describe, expect, it } from "vitest";
import { useAgentContext, contextKey } from "./agentContext";

const r = (usedTokens: number) => ({ usedTokens, windowTokens: 1000, usedPercent: usedTokens / 10 });

describe("agentContext store", () => {
  beforeEach(() => useAgentContext.setState({ byTaskAgent: {} }));

  it("keeps the reading from the tab that spoke last", () => {
    const s = useAgentContext.getState();
    s.report("t1", "claude", "tabA", r(100));
    s.report("t1", "claude", "tabB", r(900));
    expect(useAgentContext.getState().byTaskAgent[contextKey("t1", "claude")]).toMatchObject({ tabId: "tabB", usedTokens: 900 });
  });

  it("keeps tasks and agents apart", () => {
    const s = useAgentContext.getState();
    s.report("t1", "claude", "a", r(100));
    s.report("t2", "claude", "b", r(200));
    s.report("t1", "codex", "c", r(300));
    const m = useAgentContext.getState().byTaskAgent;
    expect(m[contextKey("t1", "claude")].usedTokens).toBe(100);
    expect(m[contextKey("t2", "claude")].usedTokens).toBe(200);
    expect(m[contextKey("t1", "codex")].usedTokens).toBe(300);
  });

  it("does not write an unchanged reading (bear trap 8)", () => {
    const s = useAgentContext.getState();
    s.report("t1", "claude", "a", r(100));
    const before = useAgentContext.getState().byTaskAgent;
    s.report("t1", "claude", "a", r(100));
    expect(useAgentContext.getState().byTaskAgent).toBe(before);
  });

  it("clears only when the closing tab was the source", () => {
    const s = useAgentContext.getState();
    s.report("t1", "claude", "a", r(100));
    s.clearTab("t1", "claude", "b");
    expect(useAgentContext.getState().byTaskAgent[contextKey("t1", "claude")]).toBeDefined();
    s.clearTab("t1", "claude", "a");
    expect(useAgentContext.getState().byTaskAgent[contextKey("t1", "claude")]).toBeUndefined();
  });
});
