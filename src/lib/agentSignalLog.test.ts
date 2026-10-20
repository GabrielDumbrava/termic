import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  capturePhase,
  captureSamples,
  clearCapture,
  noteDone,
  noteSubmit,
  hookSignal,
  hooksAsText,
  hooksFor,
  observationsFor,
  recordHook,
  recordTitle,
  resetSignalLog,
  startCapture,
  stopCapture,
  subscribeSignalLog,
} from "./agentSignalLog";
import { proposeSignals } from "./signalProposer";

beforeEach(() => resetSignalLog());

describe("recordHook", () => {
  it("keeps the last 30 reports PER TAB, newest first, most recently active tab first", () => {
    // A chatty tab's heartbeats must not evict the quiet tab the question is
    // about, which is what one list per agent did.
    recordHook("x", "agent working", "quiet", "t / claude", 1);
    for (let i = 0; i < 40; i++) recordHook("x", `ctx ${i} 1000`, "chatty", "t2 / claude", 10 + i);
    const groups = hooksFor("x");
    expect(groups.map(g => g.tabId)).toEqual(["chatty", "quiet"]);
    expect(groups[0].rows).toHaveLength(30);
    expect(groups[0].rows[0].body).toBe("ctx 39 1000");
    expect(groups[0].rows[29].body).toBe("ctx 10 1000");
    expect(groups[1].rows).toEqual([{ at: 1, body: "agent working", signal: "working", tabId: "quiet", tabLabel: "t / claude" }]);
    expect(hooksAsText("x")).toContain("t / claude\n");
    expect(hooksAsText("x")).toMatch(/working\s+agent working/);
    resetSignalLog("x");
    expect(hooksFor("x")).toEqual([]);
  });

  it("says what termic made of each body, and flags one it did not recognise", () => {
    expect(hookSignal("agent working")).toBe("working");
    expect(hookSignal("agent done")).toBe("done");
    expect(hookSignal("agent delegated: 1 subagent a1")).toBe("delegated");
    expect(hookSignal("agent needs your permission: Bash")).toBe("attention");
    expect(hookSignal("agent needs your input")).toBe("attention");
    expect(hookSignal("agent ready for input")).toBe("ready");
    expect(hookSignal("session 1234")).toBe("session");
    expect(hookSignal("usage 100 18 1 2 0")).toBe("usage");
    expect(hookSignal("ctx 98334 1000000")).toBe("context");
    expect(hookSignal("agent working harder")).toBe("other");
  });
});

describe("recordTitle", () => {
  it("counts repeats instead of appending a row per frame", () => {
    // A spinner repaints ~10x/s. A log would be unreadable; the counts are the
    // useful part.
    for (let i = 0; i < 50; i++) recordTitle("x", "⠋ Working", null);
    recordTitle("x", "✳ Ready", null);

    const obs = observationsFor("x");
    expect(obs).toHaveLength(2);
    expect(obs.find(o => o.title === "⠋ Working")!.seen).toBe(50);
  });

  it("trims, and ignores blank titles and missing agent ids", () => {
    recordTitle("x", "  padded  ", null);
    recordTitle("x", "   ", null);
    recordTitle("", "orphan", null);
    expect(observationsFor("x").map(o => o.title)).toEqual(["padded"]);
  });

  it("retains UNMATCHED titles, which are the ones worth patterning", () => {
    recordTitle("x", "Compiling…", null);
    expect(observationsFor("x")[0].classified).toBeNull();
  });

  it("keeps agents separate", () => {
    recordTitle("a", "one", null);
    recordTitle("b", "two", null);
    expect(observationsFor("a").map(o => o.title)).toEqual(["one"]);
    expect(observationsFor("b").map(o => o.title)).toEqual(["two"]);
  });

  it("evicts the least-recently-seen past the cap, keeping the live ones", () => {
    for (let i = 0; i < 80; i++) recordTitle("x", `t${i}`, null, 1000 + i);
    // Re-touch an early title so it is no longer least-recent.
    recordTitle("x", "t5", null, 99_000);
    for (let i = 80; i < 100; i++) recordTitle("x", `t${i}`, null, 100_000 + i);

    const titles = observationsFor("x").map(o => o.title);
    expect(titles.length).toBeLessThanOrEqual(60);
    expect(titles).toContain("t5");     // recently touched, survives
    expect(titles).toContain("t99");    // newest
    expect(titles).not.toContain("t0"); // coldest, evicted
  });

  it("orders most-recently-seen first", () => {
    recordTitle("x", "old", null, 1000);
    recordTitle("x", "new", null, 2000);
    expect(observationsFor("x").map(o => o.title)).toEqual(["new", "old"]);
  });
});

