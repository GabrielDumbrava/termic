import { describe, expect, it } from "vitest";
import { mainCheckoutBranchState } from "./taskLocation";

describe("mainCheckoutBranchState", () => {
  it("recognizes a local branch matching the project's remote default", () => {
    expect(mainCheckoutBranchState("main", "origin/main", "origin")).toEqual({
      kind: "default",
    });
  });

  it("keeps a non-default branch visible without stripping its path", () => {
    expect(
      mainCheckoutBranchState("feature/issue-73", "origin/main", "origin"),
    ).toEqual({ kind: "different", branch: "feature/issue-73" });
  });

  it("treats detached HEAD as a notable main-checkout state", () => {
    expect(mainCheckoutBranchState("HEAD", "origin/main", "origin")).toEqual({
      kind: "different",
      branch: "HEAD",
    });
  });

  it("does not guess when no branch has been recorded yet", () => {
    expect(mainCheckoutBranchState("", "origin/main", "origin")).toEqual({
      kind: "unknown",
    });
  });

  it("shows a known branch when no project default is configured", () => {
    expect(mainCheckoutBranchState("main", "", "origin")).toEqual({
      kind: "different",
      branch: "main",
    });
  });
});
