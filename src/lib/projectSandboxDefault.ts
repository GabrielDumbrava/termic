// What cage a NEW task of a project gets when nobody chooses one per task.
//
// Three stored fields express one choice (`default_docker`, plus Seatbelt's
// `default_sandbox_mode` / `default_sandbox`), because Docker and Seatbelt are
// independent booleans on the record - see `SandboxSelection` in lib/types.ts.
// Every reader has to collapse them the SAME way or the app disagrees with
// itself about what a project's default is: the settings picker, the sidebar's
// quick-create note, and the task the quick path actually creates all come
// through here.

import { isTaskCaged, selectionToFields, type Project, type ProjectMember, type SandboxSelection, type Settings } from "@/lib/types";
import { SEATBELT_AVAILABLE } from "@/lib/platform";

/** The project's default engine in the picker's own vocabulary. */
export function projectSandboxDefault(p: Project | null | undefined): SandboxSelection {
  if (!p) return "off";
  if (p.default_docker) return "docker";
  // A Seatbelt default (from a Mac teammate's project config) is not a
  // choice this OS has.
  if (!SEATBELT_AVAILABLE) return "off";
  // `default_sandbox_mode` is the precise answer; the older boolean only says
  // "on", which has always meant Enforce.
  return (p.default_sandbox_mode as SandboxSelection | undefined)
    ?? (p.default_sandbox ? "enforce" : "off");
}

/** Whether a new task of this project starts with YOLO on, before anyone
 *  ticks or unticks it: the project's own answer, else the app-wide one
 *  (Settings → Sandbox). `null` and `undefined` both mean "this project has
 *  no opinion", so `??` is right here. `false` is a real answer: a project
 *  that keeps asking on a machine that is otherwise YOLO by default. */
export function projectYoloDefault(p: Project | null | undefined, appDefault: boolean): boolean {
  return p?.default_yolo ?? appDefault;
}

/** The `yolo` a create should SEND for a ticked-or-not YOLO choice. Off
 *  whenever the flag is moot or meaningless:
 *  - the task is caged (Enforcing, Enforcing (FS), Docker): spawn turns YOLO
 *    on anyway (`isTaskCaged`), and a stored `true` would light the red ⚡
 *    the moment someone switched the sandbox off later;
 *  - the task's default tab is not an agent (a shell, a custom command, a
 *    terminal entry), which never receives `yolo_args`.
 *  Monitoring is NOT a cage, so YOLO there is the real, red, thing. */
export function yoloForCreate(checked: boolean, selection: SandboxSelection, isAgent: boolean): boolean {
  if (!checked || !isAgent) return false;
  const { mode, docker } = selectionToFields(selection);
  return !isTaskCaged({ sandbox_mode: mode, docker_sandbox_enabled: docker });
}

/** Union lists preserving order, first occurrence wins. The same merge
 *  the New Task dialog does when it seeds its allow-lists. */
export function mergeLists(...lists: (readonly string[] | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lists) for (const v of l ?? []) {
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

/** The seatbelt lists a multi-repo task pins for itself: globals → host →
 *  members, in project order — the same sequence the backend's
 *  `multi_sandbox_base` derives, so a dialog showing this union and a
 *  record storing it both read as "untouched" when membership changes. */
export function memberSandboxUnion(
  globals: Pick<Settings, "sandbox_default_rw_paths" | "sandbox_default_allowed_hosts"> | null | undefined,
  project: Pick<Project, "sandbox_rw_paths" | "sandbox_allowed_hosts"> | null | undefined,
  members: readonly Pick<ProjectMember, "sandbox_rw_paths" | "sandbox_allowed_hosts">[],
): { rw: string[]; hosts: string[] } {
  return {
    rw: mergeLists(globals?.sandbox_default_rw_paths, project?.sandbox_rw_paths,
      ...members.map(m => m.sandbox_rw_paths)),
    hosts: mergeLists(globals?.sandbox_default_allowed_hosts, project?.sandbox_allowed_hosts,
      ...members.map(m => m.sandbox_allowed_hosts)),
  };
}
