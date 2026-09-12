import { describe, it, expect } from "vitest";
import {
  taskNeedsAttention, taskWorkDone, taskWorking, taskWorkBadge,
} from "@/lib/taskWorkState";
import type { Tab } from "@/lib/types";

// Only type / workState / unread matter to the helpers.
const term = (over: Partial<Tab> = {}): Tab =>
  ({ id: "t", type: "terminal", ...over } as Tab);
const edit = (over: Partial<Tab> = {}): Tab =>
  ({ id: "e", type: "edit", ...over } as Tab);

const ON = { settledHighlight: true, workingIndicator: true };

describe("the three predicates", () => {
  it("reads attention, done and working off terminal tabs", () => {
    expect(taskNeedsAttention([term({ unread: { reason: "attention" } })], ON)).toBe(true);
    expect(taskWorkDone([term({ workState: "done" })], ON)).toBe(true);
    expect(taskWorking([term({ workState: "working" })], ON)).toBe(true);
  });

  it("ignores non-terminal tabs", () => {
    expect(taskNeedsAttention([edit({ unread: { reason: "attention" } })], ON)).toBe(false);
    expect(taskWorkDone([edit({ workState: "done" } as Partial<Tab>)], ON)).toBe(false);
  });

  it("ignores unread reasons that are not attention", () => {
    // bell / idle / exit / done feed the OS-notification path only; the
    // sidebar bell is attention alone.
    for (const reason of ["bell", "idle", "exit", "done"] as const) {
      expect(taskNeedsAttention([term({ unread: { reason } })], ON)).toBe(false);
    }
  });

  it("is false on an empty tab list", () => {
    expect(taskWorkBadge([], ON)).toBe(null);
  });
});

describe("the pref gates", () => {
  it("settledHighlight off silences attention AND done", () => {
    const tabs = [term({ unread: { reason: "attention" }, workState: "done" })];
    const p = { settledHighlight: false, workingIndicator: true };
    expect(taskNeedsAttention(tabs, p)).toBe(false);
    expect(taskWorkDone(tabs, p)).toBe(false);
  });

  it("workingIndicator off silences only the spinner", () => {
    const p = { settledHighlight: true, workingIndicator: false };
    expect(taskWorking([term({ workState: "working" })], p)).toBe(false);
    expect(taskWorkDone([term({ workState: "done" })], p)).toBe(true);
  });

  it("treats an absent workingIndicator as off", () => {
    // The sidebar's rollup dots pass `{ settledHighlight }` alone rather than
    // subscribing to a pref they never use.
    expect(taskWorking([term({ workState: "working" })], { settledHighlight: true })).toBe(false);
    expect(taskWorkDone([term({ workState: "done" })], { settledHighlight: true })).toBe(true);
  });

  it("both prefs off draws nothing at all", () => {
    const tabs = [term({ unread: { reason: "attention" }, workState: "working" })];
    expect(taskWorkBadge(tabs, { settledHighlight: false, workingIndicator: false })).toBe(null);
  });
});

describe("taskWorkBadge precedence", () => {
  it("attention outranks done and working", () => {
    expect(taskWorkBadge([
      term({ id: "a", unread: { reason: "attention" } }),
      term({ id: "b", workState: "done" }),
      term({ id: "c", workState: "working" }),
    ], ON)).toBe("attention");
  });

  it("done outranks working", () => {
    expect(taskWorkBadge([
      term({ id: "b", workState: "done" }),
      term({ id: "c", workState: "working" }),
    ], ON)).toBe("done");
  });

  it("falls through to working when it is the only signal", () => {
    expect(taskWorkBadge([term({ workState: "working" })], ON)).toBe("working");
  });

  it("aggregates ACROSS tabs, not per tab", () => {
    // The badge is the task's, so a bell on one tab and a spinner on another
    // resolves to the bell rather than to whichever tab is first.
    expect(taskWorkBadge([
      term({ id: "a", workState: "working" }),
      term({ id: "b", unread: { reason: "attention" } }),
    ], ON)).toBe("attention");
  });

  it("skips a silenced higher rank instead of drawing nothing", () => {
    // settledHighlight off removes attention and done from contention, so a
    // working agent still gets its spinner.
    expect(taskWorkBadge([
      term({ id: "a", unread: { reason: "attention" } }),
      term({ id: "b", workState: "working" }),
    ], { settledHighlight: false, workingIndicator: true })).toBe("working");
  });
});
