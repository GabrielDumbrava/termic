import { describe, expect, it } from "vitest";
import { yoloModeName } from "./yoloModeName";

describe("yoloModeName", () => {
  it("names each built-in agent's mode from the flag it ships with", () => {
    // These are the `yolo_args` defaults in src-tauri/src/lib.rs. If one of
    // them changes there and not here, the label silently falls back to the
    // generic wording rather than lying, which is the intended failure.
    expect(yoloModeName(["--dangerously-skip-permissions"])).toBe("bypassPermissions");
    expect(yoloModeName(["--dangerously-bypass-approvals-and-sandbox"])).toBe("fullAccess");
    expect(yoloModeName(["--allow-all"])).toBe("allowAllTools");
    expect(yoloModeName(["--always-approve"])).toBe("autoApprove");
    expect(yoloModeName(["--yolo"])).toBe("yolo");
    expect(yoloModeName(["--permission-mode", "dangerous"])).toBe("dangerous");
  });

  it("says nothing for an agent with no such mode", () => {
    // pi and opencode ship empty `yolo_args`: the checkbox is a no-op for
    // them, so inventing a mode name would be a claim about nothing.
    expect(yoloModeName([])).toBe(null);
    expect(yoloModeName(undefined)).toBe(null);
  });

  it("returns null for a flag it has not been taught, instead of guessing", () => {
    expect(yoloModeName(["--trust-me"])).toBe(null);
    expect(yoloModeName(["--approval-policy", "never"])).toBe(null);
  });

  it("matches a custom agent that wraps a known CLI", () => {
    // The whole reason this is keyed off the flag: a wrapper script that
    // forwards claude's flag is running claude's mode, whatever it is called.
    expect(yoloModeName(["--verbose", "--dangerously-skip-permissions"])).toBe("bypassPermissions");
  });

  it("does not let codex's flag fall through to claude's", () => {
    // Both begin "--dangerously-"; an ordering slip here would label every
    // codex task "bypass permissions".
    expect(yoloModeName(["--dangerously-bypass-approvals-and-sandbox"])).not.toBe("bypassPermissions");
  });

  it("does not let --allow-all swallow a longer flag that starts with it", () => {
    expect(yoloModeName(["--allow-all-tools"])).toBe("allowAllTools");
  });

  it("stops naming the mode once the user edits the flag away", () => {
    // Settings → Agents lets you rewrite YOLO args. A label keyed off the
    // agent's ID would keep claiming "bypass permissions mode" here.
    expect(yoloModeName(["--some-fork-flag"])).toBe(null);
  });
});
