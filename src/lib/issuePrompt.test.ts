// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import {
  issueRef, issueFetchCommand, issueTaskName, issueBranch, issueContext, buildIssuePrompt,
  buildIssuesPrompt,
} from "./issuePrompt";
import { WORK_ISSUE_PROMPT, WORK_ISSUES_PROMPT } from "./builtinPrompts";
import { usePromptLibrary } from "@/store/prompts";
import type { ForgeIssue } from "./types";

const issue = (over: Partial<ForgeIssue> = {}): ForgeIssue => ({
  provider: "github",
  number: 21,
  title: "Auto-archive when PR merges",
  url: "https://github.com/simion/termic/issues/21",
  body: "I would like to be able to archive worktrees automatically.",
  author: "adamatan",
  comments: 3,
  labels: [],
  updated_at: "2026-07-01T10:00:00Z",
  ...over,
});

describe("issue naming", () => {
  it("leads the task name with the number so a truncated row stays identifiable", () => {
    expect(issueTaskName(issue())).toBe("#21 Auto-archive when PR merges");
    const long = issueTaskName(issue({ title: "x".repeat(200) }), 30);
    expect(long.length).toBeLessThanOrEqual(30);
    expect(long.startsWith("#21 ")).toBe(true);
  });

  it("falls back to the bare ref when a title is empty", () => {
    expect(issueTaskName(issue({ title: "   " }))).toBe("#21");
  });

  it("builds a branch that is traceable back to the issue", () => {
    expect(issueBranch(issue(), "simion")).toBe("simion/issue-21-auto-archive-when-pr-merges");
    // No prefix configured.
    expect(issueBranch(issue(), "")).toBe("issue-21-auto-archive-when-pr-merges");
    // A title that slugifies to nothing still yields a valid branch.
    expect(issueBranch(issue({ title: "???" }), "")).toBe("issue-21");
  });

  it("caps the slug so a long title does not become a 200-char branch", () => {
    const b = issueBranch(issue({ title: "one two three four five six seven eight nine" }), "");
    expect(b).toBe("issue-21-one-two-three-four-five-six");
  });

  it("uses # for all providers (GitLab and ADO reserve ! for PRs)", () => {
    expect(issueRef(issue())).toBe("#21");
    expect(issueRef(issue({ provider: "gitlab" }))).toBe("#21");
    expect(issueRef(issue({ provider: "azure" }))).toBe("#21");
  });

  it("picks the right CLI for the fetch command", () => {
    expect(issueFetchCommand(issue())).toBe("gh issue view 21 --comments");
    expect(issueFetchCommand(issue({ provider: "gitlab" }))).toBe("glab issue view 21 --comments");
    // `az boards work-item show` cannot return comments - the agent needs
    // the wit/comments invoke route, project spelled out from the remote.
    const azureCmd = issueFetchCommand(issue({ provider: "azure" }), "https://dev.azure.com/o/proj/_git/repo");
    expect(azureCmd).toContain("--area wit");
    expect(azureCmd).toContain("workItemId=21");
    expect(azureCmd).toContain("project=proj");
    // No remote to parse: the --detect placeholder stands in.
    const noRemote = issueFetchCommand(issue({ provider: "azure" }));
    expect(noRemote).toContain("project=PROJECT");
    expect(noRemote).toContain("--detect");
    expect(noRemote).toContain("7.1-preview.4");
  });
});

