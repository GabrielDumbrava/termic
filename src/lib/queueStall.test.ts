import { describe, expect, it } from "vitest";
import { queueLooksStalled, type QueueStallInput } from "./queueStall";

const NOW = 1_000_000;
const base: QueueStallInput = {
  hasQueued: true,
  workState: "working",
  lastOutputAt: NOW - 300_000,   // silent for five minutes
  lastQueueSendAt: NOW - 300_000,
  now: NOW,
  stallMs: 240_000,              // the four-minute default
};

describe("queueLooksStalled", () => {
  it("fires when a busy agent has said nothing for longer than the window", () => {
    expect(queueLooksStalled(base)).toBe(true);
  });

  it("does not fire one tick early, and does fire exactly on the boundary", () => {
    expect(queueLooksStalled({ ...base, lastOutputAt: NOW - 239_999, lastQueueSendAt: NOW - 239_999 })).toBe(false);
    expect(queueLooksStalled({ ...base, lastOutputAt: NOW - 240_000, lastQueueSendAt: NOW - 240_000 })).toBe(true);
  });

  it("is off entirely at 0", () => {
    // The pref's escape hatch: 0 restores the behaviour that shipped before.
    expect(queueLooksStalled({ ...base, stallMs: 0 })).toBe(false);
  });

  it("stays quiet while the agent is actually producing output", () => {
    // The case this must never break: a long turn that is visibly alive.
    expect(queueLooksStalled({ ...base, lastOutputAt: NOW - 1_000 })).toBe(false);
  });

  it("measures from our own submit, not from output alone", () => {
    // An agent that had been quiet for an hour before the message landed is not
    // stalled on it: the wait starts when we submit. Without this, the rule
    // would fire the instant a message was queued to a quiet-but-busy agent.
    expect(queueLooksStalled({
      ...base, lastOutputAt: NOW - 3_600_000, lastQueueSendAt: NOW - 10_000,
    })).toBe(false);
  });

  it("ignores an agent that is not working, and an empty queue", () => {
    // Both are the ordinary drain's business.
    expect(queueLooksStalled({ ...base, workState: "idle" })).toBe(false);
    expect(queueLooksStalled({ ...base, workState: null })).toBe(false);
    expect(queueLooksStalled({ ...base, hasQueued: false })).toBe(false);
  });

  it("does nothing before we have ever sent", () => {
    // No submit of ours means no turn of ours to be stuck in; the agent was
    // busy on its own account.
    expect(queueLooksStalled({ ...base, lastQueueSendAt: 0 })).toBe(false);
  });

  it("treats a PTY that has never produced output as silent since our submit", () => {
    expect(queueLooksStalled({ ...base, lastOutputAt: null })).toBe(true);
    expect(queueLooksStalled({ ...base, lastOutputAt: null, lastQueueSendAt: NOW - 10_000 })).toBe(false);
  });
});
