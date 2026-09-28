// Last-used per-member task mode for the multi-repo New Task dialog.
import { scoped } from "@/lib/profileScope";
import type { MemberMode } from "@/lib/types";
//
// The single-repo dialog remembers one global mode (`newTaskLastMode`) because
// that choice is about how the user works. Member modes are different: they are
// about the REPO ("this library is always safe to worktree, that config repo I
// always run live"), so they are remembered per member root_path, globally
// across projects — the same member added to two multi projects keeps one
// preference. Kept in its own module (not NewTaskDialog.tsx) so vitest can
// import it without executing the dialog's DOM code.

export const LS_MEMBER_MODES = scoped("newTaskMemberModes");

/** The remembered map, `{ [root_path]: mode }`. Unknown values and a corrupt
 *  blob both come back as "nothing remembered" — a bad entry must never wedge
 *  the dialog. */
export function readMemberModes(): Record<string, MemberMode> {
  try {
    const raw = localStorage.getItem(LS_MEMBER_MODES);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, MemberMode> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === "worktree" || v === "repo_root") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Write through one member's choice. Merges into the stored map so two multi
 *  projects don't clobber each other's members. */
export function persistMemberMode(rootPath: string, mode: MemberMode) {
  try {
    localStorage.setItem(
      LS_MEMBER_MODES,
      JSON.stringify({ ...readMemberModes(), [rootPath]: mode }),
    );
  } catch {
    // Storage full / unavailable: the dialog still works, it just won't
    // remember. Same silent policy as persistLast in NewTaskDialog.
  }
}

/** The mode a member row seeds with: the hard constraint first (non-git has no
 *  branches, so worktree is impossible), then the remembered choice, then the
 *  historical default (worktree — the safe, isolated shape). */
export function seedMemberMode(
  nonGit: boolean,
  remembered: Record<string, MemberMode>,
  rootPath: string,
): MemberMode {
  if (nonGit) return "repo_root";
  return remembered[rootPath] ?? "worktree";
}

// Named member subsets for the multi-repo New Task dialog ("backend only",
// "the two frontends"): the members to include, by root_path. Project-scoped
// (a subset names members OF that project), unlike modes which are keyed by
// member root_path globally. `members` holds root_paths; stale entries (a
// member since removed from the project) are ignored at apply time, not
// cleaned on write — the member could legitimately come back.
export interface MemberSet {
  name: string;
  members: string[];
}

export const LS_MEMBER_SETS = scoped("newTaskMemberSets");

/** The whole `{ [projectId]: MemberSet[] }` map, tolerantly parsed. A bad
 *  blob or entry drops to "nothing stored" — same rule as readMemberModes. */
function readAllMemberSets(): Record<string, MemberSet[]> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LS_MEMBER_SETS) ?? "");
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, MemberSet[]> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!Array.isArray(v)) continue;
      const sets = v.filter(
        (s): s is MemberSet =>
          typeof s === "object" && s !== null &&
          typeof (s as MemberSet).name === "string" &&
          Array.isArray((s as MemberSet).members) &&
          (s as MemberSet).members.every(m => typeof m === "string"),
      );
      if (sets.length) out[k] = sets;
    }
    return out;
  } catch {
    return {};
  }
}

export function readMemberSets(projectId: string): MemberSet[] {
  return readAllMemberSets()[projectId] ?? [];
}

/** Upsert by name: re-saving "backend" replaces it rather than stacking a
 *  duplicate chip. Order is append; the chips are read top to bottom. */
export function saveMemberSet(projectId: string, name: string, members: string[]) {
  const trimmed = name.trim();
  if (!trimmed) return;
  try {
    const all = readAllMemberSets();
    const sets = (all[projectId] ?? []).filter(s => s.name !== trimmed);
    sets.push({ name: trimmed, members });
    localStorage.setItem(LS_MEMBER_SETS, JSON.stringify({ ...all, [projectId]: sets }));
  } catch {
    // Same silent policy as persistMemberMode.
  }
}

export function deleteMemberSet(projectId: string, name: string) {
  try {
    const all = readAllMemberSets();
    const sets = (all[projectId] ?? []).filter(s => s.name !== name);
    // Drop the key when the last set goes — an empty `pid: []` would
    // sit in localStorage forever otherwise.
    if (sets.length) all[projectId] = sets; else delete all[projectId];
    localStorage.setItem(LS_MEMBER_SETS, JSON.stringify(all));
  } catch {
    // Same silent policy as persistMemberMode.
  }
}

/** Drop sets whose project is gone — sets are keyed by projectId, which a
 *  re-added project never reuses, so they can never resurface. Called from
 *  `loadAll` alongside the recents/groups prune; writes only when stale. */
export function pruneMemberSets(liveProjectIds: Set<string>) {
  try {
    const all = readAllMemberSets();
    const stale = Object.keys(all).filter(k => !liveProjectIds.has(k));
    if (!stale.length) return;
    for (const k of stale) delete all[k];
    localStorage.setItem(LS_MEMBER_SETS, JSON.stringify(all));
  } catch {
    // Same silent policy as persistMemberMode.
  }
}
