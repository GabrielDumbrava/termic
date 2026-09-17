import { describe, expect, it } from "vitest";
import { padDiskGen, padDiskSettled, registerLivePad, trackPadDiskWrite } from "./scratchLive";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("pad disk write tracking", () => {
  it("bumps the generation when a write STARTS, per pad", () => {
    expect(padDiskGen("t1", "a")).toBe(0);
    void trackPadDiskWrite("t1", "a", deferred().promise);
    expect(padDiskGen("t1", "a")).toBe(1);
    expect(padDiskGen("t1", "b")).toBe(0);
    expect(padDiskGen("t2", "a")).toBe(0);
  });

  it("settles only after every write in flight has finished", async () => {
    const first = deferred();
    const second = deferred();
    void trackPadDiskWrite("t3", "a", first.promise);
    void trackPadDiskWrite("t3", "a", second.promise);
    let settled = false;
    void padDiskSettled("t3", "a").then(() => { settled = true; });

    second.resolve();
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);

    first.resolve();
    await padDiskSettled("t3", "a");
    await Promise.resolve();
    expect(settled).toBe(true);
  });

  it("a failed write still settles, and the caller still sees the error", async () => {
    const w = deferred();
    const returned = trackPadDiskWrite("t4", "a", w.promise);
    w.reject(new Error("disk full"));
    await expect(returned).rejects.toThrow("disk full");
    await expect(padDiskSettled("t4", "a")).resolves.toBeUndefined();
  });

  it("an idle pad settles immediately", async () => {
    await expect(padDiskSettled("t5", "never-written")).resolves.toBeUndefined();
  });
});

describe("live pad registry", () => {
  it("an old mount's unregister does not remove the mount that replaced it", async () => {
    const { livePad } = await import("./scratchLive");
    const a = { text: () => "a", write: () => {} };
    const b = { text: () => "b", write: () => {} };
    const unregisterA = registerLivePad("t6", "p", a);
    registerLivePad("t6", "p", b);
    unregisterA();
    expect(livePad("t6", "p")).toBe(b);
  });
});