describe("issueContext", () => {
  it("carries identity, link and body, and points at the comments", () => {
    const c = issueContext(issue());
    expect(c).toContain("GitHub issue #21: Auto-archive when PR merges");
    expect(c).toContain("https://github.com/simion/termic/issues/21");
    expect(c).toContain("archive worktrees automatically");
    // The thread is NOT inlined; the agent is told to go get it.
    expect(c).toContain("3 comments");
    expect(c).toContain("gh issue view 21 --comments");
    expect(c).not.toContain("adamatan wrote");
  });

  it("still tells the agent to check when there are no comments yet", () => {
    const c = issueContext(issue({ comments: 0 }));
    expect(c).toContain("no comments yet");
    expect(c).toContain("gh issue view 21 --comments");
  });

  it("singularises one comment", () => {
    expect(issueContext(issue({ comments: 1 }))).toContain("1 comment,");
  });

  it("says so when the issue has no description at all", () => {
    const c = issueContext(issue({ body: "" }));
    expect(c).toContain("no description");
  });

  it("truncates a huge body rather than shipping a design doc", () => {
    const c = issueContext(issue({ body: "y".repeat(9000) }));
    expect(c).toContain("[body truncated");
    expect(c.length).toBeLessThan(6000);
  });

  it("lists labels when present", () => {
    expect(issueContext(issue({ labels: ["bug", "p1"] }))).toContain("Labels: bug, p1");
  });

  it("uses GitLab wording for a GitLab issue", () => {
    expect(issueContext(issue({ provider: "gitlab" }))).toContain("GitLab issue #21");
  });

  it("uses work item + tag wording for Azure DevOps", () => {
    const c = issueContext(issue({ provider: "azure", labels: ["bug"] }), 4000, "https://dev.azure.com/o/proj/_git/repo");
    expect(c).toContain("Azure DevOps work item #21");
    expect(c).toContain("Tags: bug");
    expect(c).toContain("workItemId=21");
    expect(c).toContain("--org 'https://dev.azure.com/o'");
  });

  it("points a truncated azure body at work-item show, not the comments route", () => {
    // The wit/comments invoke returns only comments - a truncated
    // description must name the command that can actually return it.
    const c = issueContext(issue({ provider: "azure", body: "y".repeat(9000) }));
    expect(c).toContain("body truncated, read the rest with `az boards work-item show --id 21 --detect`");
  });
});

describe("buildIssuePrompt", () => {
  beforeEach(() => {
    // The library persists to localStorage; start every case from the
    // shipped defaults so an edit in one does not leak into the next.
    try { localStorage.clear(); } catch { /* ignore */ }
    usePromptLibrary.getState().restoreBuiltins();
    usePromptLibrary.getState().resetPrompt("builtin:work-issue");
  });

  it("joins the issue context to the library's instructions", () => {
    const p = buildIssuePrompt(issue());
    expect(p).toContain("GitHub issue #21");
    expect(p).toContain("Work on the issue above.");
    expect(p).toContain("Do not close the issue");
    // Context first, instructions after.
    expect(p.indexOf("GitHub issue #21")).toBeLessThan(p.indexOf("Work on the issue above."));
  });

  it("respects an edited builtin, so the library is the real control surface", () => {
    usePromptLibrary.getState().updatePrompt("builtin:work-issue", {
      body: "Just fix it and say nothing.",
    });
    const p = buildIssuePrompt(issue());
    expect(p).toContain("Just fix it and say nothing.");
    expect(p).not.toContain("Do not close the issue");
  });

  it("falls back to the shipped text if the user deleted the builtin", () => {
    usePromptLibrary.getState().deletePrompt("builtin:work-issue");
    const p = buildIssuePrompt(issue());
    // A task seeded with context and no instructions would just be a wall
    // of text, so the default has to survive deletion.
    expect(p).toContain(WORK_ISSUE_PROMPT.split("\n")[0]);
  });

  // The composed prompt lands in the New Task dialog's Initial prompt box,
  // which caps what it sends. Fitting the cap is the composer's job, because
  // it is the only place that knows which half is expendable.
  describe("with a character budget", () => {
    const huge = () => issue({ body: "x".repeat(20_000) });

    it("fits the budget", () => {
      expect(buildIssuePrompt(huge(), 2000).length).toBeLessThanOrEqual(2000);
    });

    it("keeps the instructions whole and spends the budget on the body", () => {
      const p = buildIssuePrompt(huge(), 2000);
      // The ask survives intact: trimming the tail would leave the agent a
      // wall of context with nothing telling it what to do.
      expect(p).toContain("Work on the issue above.");
      expect(p).toContain("Do not close the issue");
      // And the identity, which is what makes the task traceable.
      expect(p).toContain("GitHub issue #21");
    });

    it("says the body was cut, and how to read the rest", () => {
      const p = buildIssuePrompt(huge(), 2000);
      expect(p).toContain("[body truncated");
      expect(p).toContain("gh issue view 21 --comments");
    });

    it("still drops the body at the built-in 4000 cap with no budget", () => {
      // A budget is an extra constraint, never a licence to inline more.
      expect(buildIssuePrompt(huge()).length).toBeLessThan(6000);
      expect(buildIssuePrompt(huge())).toContain("[body truncated");
    });

    it("survives a budget too small for even the instructions", () => {
      // Degenerate, but it must not throw or emit a negative-length slice.
      const p = buildIssuePrompt(huge(), 10);
      expect(p).toContain("Work on the issue above.");
      expect(p).not.toContain("xxxx");
    });

    it("leaves a short body alone", () => {
      const p = buildIssuePrompt(issue(), 8000);
      expect(p).toBe(buildIssuePrompt(issue()));
      expect(p).not.toContain("[body truncated");
    });
  });
});

