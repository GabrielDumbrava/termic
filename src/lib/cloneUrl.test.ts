import { describe, it, expect } from "vitest";
import { repoNameFromUrl } from "./cloneUrl";

describe("repoNameFromUrl", () => {
  it("reads the three URL shapes git itself accepts", () => {
    expect(repoNameFromUrl("https://github.com/rust-lang/regex.git")).toBe("regex");
    expect(repoNameFromUrl("ssh://git@github.com:22/rust-lang/regex.git")).toBe("regex");
    expect(repoNameFromUrl("git@github.com:rust-lang/regex.git")).toBe("regex");
  });

  it("does not require the .git suffix", () => {
    expect(repoNameFromUrl("https://github.com/rust-lang/regex")).toBe("regex");
    expect(repoNameFromUrl("git@github.com:rust-lang/regex")).toBe("regex");
  });

  it("drops exactly one .git, the way git does", () => {
    expect(repoNameFromUrl("https://acme.com/team/foo.git.git")).toBe("foo.git");
  });

  it("handles self-hosted hosts and deep paths", () => {
    expect(repoNameFromUrl("https://git.internal.acme.com/group/sub/proj.git")).toBe("proj");
    expect(repoNameFromUrl("git@git.acme.com:group/sub/proj.git")).toBe("proj");
  });

  it("ignores a trailing slash, query or fragment", () => {
    expect(repoNameFromUrl("https://github.com/o/repo/")).toBe("repo");
    expect(repoNameFromUrl("https://github.com/o/repo.git?ref=main")).toBe("repo");
    expect(repoNameFromUrl("https://github.com/o/repo.git#readme")).toBe("repo");
  });

  it("returns null rather than guessing when there is no name", () => {
    // A default directory the user did not intend is worse than an empty
    // field: it becomes a command they half-read and a folder they did not want.
    expect(repoNameFromUrl("")).toBeNull();
    expect(repoNameFromUrl("   ")).toBeNull();
    expect(repoNameFromUrl("https://github.com")).toBeNull();
    expect(repoNameFromUrl("https://github.com/")).toBeNull();
    expect(repoNameFromUrl("not a url")).toBeNull();
  });

  it("never returns a name that would escape the chosen parent", () => {
    expect(repoNameFromUrl("https://acme.com/o/..")).toBeNull();
    expect(repoNameFromUrl("https://acme.com/o/.git")).toBeNull();
  });

  it("reads a local path, which is what the e2e suite clones from", () => {
    expect(repoNameFromUrl("/Users/u/src/origin.git")).toBe("origin");
    expect(repoNameFromUrl("file:///Users/u/src/origin.git")).toBe("origin");
  });
});
