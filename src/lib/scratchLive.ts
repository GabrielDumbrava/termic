// The OPEN scratchpads, by task and pad id, so something outside the editor
// (the CLI's `scratchpad` verbs) can reach the buffer the human is looking at.
//
// An open pad's truth is its CodeMirror buffer, not the file behind it: the
// file lags typing by the flush debounce, and an editor never re-reads it
// (EditorPane loads a pad once). So a write from an agent has to go INTO the
// buffer, where it shows immediately and is undoable, and a read has to come
// out of it. A pad that is not open has no buffer and is plain IPC.
//
// A module map rather than store state: nothing renders from it, and a
// registration on every pad mount would otherwise be a store write.

export interface LivePad {
  /** The buffer as the window shows it. */
  text(): string;
  /** Replace the buffer, or add to its end, then flush it to disk. */
  write(text: string, append: boolean): void;
}

const live = new Map<string, LivePad>();
// Task and pad ids are both [A-Za-z0-9_-] (scratch_id_ok), so "/" cannot
// appear in either and the join is unambiguous.
const key = (taskId: string, scratchId: string) => `${taskId}/${scratchId}`;

/** Register an open pad's editor. Returns the unregister, which only removes
 *  THIS registration (a remount may already have replaced it). */
export function registerLivePad(taskId: string, scratchId: string, pad: LivePad): () => void {
  const k = key(taskId, scratchId);
  live.set(k, pad);
  return () => {
    if (live.get(k) === pad) live.delete(k);
  };
}

export function livePad(taskId: string, scratchId: string): LivePad | undefined {
  return live.get(key(taskId, scratchId));
}

// ── Writes to a pad's FILE, and the editor that is loading it ────────────
//
// A pad is unregistered for the length of an editor remount: the old view is
// gone and the new one is still awaiting its read. That is not rare. A pad's
// first content that sniffs as Markdown swaps EditorPane for MarkdownPane,
// which mounts a second CodeMirror, and an agent that creates a pad and
// writes to it straight away lands right in that gap. The write takes the
// closed-pad path to disk, the new editor shows what it read before it, and
// its next flush writes that stale text back over the append.
//
// So every write to a pad's file goes through `trackPadDiskWrite`, and an
// editor loading a pad waits for the ones in flight, then re-reads if any
// began while it loaded. It registers synchronously after the last check,
// which leaves no gap for a write to fall into.

const diskGen = new Map<string, number>();
const diskPending = new Map<string, Promise<void>>();

/** Record a write to a pad's file. Returns `write` untouched, so the caller
 *  still sees its result and its error. */
export function trackPadDiskWrite<T>(taskId: string, scratchId: string, write: Promise<T>): Promise<T> {
  const k = key(taskId, scratchId);
  diskGen.set(k, (diskGen.get(k) ?? 0) + 1);
  const settled = Promise.all([diskPending.get(k), write.catch(() => {})]).then(() => {});
  diskPending.set(k, settled);
  void settled.then(() => {
    if (diskPending.get(k) === settled) diskPending.delete(k);
  });
  return write;
}

/** Bumped by every tracked write. Unchanged across a read means the read saw
 *  every write that had started before it. */
export function padDiskGen(taskId: string, scratchId: string): number {
  return diskGen.get(key(taskId, scratchId)) ?? 0;
}

/** Resolves once every write tracked so far has finished, failed ones included. */
export function padDiskSettled(taskId: string, scratchId: string): Promise<void> {
  return diskPending.get(key(taskId, scratchId)) ?? Promise.resolve();
}
