// The preview's write path: a PreviewEditTarget over the markdown tab's live
// CodeMirror buffer. An edit is verified against the buffer as it is NOW (the
// preview renders a debounced copy) and lands as one transaction, so undo,
// the dirty dot and review-comment re-anchoring all see an ordinary edit.
// See docs/markdown.md, "Edits".

import { StateEffect, type EditorState, type StateCommand } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { invertedEffects, isolateHistory, redo, undo } from "@codemirror/commands";
import type { DocEdit, EditOutcome, PreviewEditTarget } from "@/lib/markdown/edit";
import { i18n } from "@/lib/i18n";

/** Lines fromLine..toLine (1-based, inclusive), \n-joined. CodeMirror's
 *  lines never hold their separator, CRLF or not, which is the comparison
 *  applyDocEdit makes. Null out of range. */
export function readLines(state: EditorState, fromLine: number, toLine: number): string | null {
  const doc = state.doc;
  if (!Number.isInteger(fromLine) || !Number.isInteger(toLine) || fromLine < 1 || toLine < fromLine || toLine > doc.lines) return null;
  return doc.sliceString(doc.line(fromLine).from, doc.line(toLine).to, "\n");
}

/** The change a DocEdit makes to `state`, or why it is refused. `insert` is
 *  rejoined with the buffer's own separator: with `lineSeparator` "\r\n" set,
 *  CodeMirror would not split a bare \n. */
export function editChange(state: EditorState, edit: DocEdit): { from: number; to: number; insert: string } | "conflict" | "range" {
  const current = readLines(state, edit.fromLine, edit.toLine);
  if (current == null) return "range";
  if (current !== edit.expect) return "conflict";
  return {
    from: state.doc.line(edit.fromLine).from,
    to: state.doc.line(edit.toLine).to,
    insert: state.lineBreak === "\n" ? edit.insert : edit.insert.split("\n").join(state.lineBreak),
  };
}

/** What happens after a preview edit lands (the policy in docs/markdown.md):
 *  - save: written straight to disk, the buffer had nothing else unsaved
 *  - kept: the buffer already had unsaved typing, so nothing is saved and
 *    the toggle never sneaks editor typing onto disk
 *  - unsaved: saving preview edits is off (dirty dot, ⌘S)
 *  - none: nowhere to save to (an untitled pad, which flushes itself) */
export type SaveAction = "save" | "kept" | "unsaved" | "none";

export function previewSaveAction(savePreviewEdits: boolean, wasDirty: boolean, canSave: boolean): SaveAction {
  if (!canSave) return "none";
  if (!savePreviewEdits) return "unsaved";
  return wasDirty ? "kept" : "save";
}

// tags a preview edit's history event, so ⌘Z from the preview can tell an
// undo of its own edit from an undo of typing or a disk reload. The history
// re-attaches it on undo and again on redo.
const previewStep = StateEffect.define<null>();

/** The editor's half of the above: goes in the tab editor's extensions. */
export const previewHistory = invertedEffects.of(tr =>
  tr.effects.some(e => e.is(previewStep)) ? [previewStep.of(null)] : []);

export function editorEditTarget(view: EditorView, opts: {
  canEdit: boolean;
  /** the buffer has unsaved changes (read before the edit lands) */
  isDirty(): boolean;
  /** `preview` false: an undo / redo of a step the preview did not make
   *  (typing, a disk reload), which the save policy must never write */
  onApplied(label: string | undefined, wasDirty: boolean, preview: boolean): void;
  save(): void;
  pending?(on: boolean): void;
}): PreviewEditTarget {
  const history = (cmd: StateCommand, key: string) => {
    if (!opts.canEdit) return;
    const wasDirty = opts.isDirty();
    let preview = false;
    const ran = cmd({
      state: view.state,
      dispatch: tr => { preview = tr.effects.some(e => e.is(previewStep)); view.dispatch(tr); },
    });
    if (ran) opts.onApplied(i18n.t(`panels:mdEdit.${key}`), wasDirty, preview);
  };
  return {
    canEdit: opts.canEdit,
    apply(edit, label): EditOutcome {
      // a read-only buffer has no lines to replace
      if (!opts.canEdit) return "range";
      const change = editChange(view.state, edit);
      if (typeof change === "string") return change;
      const wasDirty = opts.isDirty();
      // isolated, so typing right after can't join this undo step
      view.dispatch({
        changes: change, userEvent: "input.preview",
        effects: previewStep.of(null), annotations: isolateHistory.of("full"),
      });
      opts.onApplied(label, wasDirty, true);
      return "applied";
    },
    read: (fromLine, toLine) => readLines(view.state, fromLine, toLine),
    text: () => view.state.doc.toString(),
    // ⌘Z / ⇧⌘Z from the preview go through the same save policy as an edit:
    // undoing an auto-saved tick unticks the file too, not just the buffer.
    // Only a preview step: undoing an agent's reload must not save the old text.
    undo: () => { history(undo, "undone"); },
    redo: () => { history(redo, "redone"); },
    save: opts.save,
    pending: opts.pending,
  };
}
