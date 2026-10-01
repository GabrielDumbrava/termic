import { describe, it, expect } from "vitest";
import { azurePrThreadsCommand, azureWorkItemCommentsCommand, forgeCli, forgeInstallCmd, forgeLoginCmd, forgeName, issueNoun, prLabel, prLabelShort, prNoun, prNounShort, prRef, shellArg } from "./forge";

describe("forge naming", () => {
  it("names all three providers", () => {
    expect(forgeName("github")).toBe("GitHub");
    expect(forgeName("gitlab")).toBe("GitLab");
    expect(forgeName("azure")).toBe("Azure DevOps");
    expect(forgeCli("azure")).toBe("az");
  });

  it("azure is a pull request, not a merge request", () => {
    expect(prNoun("azure")).toBe("pull request");
    expect(prNounShort("azure")).toBe("PR");
    expect(prLabel("azure", 7)).toBe("Pull request !7");
    expect(prLabelShort("azure", 7)).toBe("PR !7");
  });

  it("! is the PR marker on GitLab AND azure (# is a work item there)", () => {
    expect(prRef("github", 7)).toBe("#7");
    expect(prRef("gitlab", 7)).toBe("!7");
    expect(prRef("azure", 7)).toBe("!7");
  });

  it("an unset provider renders the GitHub-style ref, not !N", () => {
    // Legacy tasks can carry pr_url/pr_number with no pr_provider.
    expect(prRef(undefined, 7)).toBe("#7");
    expect(prRef(null, 7)).toBe("#7");
  });

  it("names the tracker noun per provider", () => {
    expect(issueNoun("azure")).toBe("work item");
    expect(issueNoun("github")).toBe("issue");
    expect(issueNoun("gitlab")).toBe("issue");
  });

  it("az's login is not `<cli> auth login`, and install covers the extension", () => {
    expect(forgeLoginCmd("azure")).toBe("az login");
    expect(forgeLoginCmd("github")).toBe("gh auth login");
    expect(forgeInstallCmd("azure")).toContain("azure-devops");
  });
});

