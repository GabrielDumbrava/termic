// Per-forge naming + CLI bits, so the places that talk about a provider
// don't each grow a third ternary arm. Anything provider-shaped that is
// NOT here (icons, colours) lives where it's used.

import type { ForgeProvider } from "@/lib/types";
import { installCommand, IS_WINDOWS } from "@/lib/platform";

/** `GitHub` / `GitLab` / `Azure DevOps`. */
export function forgeName(p: ForgeProvider | null | undefined): string {
  return p === "gitlab" ? "GitLab" : p === "azure" ? "Azure DevOps" : "GitHub";
}

/** The CLI binary: `gh` / `glab` / `az`. */
export function forgeCli(p: ForgeProvider | null | undefined): string {
  return p === "gitlab" ? "glab" : p === "azure" ? "az" : "gh";
}

/** `merge request` / `pull request` (long noun, lowercase). */
export function prNoun(p: ForgeProvider | null | undefined): string {
  return p === "gitlab" ? "merge request" : "pull request";
}

/** `MR` / `PR` (short noun). */
export function prNounShort(p: ForgeProvider | null | undefined): string {
  return p === "gitlab" ? "MR" : "PR";
}

/** `issue` / `work item` - the tracker's noun per provider. */
export function issueNoun(p: ForgeProvider | null | undefined): string {
  return p === "azure" ? "work item" : "issue";
}

/** The forge's PR ref marker: `#123` on GitHub, `!123` on GitLab AND Azure
 *  DevOps - in ADO `#` means a work item and `!` the pull request, the
 *  opposite of GitHub's convention. An unset provider (a legacy task that
 *  predates pr_provider) defaults to `#`, same as forgeName's GitHub. */
export function prRef(p: ForgeProvider | null | undefined, n: number): string {
  return `${p === "gitlab" || p === "azure" ? "!" : "#"}${n}`;
}

/** `Merge request !123` / `Pull request #123`. */
export function prLabel(p: ForgeProvider | null | undefined, n: number): string {
  return `${p === "gitlab" ? "Merge request" : "Pull request"} ${prRef(p, n)}`;
}

/** `MR !123` / `PR #123`. */
export function prLabelShort(p: ForgeProvider | null | undefined, n: number): string {
  return `${prNounShort(p)} ${prRef(p, n)}`;
}

/** The sign-in command for a hint line. az has two auth shapes - an Entra
 *  `az login` or a PAT through `az devops login` - so it can't be rendered
 *  as `<cli> auth login` like the other two. */
export function forgeLoginCmd(p: ForgeProvider | null | undefined): string {
  return p === "azure" ? "az login" : `${forgeCli(p)} auth login`;
}

/** Azure's second login path: a PAT via `az devops login`. Hint copy says
 *  "(or <styled>az devops login</styled> for a PAT)" - the styled wrapper
 *  differs per site, the command text is this. */
export const azurePatLoginCmd = "az devops login";

/** What the install hint should name. `brew install az` alone is useless
 *  (the forge surface is the azure-devops EXTENSION), so az gets its own
 *  copy here too. gh/glab go through platform.ts's installCommand, which
 *  is OS-aware (winget on Windows). */
export function forgeInstallCmd(p: ForgeProvider | null | undefined): string {
  if (p === "azure") {
    // `;` not `&&`/`&`: && fails on PowerShell 5.1, & is a parse error in
    // every PowerShell. Windows Terminal's default profile is PowerShell.
    return IS_WINDOWS
      ? "winget install Microsoft.AzureCLI; az extension add --name azure-devops"
      : "brew install azure-cli && az extension add --name azure-devops";
  }
  return installCommand(forgeCli(p));
}

/** Single-quote a value for a command line the AGENT will run in its shell.
 *
 *  These builders return a STRING that is typed into a prompt and that the
 *  agent is told to execute, so every interpolated value is shell input, not
 *  an argv element. `azureRemoteParts` percent-DECODES each path segment, so
 *  a remote containing `%27` yields a literal `'` and closes the quote: a
 *  crafted remote on a repo somebody clones is enough to append a command of
 *  their choosing. The Rust side has no such exposure (it builds argv), and
 *  CreatePrDialog already escapes its branch this way for the same reason.
 *
 *  `'\''` is the standard close-reopen form, the only way to get a literal
 *  quote inside single quotes.
 */
