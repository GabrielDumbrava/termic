import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const calls: string[] = [];
let answer: (id: string) => Promise<{ files_changed: number; insertions: number; deletions: number; untracked: number }>;

vi.mock("@/lib/ipc", () => ({
  taskDiffStat: (id: string) => { calls.push(id); return answer(id); },
}));

const { useDiffStat, resetDiffStats, isStale, DIFF_STALE_MS, MAX_PER_FLUSH } =
  await import("./diffStat");

const stat = (n: number) => ({ files_changed: n, insertions: n, deletions: 0, untracked: 0 });
const settle = () => vi.waitFor(() => expect(useDiffStat.getState().byTask).toBeTruthy());

beforeEach(() => {
  calls.length = 0;
  answer = async () => stat(1);
  resetDiffStats();
});
afterEach(() => { vi.useRealTimers(); });

describe("diffStat store", () => {
  it("measures a task once and serves the cached answer after that", async () => {
    useDiffStat.getState().request("t1");
    await vi.waitFor(() => expect(useDiffStat.getState().byTask.t1?.stat).toEqual(stat(1)));
    useDiffStat.getState().request("t1");
    useDiffStat.getState().request("t1");
    await settle();
    expect(calls).toEqual(["t1"]);
  });

  it("measures again once the answer has gone stale", async () => {
    useDiffStat.getState().request("t1");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // Age the entry rather than waiting out the real floor.
    useDiffStat.setState(s => ({
      byTask: { ...s.byTask, t1: { ...s.byTask.t1, fetchedAt: Date.now() - DIFF_STALE_MS - 1 } },
    }));
    useDiffStat.getState().request("t1");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
  });

  it("never runs two measurements for one task at a time", async () => {
    // Two cards for the same task, or a re-render mid-flight. Each measurement
    // is two git processes per repo, so overlapping them is the thing to avoid.
    let release!: () => void;
    answer = () => new Promise(res => { release = () => res(stat(3)); });
    useDiffStat.getState().request("t1");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    useDiffStat.getState().request("t1");
    useDiffStat.getState().request("t1");
    expect(calls).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(useDiffStat.getState().byTask.t1?.loading).toBe(false));
  });

  it("caps one flush and takes the oldest snapshots first", async () => {
    const ids = Array.from({ length: MAX_PER_FLUSH + 3 }, (_, i) => `t${i}`);
    // Seed every id with a stale entry, ascending fetchedAt, so the order the
    // cap keeps is knowable rather than incidental.
    useDiffStat.setState({
      byTask: Object.fromEntries(ids.map((id, i) => [
        id, { stat: null, loading: false, fetchedAt: 1_000 + i, error: null },
      ])),
    });
    useDiffStat.getState().requestMany(ids);
    await vi.waitFor(() => expect(calls).toHaveLength(MAX_PER_FLUSH));
    // The oldest MAX_PER_FLUSH, not the first MAX_PER_FLUSH of the argument.
    expect(new Set(calls)).toEqual(new Set(ids.slice(0, MAX_PER_FLUSH)));
  });

  it("skips ids that are already fresh, so a big board still makes progress", async () => {
    useDiffStat.setState({
      byTask: {
        fresh: { stat: stat(9), loading: false, fetchedAt: Date.now(), error: null },
      },
    });
    useDiffStat.getState().requestMany(["fresh", "stale"]);
    await vi.waitFor(() => expect(calls).toEqual(["stale"]));
  });

  it("keeps the last good numbers when a refresh fails", async () => {
    // A card showing +40 must not blank because one measurement lost a race
    // with an archive. "No changes" and "could not work it out" are different
    // answers and only one of them is a number.
    useDiffStat.getState().request("t1");
    await vi.waitFor(() => expect(useDiffStat.getState().byTask.t1?.stat).toEqual(stat(1)));
    answer = async () => { throw new Error("no task"); };
    useDiffStat.setState(s => ({
      byTask: { ...s.byTask, t1: { ...s.byTask.t1, fetchedAt: 0 } },
    }));
    useDiffStat.getState().request("t1");
    await vi.waitFor(() => expect(useDiffStat.getState().byTask.t1?.error).toContain("no task"));
    expect(useDiffStat.getState().byTask.t1?.stat).toEqual(stat(1));
  });

  it("records a failure's time, so a broken task is not retried every flush", async () => {
    answer = async () => { throw new Error("gone"); };
    useDiffStat.getState().request("t1");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(useDiffStat.getState().byTask.t1?.fetchedAt).toBeGreaterThan(0);
    useDiffStat.getState().request("t1");
    expect(calls).toHaveLength(1);
  });

  it("invalidate forces the next request to measure", async () => {
    useDiffStat.getState().request("t1");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    useDiffStat.getState().invalidate("t1");
    useDiffStat.getState().request("t1");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
  });

  it("ignores an empty id rather than measuring nothing", async () => {
    useDiffStat.getState().request("");
    useDiffStat.getState().requestMany(["", ""]);
    await settle();
    expect(calls).toEqual([]);
  });
});

describe("isStale", () => {
  it("treats an unmeasured task as due", () => {
    expect(isStale(undefined)).toBe(true);
  });

  it("holds off while a measurement is in flight", () => {
    // Otherwise every re-render during a slow git call queues another one.
    expect(isStale({ stat: null, loading: true, fetchedAt: 0, error: null })).toBe(false);
  });

  it("is due exactly at the floor, not one tick before", () => {
    const now = 1_000_000;
    const at = (age: number) => isStale({ stat: null, loading: false, fetchedAt: now - age, error: null }, now);
    expect(at(DIFF_STALE_MS - 1)).toBe(false);
    expect(at(DIFF_STALE_MS)).toBe(true);
  });
});
