import { describe, it, expect } from "vitest";
import { localDateTime, requestFromDraft } from "./caffeinate";

describe("caffeinate draft validation", () => {
  it("rejects invalid durations without constructing an IPC request", () => {
    for (const hours of ["", " ", "0", "-1", "NaN", "Infinity", "24.01"]) {
      expect(requestFromDraft("duration", hours, "", false)).toBe("invalidDuration");
    }
    expect(requestFromDraft("duration", "1.5", "", true)).toEqual({ mode: "duration", duration_minutes: 90, closed_lid: true });
  });
  it("uses the same 24-hour horizon for until and duration", () => {
    const now = new Date(2026, 9, 25, 12).getTime();
    const future = localDateTime(new Date(now + 7_200_000));
    expect(requestFromDraft("until", "", future, false, now)).toEqual({ mode: "until", until_ms: now + 7_200_000, closed_lid: false });
    for (const value of ["", "bad", localDateTime(new Date(now - 60_000)), localDateTime(new Date(now + 86_460_000))]) {
      expect(requestFromDraft("until", "", value, false, now)).toBe("invalidTime");
    }
  });
  it("automatic mode has no deadline and does not use a hidden duration field", () => {
    expect(requestFromDraft("agents", "", "bad", false)).toEqual({ mode: "agents", closed_lid: false });
  });
});