describe("buildIssuesPrompt", () => {
  const i2 = (n: number, title: string) => issue({ number: n, title });

  beforeEach(() => {
    // Same as buildIssuePrompt's: the library persists to localStorage, so
    // an edit in one case must not leak into the next.
    try { localStorage.clear(); } catch { /* ignore */ }
    usePromptLibrary.getState().restoreBuiltins();
    usePromptLibrary.getState().resetPrompt("builtin:work-issue");
  });

  it("carries every pick's context under ONE instructions tail", () => {
    const p = buildIssuesPrompt([i2(1, "first"), i2(2, "second")]);
    expect(p).toContain("GitHub issue #1: first");
    expect(p).toContain("GitHub issue #2: second");
    // One ask for N subjects - the instruction body appears exactly once.
    expect(p.split("Work on the issue").length - 1).toBe(1);
  });

  it("is identical to the single-issue builder for one pick", () => {
    expect(buildIssuesPrompt([issue()], 8000)).toBe(buildIssuePrompt(issue(), 8000));
  });

  it("splits the character budget across picks so the whole still fits", () => {
    const huge = i2(9, "huge");
    huge.body = "x".repeat(20000);
    const one = buildIssuePrompt(huge, 2000);
    const two = buildIssuesPrompt([huge, i2(10, "also huge")], 2000);
    // Each issue gets roughly half the budget of a solo prompt, and the
    // result stays bounded rather than double the cap.
    expect(two.length).toBeLessThan(one.length * 1.5);
    expect(two).toContain("#9: huge");
    expect(two).toContain("#10: also huge");
  });

  it("honours the cap itself, however many picks or how small it is", () => {
    const many = Array.from({ length: 30 }, (_, i) => {
      const x = i2(i + 1, `pick ${i + 1}`);
      x.body = "x".repeat(5000);
      return x;
    });
    const tailLen = `\n\n---\n\n${WORK_ISSUES_PROMPT.trim()}`.length;
    for (const cap of [2000, 8000]) {
      expect(buildIssuesPrompt(many, cap).length).toBeLessThanOrEqual(cap);
    }
    // Smaller than the tail alone: the cap is unsatisfiable, so the
    // instructions still survive whole - they are the ask; context gives.
    const p = buildIssuesPrompt(many, 10);
    expect(p.length).toBeLessThanOrEqual(tailLen);
    expect(p).toContain("Work on the issues above.");
  });

  it("returns nothing for no picks rather than a bare separator", () => {
    expect(buildIssuesPrompt([])).toBe("");
  });

  it("uses the plural instructions for several picks", () => {
    const p = buildIssuesPrompt([i2(1, "first"), i2(2, "second")]);
    expect(p).toContain("Work on the issues above.");
    expect(p).toContain("Do not close the issues");
    expect(p).not.toContain("the issue above");
  });

  it("names work items, not issues, for azure picks", () => {
    const p = buildIssuesPrompt([i2(1, "a"), i2(2, "b")].map(i => ({ ...i, provider: "azure" as const })));
    expect(p).toContain("Work on the work items above.");
    expect(p).toContain("a work item is unclear");
    expect(p).toContain("Do not close the work items");
    expect(p).not.toContain("the issues above");
  });

  it("keeps a user-edited builtin verbatim even when the picks are plural", () => {
    usePromptLibrary.getState().updatePrompt("builtin:work-issue", {
      body: "Just fix the one thing.",
    });
    const p = buildIssuesPrompt([i2(1, "a"), i2(2, "b")]);
    expect(p).toContain("Just fix the one thing.");
    expect(p).not.toContain("Work on the issues");
  });
});

describe("prompt safety", () => {
  it("strips control bytes from issue text, which lands in a bracketed paste", () => {
    const c = issueContext(issue({
      title: "x \u001b[2J cleared",
      body: "line one\u001b[201~ rest\nstill here\u0007bell",
      url: "https://x/1\u001f",
      labels: ["bug\u001b"],
    }));
    // ESC[201~ is the paste terminator: surviving, it would end the paste
    // early and let the rest - including \r - land as live keystrokes.
    expect(c).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    // Real newlines in a body are the prompt's own structure - kept.
    expect(c).toContain("still here");
    expect(c).toContain("rest\n");
  });
});
