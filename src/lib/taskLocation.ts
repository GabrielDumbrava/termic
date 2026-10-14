export type MainCheckoutBranchState =
  | { kind: "unknown" }
  | { kind: "default" }
  | { kind: "different"; branch: string };

/** Classify the branch a main-checkout task recorded when it was opened.
 *  Project defaults are stored as remote refs (usually `origin/main`), while
 *  the checked-out branch is the local name (`main`). */
export function mainCheckoutBranchState(
  branch: string | null | undefined,
  baseBranch: string | null | undefined,
  remote: string | null | undefined,
): MainCheckoutBranchState {
  if (!branch) return { kind: "unknown" };
  if (!baseBranch) return { kind: "different", branch };

  const remotePrefix = remote ? `${remote}/` : "";
  const localBase =
    remotePrefix && baseBranch.startsWith(remotePrefix)
      ? baseBranch.slice(remotePrefix.length)
      : baseBranch;

  return branch === localBase
    ? { kind: "default" }
    : { kind: "different", branch };
}
