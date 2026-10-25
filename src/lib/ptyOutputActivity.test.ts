import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPtyOutputActivity, forgetPtyOutput, lastPtyOutputAt, notePtyOutput } from "./ptyOutputActivity";
import { queueLooksStalled } from "./queueStall";

afterEach(() => { forgetPtyOutput("pty-a"); forgetPtyOutput("pty-b"); });

describe("raw PTY output liveness", () => {
  it("advances independently of the UI snapshot", () => {
    const tab = { ptyId: "pty-a", lastOutputAt: 100 };
    for (let at = 101; at <= 1000; at++) notePtyOutput("pty-a", at);
    expect(tab.lastOutputAt).toBe(100);
    expect(lastPtyOutputAt(tab)).toBe(1000);
    // An explicit reset/spawn stamp must never be moved backwards.
    expect(lastPtyOutputAt({ ...tab, lastOutputAt: 1100 })).toBe(1100);
  });

  it("does not leak liveness across restarts or terminal tabs", () => {
    notePtyOutput("pty-a", 1000);
    expect(lastPtyOutputAt({ ptyId: "pty-b", lastOutputAt: 100 })).toBe(100);
    expect(lastPtyOutputAt({ lastOutputAt: null })).toBeNull();
    forgetPtyOutput("pty-a");
    expect(lastPtyOutputAt({ ptyId: "pty-a", lastOutputAt: 100 })).toBe(100);
    expect(lastPtyOutputAt({ ptyId: "pty-b" })).toBeUndefined();
  });

  it("does not release a busy queue just because queries stopped updating React", () => {
    const tab = { ptyId: "pty-a", lastOutputAt: 1000 };
    const pending = {
      hasQueued: true, workState: "working", lastQueueSendAt: 1000,
      now: 100_000, stallMs: 60_000,
    };
    expect(queueLooksStalled({ ...pending, lastOutputAt: tab.lastOutputAt })).toBe(true);
    notePtyOutput("pty-a", 99_800);
    expect(queueLooksStalled({ ...pending, lastOutputAt: lastPtyOutputAt(tab) })).toBe(false);
    expect(queueLooksStalled({ ...pending, now: 160_000, lastOutputAt: lastPtyOutputAt(tab) })).toBe(true);
  });
});

describe("PTY activity publishing", () => {
  const instances: ReturnType<typeof createPtyOutputActivity>[] = [];
  const bytes = (s: string) => new TextEncoder().encode(s);
  const query = bytes("\x1b[?6n");
  const create = (id = "pty-a") => {
    const publish = vi.fn();
    const activity = createPtyOutputActivity(id, publish);
    instances.push(activity);
    return { ...activity, publish };
  };
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); });
  afterEach(() => {
    for (const activity of instances.splice(0)) activity.dispose();
    vi.useRealTimers();
  });

  it("records 100 query chunks as live traffic with zero UI writes or timers", () => {
    const activity = create();
    const tab = { ptyId: "pty-a", lastOutputAt: 500 };
    for (let i = 0; i < 100; i++) {
      vi.advanceTimersByTime(200);
      activity.record(query);
    }
    expect(activity.publish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(lastPtyOutputAt(tab)).toBe(Date.now());
    expect(tab.lastOutputAt).toBe(500);
  });

  it("publishes ordinary and mixed output, coalescing bursts and retaining the final timestamp", () => {
    const activity = create();
    activity.record(bytes("hello\x1b[?6n"));
    expect(activity.publish.mock.calls).toEqual([[1000]]);
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(100);
      activity.record(bytes("more"));
    }
    expect(activity.publish).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(activity.publish.mock.calls).toEqual([[1000], [1400]]);
    expect(lastPtyOutputAt({ ptyId: "pty-a" })).toBe(1400);
    vi.advanceTimersByTime(1000);
    expect(activity.publish).toHaveBeenCalledTimes(2);
  });

  it("keeps the last non-query time in a pending trailer while queries advance raw liveness", () => {
    const activity = create();
    activity.record(bytes("first"));
    vi.advanceTimersByTime(100);
    activity.record(bytes("last text"));
    vi.advanceTimersByTime(100);
    activity.record(query);
    vi.advanceTimersByTime(200);
    activity.record(query);
    vi.advanceTimersByTime(100);
    expect(activity.publish.mock.calls).toEqual([[1000], [1100]]);
    expect(lastPtyOutputAt({ ptyId: "pty-a" })).toBe(1400);
    vi.advanceTimersByTime(100);
    activity.record(query);
    vi.advanceTimersByTime(1000);
    expect(activity.publish).toHaveBeenCalledTimes(2);
    expect(lastPtyOutputAt({ ptyId: "pty-a" })).toBe(1600);
  });

  it("treats incomplete query fragments conservatively as output", () => {
    const activity = create();
    activity.record(bytes("\x1b[?"));
    vi.advanceTimersByTime(100);
    activity.record(bytes("6n"));
    vi.advanceTimersByTime(400);
    expect(activity.publish.mock.calls).toEqual([[1000], [1100]]);
  });

  it("replaces an overdue trailer with fresh output without a duplicate write", () => {
    const activity = create();
    activity.record(bytes("first"));
    vi.advanceTimersByTime(100);
    activity.record(bytes("pending"));
    // A suspended webview can receive output before an overdue timer runs.
    vi.setSystemTime(2000);
    activity.record(bytes("fresh"));
    expect(activity.publish.mock.calls).toEqual([[1000], [2000]]);
    vi.advanceTimersByTime(1000);
    expect(activity.publish).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels pending writes and forgets raw liveness on exit/disposal", () => {
    const old = create();
    old.record(bytes("first"));
    vi.advanceTimersByTime(100);
    old.record(bytes("pending"));
    old.dispose();
    old.dispose();
    old.record(query); // A late event from an old listener is inert.
    const next = create("pty-b");
    next.record(bytes("new session"));
    vi.advanceTimersByTime(1000);
    expect(old.publish.mock.calls).toEqual([[1000]]);
    expect(next.publish.mock.calls).toEqual([[1100]]);
    expect(lastPtyOutputAt({ ptyId: "pty-a" })).toBeUndefined();
    expect(lastPtyOutputAt({ ptyId: "pty-b" })).toBe(1100);
    expect(vi.getTimerCount()).toBe(0);
  });
});
