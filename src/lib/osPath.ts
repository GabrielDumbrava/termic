// Host paths as the TERMINAL needs them: how a dropped or pasted file's path
// is typed into a shell or an agent prompt, per platform and per cage.
import { IS_WINDOWS } from "./platform";

/** Where a host path appears inside a Docker task's Linux container.
 *  Mirrors `docker::in_container` (src-tauri/src/docker.rs), which mounts
 *  every host path at this location: the identity off Windows, and
 *  `C:\Users\u\x` -> `/c/Users/u/x` on Windows. `windows` is injectable
 *  so both rules are tested on every host. */
export function toContainerPath(host: string, windows: boolean = IS_WINDOWS): string {
  if (!windows) return host;
  const h = host.startsWith("\\\\?\\") ? host.slice(4) : host;
  const m = /^([A-Za-z]):(.*)$/.exec(h);
  if (!m) return h.replace(/\\/g, "/");
  const rest = m[2].replace(/\\/g, "/").replace(/^\/+/, "");
  const drive = m[1].toLowerCase();
  return rest ? `/${drive}/${rest}` : `/${drive}`;
}

/** Backslash-escape every character outside a conservative safe set, the way
 *  macOS Terminal / iTerm2 insert a dragged file's path. POSIX shells and
 *  every agent CLI's path parser unescape it. */
export function shellEscapePath(p: string): string {
  return p.replace(/[^A-Za-z0-9._/-]/g, "\\$&");
}

/** A native Windows path typed into cmd, PowerShell or a Windows agent:
 *  backslash-escaping would corrupt it (the separators ARE backslashes), so
 *  quote it when it needs quoting and leave it alone otherwise. */
export function quoteWindowsPath(p: string): string {
  return /[\s"&|<>^%()'`;,]/.test(p) ? `"${p.replace(/"/g, '""')}"` : p;
}

/** The text to type for `host` into a terminal of a task that is (or is
 *  not) running in Docker. */
export function terminalPathText(host: string, docker: boolean, windows: boolean = IS_WINDOWS): string {
  if (docker) return shellEscapePath(toContainerPath(host, windows));
  return windows ? quoteWindowsPath(host) : shellEscapePath(host);
}
