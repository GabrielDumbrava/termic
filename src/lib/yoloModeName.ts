// What the agent itself calls the mode our YOLO checkbox turns on.
//
// "Skip permission prompts" named something no agent shows you. Claude Code
// calls it bypass permissions MODE, and you never see a prompt to skip: you
// see a banner saying the mode is on. Codex calls its equivalent full access.
// A label that matches the agent's own word is the difference between a
// checkbox you can reason about and one you have to try.
//
// Keyed off the FLAG, not the agent id, for two reasons. An agent's YOLO args
// are user-editable (Settings → Agents), so an id-keyed label would keep
// claiming "bypass permissions" after someone changed the flag to something
// else. And a custom agent that wraps a known CLI passes the same flag, so it
// gets the right name without registering anything.
//
// An unrecognised flag returns null and the caller falls back to plain
// description. Do NOT guess a vendor's name for a flag you have not checked:
// a wrong proper noun reads as authoritative and is worse than no noun.

/** The agent's own name for its no-approvals mode. One token per name so the
 *  caller can `t()` a literal key, which is what `usedKeys.test.ts` scans. */
export type YoloModeName =
  | "bypassPermissions"   // claude, agy: --dangerously-skip-permissions
  | "fullAccess"          // codex: --dangerously-bypass-approvals-and-sandbox
  | "allowAllTools"       // copilot: --allow-all
  | "autoApprove"         // grok: --always-approve
  | "yolo"                // muse: --yolo
  | "dangerous";          // devin: --permission-mode dangerous

export function yoloModeName(yoloArgs: readonly string[] | undefined): YoloModeName | null {
  const args = (yoloArgs ?? []).join(" ");
  if (!args) return null;                 // the agent has no such mode
  // Longest/most specific first: codex's flag contains neither of the others,
  // but "--yolo" is a substring of nothing while "--allow-all" is a prefix of
  // "--allow-all-tools", so prefix-style matches have to come after the exact
  // ones they could swallow.
  if (args.includes("--dangerously-bypass-approvals-and-sandbox")) return "fullAccess";
  if (args.includes("--dangerously-skip-permissions")) return "bypassPermissions";
  if (args.includes("--permission-mode dangerous")) return "dangerous";
  if (args.includes("--always-approve")) return "autoApprove";
  if (args.includes("--allow-all")) return "allowAllTools";
  if (args.includes("--yolo")) return "yolo";
  return null;
}