describe("capture labelling", () => {
  it("walks through its phases", () => {
    expect(capturePhase("x")).toBe("off");
    startCapture("x");
    expect(capturePhase("x")).toBe("waiting-for-submit");
    noteSubmit("x");
    expect(capturePhase("x")).toBe("recording");
    noteDone("x", "✳ Ready");
    expect(capturePhase("x")).toBe("done");
  });

  it("is scoped to the agent being captured", () => {
    startCapture("x");
    expect(capturePhase("other")).toBe("off");
    noteSubmit("other");
    expect(capturePhase("x")).toBe("waiting-for-submit"); // not advanced
  });

  // The single most important rule here. A CLI paints a spinner while it
  // boots, identical to the one it paints while working. Labelling startup
  // noise as busy yields a pattern that matches at rest, and since precedence
  // is busy > idle the agent would then never report done.
  it("does not label anything busy before the user submits", () => {
    startCapture("x");
    recordTitle("x", "⠋ starting up", null);
    expect(captureSamples("x").busy).toEqual([]);

    noteSubmit("x");
    recordTitle("x", "⠙ working", null);
    expect(captureSamples("x").busy).toEqual(["⠙ working"]);
  });

  it("labels the resting title idle, even after it was seen while busy", () => {
    startCapture("x");
    noteSubmit("x");
    recordTitle("x", "⠋ w", null);
    recordTitle("x", "✳ Ready", null); // repainted mid-turn too
    noteDone("x", "✳ Ready");

    const s = captureSamples("x");
    expect(s.idle).toEqual(["✳ Ready"]);
    expect(s.busy).toEqual(["⠋ w"]);
  });

  it("ignores a done that arrives before any submit", () => {
    // Startup settling is not the end of a turn.
    startCapture("x");
    recordTitle("x", "✳ Ready", null);
    noteDone("x", "✳ Ready");
    expect(capturePhase("x")).toBe("waiting-for-submit");
    expect(captureSamples("x").idle).toEqual([]);
  });

  it("stops recording once the turn ends", () => {
    startCapture("x");
    noteSubmit("x");
    recordTitle("x", "⠋ w", null);
    noteDone("x", "done");
    recordTitle("x", "later noise", null);
    expect(captureSamples("x").busy).toEqual(["⠋ w"]);
  });

  it("stopCapture ends it without a resting title", () => {
    startCapture("x");
    noteSubmit("x");
    recordTitle("x", "⠋ w", null);
    stopCapture();
    expect(capturePhase("x")).toBe("done");
    expect(captureSamples("x")).toEqual({ busy: ["⠋ w"], idle: [] });
  });

  it("a fresh capture clears prior labels but keeps the observations", () => {
    startCapture("x");
    noteSubmit("x");
    recordTitle("x", "⠋ w", null);
    noteDone("x", "✳ Ready");
    expect(captureSamples("x").busy).toHaveLength(1);

    startCapture("x");
    expect(captureSamples("x")).toEqual({ busy: [], idle: [] });
    expect(observationsFor("x").length).toBeGreaterThan(0);
  });

  it("records nothing as captured when no capture is running", () => {
    recordTitle("x", "⠋ w", null);
    expect(captureSamples("x")).toEqual({ busy: [], idle: [] });
  });

  it("clearCapture drops the session", () => {
    startCapture("x");
    clearCapture();
    expect(capturePhase("x")).toBe("off");
  });
});

// End to end: a capture of an agent that signals NOTHING (so every title is
// classified null) still teaches termic usable patterns. This is the whole
// feature in one test.
describe("capture → propose", () => {
  it("turns a real claude-shaped turn into working patterns", () => {
    startCapture("mycli");
    recordTitle("mycli", "✳ my-task", null); // at rest before the prompt
    noteSubmit("mycli");
    for (const g of ["⠋", "⠙", "⠹", "⠸"]) {
      for (let i = 0; i < 12; i++) recordTitle("mycli", `${g} my-task`, null);
    }
    recordTitle("mycli", "✳ my-task", null);
    noteDone("mycli", "✳ my-task");

    const out = proposeSignals(captureSamples("mycli"));
    const busy = out.busy.map(p => new RegExp(p.pattern));
    const idle = out.idle.map(p => new RegExp(p.pattern));

    // Busy matches every spinner frame and NOT the resting title.
    for (const g of ["⠋", "⠙", "⠹", "⠸", "⠼"]) {
      expect(busy.some(re => re.test(`${g} my-task`))).toBe(true);
    }
    expect(busy.some(re => re.test("✳ my-task"))).toBe(false);
    expect(idle.some(re => re.test("✳ my-task"))).toBe(true);
  });
});

describe("subscribers", () => {
  it("coalesces the spinner-rate firehose into one notification", async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const off = subscribeSignalLog(fn);

    for (let i = 0; i < 200; i++) recordTitle("x", `frame-${i % 10}`, null);
    expect(fn).not.toHaveBeenCalled(); // throttled, nothing synchronous
    await vi.advanceTimersByTimeAsync(300);
    expect(fn).toHaveBeenCalledTimes(1);

    off();
    for (let i = 0; i < 50; i++) recordTitle("x", "after", null);
    await vi.advanceTimersByTimeAsync(300);
    expect(fn).toHaveBeenCalledTimes(1); // unsubscribed, never again
    vi.useRealTimers();
  });

  it("records without a subscriber and shows up when one arrives", async () => {
    vi.useFakeTimers();
    recordTitle("x", "seen-while-nobody-watched", null);
    const fn = vi.fn();
    const off = subscribeSignalLog(fn);
    expect(observationsFor("x")).toHaveLength(1);
    off();
    vi.useRealTimers();
  });
});
