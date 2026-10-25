// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { isTerminalStatusQueryOnly } from "./terminalStatusQuery";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("terminal status queries", () => {
  it("recognizes complete single and coalesced queries", () => {
    for (const s of ["\x1b[?6n", "\x1b[6n", "\x1b[5n", "\x1b[?6n".repeat(100), "\x1b[5n\x1b[6n"]) {
      expect(isTerminalStatusQueryOnly(bytes(s))).toBe(true);
    }
  });

  it("keeps text, redraws, titles, hooks and bells on the activity path", () => {
    for (const s of ["", "hello", "\x1b[2J", "\x1b[?25h", "\x1b[6;1n", "\x1b[7n",
      "\x1b]0;task\x07", "\x1b]133;D\x07", "\x1b]777;termic;agent ready for input\x07",
      "\x07", "\x1b[?6nhello", "hello\x1b[?6n", "\x1b[?6n\x1b[2J", "\x1b[?6n\n"]) {
      expect(isTerminalStatusQueryOnly(bytes(s)), JSON.stringify(s)).toBe(false);
    }
  });

  it("conservatively treats every fragment as activity", () => {
    for (const query of ["\x1b[?6n", "\x1b[6n", "\x1b[5n"]) {
      for (let split = 1; split < query.length; split++) {
        expect(isTerminalStatusQueryOnly(bytes(query.slice(0, split)))).toBe(false);
        expect(isTerminalStatusQueryOnly(bytes(query.slice(split)))).toBe(false);
      }
    }
    expect(isTerminalStatusQueryOnly(bytes("\x1b[?6n\x1b["))).toBe(false);
  });

  it("xterm still replies to private and ordinary queries without changing its text", async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const replies: string[] = [];
    term.onData(reply => replies.push(reply));
    const write = (s: string) => new Promise<void>(resolve => term.write(bytes(s), resolve));
    try {
      await write("hello");
      for (const query of ["\x1b[?6n", "\x1b[6n", "\x1b[5n"]) {
        expect(isTerminalStatusQueryOnly(bytes(query))).toBe(true);
        await write(query);
      }
      expect(replies).toEqual(["\x1b[?1;6R", "\x1b[1;6R", "\x1b[0n"]);
      expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("hello");
    } finally { term.dispose(); }
  });
});
