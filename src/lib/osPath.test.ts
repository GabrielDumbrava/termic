import { describe, it, expect } from "vitest";
import { toContainerPath, quoteWindowsPath, terminalPathText } from "./osPath";

describe("toContainerPath", () => {
  it("is the identity off Windows", () => {
    expect(toContainerPath("/Users/u/a b.png", false)).toBe("/Users/u/a b.png");
  });
  it("maps a drive path to the container's /<drive>/ form, as docker.rs mounts it", () => {
    expect(toContainerPath("C:\\Users\\u\\shot.png", true)).toBe("/c/Users/u/shot.png");
    expect(toContainerPath("\\\\?\\D:\\wt\\api", true)).toBe("/d/wt/api");
    expect(toContainerPath("C:\\", true)).toBe("/c");
  });
});

describe("terminalPathText", () => {
  it("backslash-escapes on macOS, as Terminal.app does", () => {
    expect(terminalPathText("/Users/u/a b.png", false, false)).toBe("/Users/u/a\\ b.png");
  });
  it("quotes a native Windows path instead of escaping its separators", () => {
    expect(terminalPathText("C:\\Users\\u\\a b.png", false, true)).toBe('"C:\\Users\\u\\a b.png"');
    expect(terminalPathText("C:\\Users\\u\\ab.png", false, true)).toBe("C:\\Users\\u\\ab.png");
  });
  it("types the container path, escaped, into a Docker task on Windows", () => {
    expect(terminalPathText("C:\\Users\\u\\a b.png", true, true)).toBe("/c/Users/u/a\\ b.png");
  });
  it("doubles embedded quotes", () => {
    expect(quoteWindowsPath('C:\\a "b"')).toBe('"C:\\a ""b"""');
  });
});
