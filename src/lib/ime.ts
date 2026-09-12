// Korean IME can edit WKWebView's textarea without composition events.
// Forward replacements and insertText dropped while an IME key is pending.
// Native composition, including its trailing commit, stays with xterm.
// See docs/gotchas.md for the failure sequence.

const DEL = 0x7f;

// xterm handles insertText, paste and line breaks separately. These events
// refine or delete modeless composition and need the textarea delta.
const FORWARDED_INPUT_TYPES = new Set([
  "insertReplacementText",
  "insertCompositionText",
  "insertFromComposition",
  "deleteCompositionText",
  "deleteByComposition",
  "deleteContentBackward",
  "deleteContentForward",
]);

/** True for input events xterm drops and whose delta we must forward. */
export function isForwardedInputType(inputType: string): boolean {
  return FORWARDED_INPUT_TYPES.has(inputType);
}

/**
 * Compute the bytes that turn the PTY line from `prevVal` into `newVal`:
 * code-point-aware backspaces (DEL) for the changed suffix, then the new tail.
 * Returns an empty array when the values are identical. Diffing the whole
 * value (not just the trailing char) is what makes Korean final-consonant
 * migration work (안 + ㅏ -> 아나: prev "안" vs new "아나" -> DEL + "아나").
 */
export function computeImeDelta(prevVal: string, newVal: string): number[] {
  const a = Array.from(prevVal); // code-point aware (handles surrogate pairs)
  const b = Array.from(newVal);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  const back = a.length - common;
  const tail = b.slice(common).join("");
  if (back === 0 && tail.length === 0) return [];
  const bytes: number[] = [];
  for (let i = 0; i < back; i++) bytes.push(DEL);
  if (tail.length > 0) bytes.push(...new TextEncoder().encode(tail));
  return bytes;
}

/**
 * Wire the IME replacement bridge onto a terminal's helper textarea.
 *
 * @param host    The `.xterm` container element (term.open target).
 * @param getPty  Lazy getter for the current PTY id (survives Restart, which
 *                spawns a fresh pty while reusing the same DOM).
 * @param write   Sends bytes to the PTY (e.g. ipc.ptyWrite).
 * @returns       A cleanup function that removes the listeners.
 */
export function setupImeReplacementBridge(
  host: HTMLElement,
  getPty: () => string | null,
  write: (ptyId: string, data: number[]) => void,
): () => void {
  const ta = host.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
  if (!ta) return () => {};

  let prevVal = "";
  let imeKeyDown = false;
  let nativeComposition: "idle" | "active" | "pending" = "idle";

  const onInput = (ev: Event) => {
    const e = ev as InputEvent;
    const newVal = ta.value;
    // xterm sets _keyDownSeen before our custom IME guard returns false,
    // then drops composed insertText until keyup. `composed` is a DOM flag,
    // not isComposing. Missing that insert makes the next DEL erase old text.
    const droppedInsert = imeKeyDown && e.composed && e.inputType === "insertText";
    if (nativeComposition === "idle" && !e.isComposing
      && (droppedInsert || isForwardedInputType(e.inputType))) {
      const bytes = computeImeDelta(prevVal, newVal);
      const pid = getPty();
      if (pid && bytes.length > 0) write(pid, bytes);
    }
    // Always resync the baseline, including events forwarded by xterm, so
    // the next diff stays anchored to the textarea's current value.
    prevVal = newVal;
  };

  const onKeydown = (ev: Event) => {
    const e = ev as KeyboardEvent;
    if (nativeComposition !== "active" && !e.isComposing) nativeComposition = "idle";
    imeKeyDown = e.keyCode === 229 && !e.isComposing;
    const isEnter = e.key === "Enter" || e.code === "Enter" || e.code === "NumpadEnter";
    const isCtrlC = e.ctrlKey && (e.key === "c" || e.key === "C");
    // xterm wipes the textarea on these unless its custom IME guard skips
    // the key. An IME confirmation Enter must keep the existing baseline.
    if (!e.isComposing && e.keyCode !== 229 && (isEnter || isCtrlC)) prevVal = "";
  };
  const onKeyup = () => { imeKeyDown = false; };
  const onCompositionStart = () => {
    nativeComposition = "active";
    imeKeyDown = false;
  };
  const onCompositionEnd = () => {
    // Final input may have isComposing=false; xterm still owns it (#38).
    nativeComposition = "pending";
  };

  ta.addEventListener("input", onInput, true);
  ta.addEventListener("keydown", onKeydown, true);
  ta.addEventListener("keyup", onKeyup, true);
  ta.addEventListener("compositionstart", onCompositionStart, true);
  ta.addEventListener("compositionend", onCompositionEnd, true);
  return () => {
    ta.removeEventListener("input", onInput, true);
    ta.removeEventListener("keydown", onKeydown, true);
    ta.removeEventListener("keyup", onKeyup, true);
    ta.removeEventListener("compositionstart", onCompositionStart, true);
    ta.removeEventListener("compositionend", onCompositionEnd, true);
  };
}