export function shellArg(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** The command that lists every thread on an ADO pull request - the
 *  azure-devops extension has no `repos pr comment` subcommand, so this
 *  REST route through `az devops invoke` is the only CLI path. It needs
 *  org/project/repo spelled out (invoke's `--detect` fills org only), so
 *  the repo's remote URL is required. Returns null when the remote can't
 *  be parsed. */
export function azurePrThreadsCommand(remoteUrl: string, number: number): string | null {
  const i = azureRemoteParts(remoteUrl);
  if (!i) return null;
  // --api-version 7.1 like azure_pr_comments: the default serialization
  // can omit isDeleted/threadContext (deleted comments leaking in, inline
  // paths lost). Route params are single-quoted: a project/repo named
  // "My Project" is legal ADO and an unquoted space would split the
  // `key=value` token into two argv entries.
  return `az devops invoke --area git --resource pullRequestThreads ` +
    `--route-parameters ${shellArg(`project=${i.project}`)} ${shellArg(`repositoryId=${i.repo}`)} pullRequestId=${number} ` +
    `--org ${shellArg(i.org)} --api-version 7.1`;
}

/** The command that lists a work item's comments. `az boards work-item
 *  show` cannot return the discussion (its --expand options don't include
 *  comments), so the prompt must hand the agent this REST route instead.
 *  Project is required; null when the remote can't supply it. */
export function azureWorkItemCommentsCommand(remoteUrl: string, id: number): string | null {
  const i = azureRemoteParts(remoteUrl);
  if (!i) return null;
  return `az devops invoke --area wit --resource comments ` +
    `--route-parameters ${shellArg(`project=${i.project}`)} workItemId=${id} ` +
    `--org ${shellArg(i.org)} --api-version 7.1-preview.4`;
}

/** (orgUrl, project, repo) out of an ADO remote. Mirrors
 *  `forge.rs::azure_remote_info`; both read the same four URL shapes and
 *  strip a trailing `.git` off the repo segment. The caller's provider
 *  check is what restricts this to ADO remotes - same as the Rust side. */
function azureRemoteParts(url: string): { org: string; project: string; repo: string } | null {
  const hasScheme = url.includes("://");
  const rest = (hasScheme ? url.slice(url.indexOf("://") + 3) : url).trim();
  // '@' is userinfo only inside the authority - before the first '/' for
  // scheme URLs, the first ':' for scp-like. A literal '@' in a path
  // segment (a repo named `proj@x`) is not credentials, same as
  // forge.rs::host_of_remote.
  const sep = hasScheme ? "/" : ":";
  const sepAt = rest.indexOf(sep);
  const auth = sepAt < 0 ? rest : rest.slice(0, sepAt);
  const host = auth.slice(auth.lastIndexOf("@") + 1).split(":")[0]
    .toLowerCase().replace(/\.$/, "");
  const path = sepAt < 0 ? "" : rest.slice(sepAt + 1);
  // Segments are percent-encoded in the remote ("My%20Project"); invoke
  // encodes route parameters again, so decode once here like
  // forge.rs::azure_remote_info does. A bare `%` in a hand-built remote
  // must not throw, so a malformed sequence keeps the raw segment.
  const dec = (s: string) => {
    try { return decodeURIComponent(s) } catch { return s }
  };
  const segs = path.split("/").filter(Boolean).map(dec);
  const noDotGit = (s: string) => s.replace(/\.git$/, "");
  if (segs[0] === "v3" && segs.length >= 4
      && (host === "ssh.dev.azure.com" || host === "vs-ssh.visualstudio.com")) {
    const org = host === "ssh.dev.azure.com"
      ? `https://dev.azure.com/${segs[1]}`
      : `https://${segs[1]}.visualstudio.com`;
    return { org, project: segs[2], repo: noDotGit(segs[3]) };
  }
  // Legacy pre-v3 SSH: {user}@{org}.visualstudio.com:{project}/_ssh/{repo} -
  // _ssh takes _git's slot, the org is the whole host.
  if (host.endsWith(".visualstudio.com") && segs[1] === "_ssh" && segs.length >= 3) {
    return { org: `https://${host}`, project: segs[0], repo: noDotGit(segs[2]) };
  }
  const gitAt = segs.indexOf("_git");
  // dev.azure.com needs org + project before _git (org is a path
  // segment); *.visualstudio.com needs just the project (org is host).
  if (gitAt < (host === "dev.azure.com" ? 2 : 1) || gitAt + 1 >= segs.length) return null;
  const project = segs[gitAt - 1];
  const repo = noDotGit(segs[gitAt + 1]);
  if (host === "dev.azure.com") return { org: `https://dev.azure.com/${segs[0]}`, project, repo };
  // A legacy /{collection}/ segment between host and project is NOT part
  // of the org: az's org-URL grammar accepts zero path segments, so
  // keeping it fails every call as "Services (cloud) only".
  return { org: `https://${host}`, project, repo };
}
