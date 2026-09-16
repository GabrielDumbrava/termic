// Parsing a git remote URL well enough to propose a directory name for it
// (GH #285).
//
// The NAME only. Which host the URL points at, and which forge CLI is signed
// in to it, is `forge.rs`'s `host_of_remote` / `provider_for_remote`, and this
// deliberately does not duplicate that: nothing in the clone flow branches on
// the host, because the clone runs in a real terminal where the user's own
// credential helper and SSH agent already apply.

/** The directory `git clone <url>` would create, or `null` when the URL has no
 *  name in it to use.
 *
 *  Git's own rule, which is why the cases below are what they are: take the
 *  last non-empty path segment, drop one trailing `.git`, and that is the
 *  directory. The three URL shapes all reduce to the same question once the
 *  scheme and any `user@host:` prefix are off the front.
 *
 *  Returns `null` rather than a guess for anything that leaves no name behind,
 *  so the caller can leave the field empty and let the user type instead of
 *  proposing something wrong. A wrong default here is worse than none: it is a
 *  directory the user did not intend, created by a command they half-read. */
export function repoNameFromUrl(url: string): string | null {
  let s = url.trim();
  if (!s) return null;
  // Strip a fragment or query first: neither is part of the path, and a
  // `?ref=` left on would end up inside the directory name.
  s = s.replace(/[?#].*$/, "");
  // scp-like `git@host:owner/repo.git` has no scheme and its colon is a
  // SEPARATOR, not a port. Handled before the scheme strip so `host:owner`
  // does not read as `scheme:rest`.
  const scp = /^[^/]*@([^/:]+):(.+)$/.exec(s);
  if (scp) {
    s = scp[2];
  } else {
    // ssh:// https:// git:// file:// and friends, plus any `user@` in the
    // authority. Everything up to the first slash after the authority goes.
    s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
    const slash = s.indexOf("/");
    // No slash at all means there is a host and nothing else.
    if (slash === -1) return null;
    s = s.slice(slash + 1);
  }
  // Trailing slashes are legal and carry no name.
  s = s.replace(/\/+$/, "");
  const last = s.split("/").filter(Boolean).pop();
  if (!last) return null;
  // Exactly ONE trailing `.git`, so a repo honestly called `foo.git.git`
  // clones into `foo.git` the way git itself does.
  const name = last.replace(/\.git$/, "");
  if (!name || name === "." || name === "..") return null;
  // A name that would escape the chosen parent directory is not a name.
  if (name.includes("/") || name.includes("\\")) return null;
  return name;
}