describe("azurePrThreadsCommand", () => {
  const cases: [string, string, string, string][] = [
    // remote, expected org, project, repo
    ["https://dev.azure.com/myorg/proj/_git/repo", "https://dev.azure.com/myorg", "proj", "repo"],
    ["https://myorg@dev.azure.com/myorg/proj/_git/repo", "https://dev.azure.com/myorg", "proj", "repo"],
    ["https://myorg.visualstudio.com/proj/_git/repo", "https://myorg.visualstudio.com", "proj", "repo"],
    ["git@ssh.dev.azure.com:v3/myorg/proj/repo", "https://dev.azure.com/myorg", "proj", "repo"],
    ["myorg@vs-ssh.visualstudio.com:v3/myorg/proj/repo", "https://myorg.visualstudio.com", "proj", "repo"],
    // ssh:// with an explicit port, and a legacy collection segment -
    // the two edges forge.rs's azure_remote_parsing pins too.
    ["ssh://git@ssh.dev.azure.com:22/v3/myorg/proj/repo", "https://dev.azure.com/myorg", "proj", "repo"],
    ["ssh://git@vs-ssh.visualstudio.com:22/v3/myorg/proj/repo", "https://myorg.visualstudio.com", "proj", "repo"],
    // The collection segment is dropped: az's org-URL grammar takes zero
    // path segments, so keeping it fails every call as "not cloud".
    ["https://myorg.visualstudio.com/DefaultCollection/proj/_git/repo", "https://myorg.visualstudio.com", "proj", "repo"],
    // Pre-v3 SSH: _ssh is the repo marker, the org is the whole host.
    ["user@myorg.visualstudio.com:proj/_ssh/repo", "https://myorg.visualstudio.com", "proj", "repo"],
    // A PAT in the userinfo (ADO's documented clone pattern), a '@' in a
    // path segment (not userinfo), and the userinfo-less scp form
    // provider_for_repo hands down after remote_for_display strips it.
    ["https://myPAT@dev.azure.com/myorg/proj/_git/repo", "https://dev.azure.com/myorg", "proj", "repo"],
    ["https://dev.azure.com/myorg/proj@x/_git/repo", "https://dev.azure.com/myorg", "proj@x", "repo"],
    ["ssh.dev.azure.com:v3/myorg/proj/repo", "https://dev.azure.com/myorg", "proj", "repo"],
  ];
  for (const [remote, org, project, repo] of cases) {
    it(remote, () => {
      const cmd = azurePrThreadsCommand(remote, 9);
      expect(cmd).toContain(`project=${project}`);
      // Quoted `'repositoryId=repo'` token: a `repo.git` leak would still
      // contain the bare `repositoryId=repo` substring inside the quotes.
      expect(cmd).toContain(`'repositoryId=${repo}'`);
      expect(cmd).toContain("pullRequestId=9");
      expect(cmd).toContain(`--org '${org}'`);
      expect(cmd).toContain("pullRequestThreads");
    });
  }

  it("strips a .git suffix off the repo segment", () => {
    const cmd = azurePrThreadsCommand("git@ssh.dev.azure.com:v3/myorg/proj/repo.git", 9);
    expect(cmd).toContain("'repositoryId=repo'");
    expect(cmd).not.toContain(".git");
  });

  it("pins --api-version 7.1 (the same route pin forge.rs carries)", () => {
    const cmd = azurePrThreadsCommand("https://dev.azure.com/myorg/proj/_git/repo", 9);
    expect(cmd).toContain("--api-version 7.1");
  });

  it("decodes percent-encoded segments once - invoke re-encodes them", () => {
    const cmd = azurePrThreadsCommand("https://dev.azure.com/myorg/My%20Project/_git/My%20Repo", 9);
    expect(cmd).toContain("project=My Project");
    expect(cmd).toContain("repositoryId=My Repo");
  });

  it("needs org + project before _git on dev.azure.com", () => {
    expect(azurePrThreadsCommand("https://dev.azure.com/myorg/_git/repo", 9)).toBeNull();
    // A v3 path on an HTTPS host is not the SSH layout.
    expect(azurePrThreadsCommand("https://dev.azure.com/v3/myorg/proj/repo", 9)).toBeNull();
  });

  it("returns null for non-ADO remotes", () => {
    expect(azurePrThreadsCommand("git@github.com:a/b.git", 9)).toBeNull();
    expect(azurePrThreadsCommand("", 9)).toBeNull();
  });
});

describe("azureWorkItemCommentsCommand", () => {
  it("hits the wit/comments route with workItemId + project", () => {
    const cmd = azureWorkItemCommentsCommand("https://dev.azure.com/myorg/proj/_git/repo", 21);
    expect(cmd).toContain("--area wit");
    expect(cmd).toContain("--resource comments");
    expect(cmd).toContain("project=proj");
    expect(cmd).toContain("workItemId=21");
    expect(cmd).toContain("--org 'https://dev.azure.com/myorg'");
    // The comments route is preview-only - dropping the version still
    // passes the assertions above, so pin it.
    expect(cmd).toContain("--api-version 7.1-preview.4");
  });

  it("returns null for non-ADO remotes", () => {
    expect(azureWorkItemCommentsCommand("https://github.com/a/b", 21)).toBeNull();
  });
});

// ── shell safety for agent-run commands ───────────────────────────────

describe("shellArg", () => {
  it("quotes a plain value", () => {
    expect(shellArg("myorg")).toBe("'myorg'");
  });

  it("survives a value containing a single quote", () => {
    // The close-reopen form. Anything else leaves the quote open and the
    // rest of the line is read as shell.
    expect(shellArg("o'x")).toBe(`'o'\\''x'`);
  });

  it("leaves shell metacharacters inert inside the quotes", () => {
    for (const v of ["a;rm -rf /", "a`id`", "a$(id)", "a|sh", "a&b", "a>f"]) {
      const q = shellArg(v);
      expect(q.startsWith("'") && q.endsWith("'")).toBe(true);
      // Nothing between the outer quotes terminates them.
      expect(q.slice(1, -1).includes("'")).toBe(false);
    }
  });
});

/** Split a command line the way a POSIX shell would: single quotes and
 *  backslash escapes, which is everything these builders emit.
 *
 *  Written out rather than asserted on substrings, because the correct escape
 *  `'\''` legitimately CONTAINS the sequence a substring test would forbid,
 *  so the first version of this test failed on a fix that worked. Parsing it
 *  tests the property that matters: the hostile text stays one argument. */
function shellSplit(line: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false, started = false, k = 0;
  const flush = () => { if (started || cur) { out.push(cur); cur = ""; started = false; } };
  while (k < line.length) {
    const c = line[k];
    if (inQ) {                       // inside '': everything literal till the close
      if (c === "'") inQ = false; else cur += c;
      k++; continue;
    }
    if (c === "\\" && k + 1 < line.length) { cur += line[k + 1]; started = true; k += 2; continue; }
    if (c === "'") { inQ = true; started = true; k++; continue; }
    if (/\s/.test(c)) { flush(); k++; continue; }
    cur += c; k++;
  }
  flush();
  if (inQ) throw new Error(`unbalanced quote: ${line}`);
  return out;
}

describe("azure command builders are injection-safe", () => {
  // The reachable attack: azureRemoteParts percent-DECODES each path
  // segment, so %27 in a remote becomes a literal quote. These strings are
  // typed into a prompt the agent is instructed to RUN, so a closed quote
  // is an executed command. Cloning a repo with a crafted remote is enough.
  const evil = "https://dev.azure.com/o/p%27%3B%20id%3B%27x/_git/r";

  it("keeps a crafted remote inside ONE argument in the threads command", () => {
    const argv = shellSplit(azurePrThreadsCommand(evil, 7)!);
    // The whole hostile segment is a single token, quotes balanced.
    expect(argv).toContain("project=p'; id;'x");
    // And nothing the attacker wrote became a word of its own.
    expect(argv).not.toContain("id;");
    expect(argv.filter(a => a.startsWith("project="))).toHaveLength(1);
  });

  it("keeps a crafted remote inside ONE argument in the work-item command", () => {
    const argv = shellSplit(azureWorkItemCommentsCommand(evil, 7)!);
    expect(argv).toContain("project=p'; id;'x");
    expect(argv).not.toContain("id;");
  });

  it("shows what the unescaped build would have done", () => {
    // The control, in the test itself. Interpolating the decoded value
    // straight into single quotes closes them, and the shell reads the rest
    // as words of its own: `id;` becomes a command, which is the whole bug.
    const naive = `az devops invoke --route-parameters 'project=p'; id;'x'`;
    const argv = shellSplit(naive);
    // The one value split into TWO words: the quote closed after `p`, and
    // everything the attacker wrote past it is now separate shell input.
    expect(argv).toContain("project=p;");
    expect(argv).toContain("id;x");
    expect(argv).not.toContain("project=p'; id;'x");     // never one literal
  });

  it("still produces the ordinary command for an ordinary remote", () => {
    const cmd = azurePrThreadsCommand("https://dev.azure.com/myorg/proj/_git/repo", 42);
    expect(cmd).toContain("'project=proj'");
    expect(cmd).toContain("'repositoryId=repo'");
    expect(cmd).toContain("pullRequestId=42");
    // `org` is the full org URL, not the bare name.
    expect(cmd).toContain("--org 'https://dev.azure.com/myorg'");
  });

  it("keeps a legitimate space in a project name quoted", () => {
    // "My Project" is legal ADO and was the reason for quoting in the first
    // place; the escape must not have broken it.
    const cmd = azurePrThreadsCommand("https://dev.azure.com/myorg/My%20Project/_git/repo", 1);
    expect(cmd).toContain("'project=My Project'");
  });
});
