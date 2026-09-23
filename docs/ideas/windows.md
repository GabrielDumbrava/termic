# Windows support: what is left

Status: **idea, not approved.** The first pass of the port landed on the
`feature/windows` branch: the app compiles, installs and launches on
Windows, and CI builds and tests it on every push. What exists, how to build
it, and why each part works the way it does is in
[../windows.md](../windows.md). This file is only what is left, and what has
to be measured on a real Windows machine before it is built.

Line references were read at the branch head on 2026-09-23. If one misses,
grep for the symbol next to it.

## Decisions already made

- Windows 11 x64 first. ARM64 later.
- **The only sandbox is Docker.** Seatbelt is never offered, and a stored
  Seatbelt mode reads as Off (done).
- Closing the window quits. Native title bar for now.
- Experimental: no code signing, and no Windows job in the release workflow's
  `needs`, until someone decides Windows is supported.

## 1. Measure first

These decide designs below. Each is an afternoon on a Windows machine.
Write the answer here, with how it was measured, and delete the question.

**M1. Answered: ConPTY passes OSC through.** Measured on the
`windows-latest` runner (`src-tauri/examples/conpty_osc_probe.rs`, run by
`.github/workflows/windows.yml`): OSC 777, OSC 9, OSC 133 and both
terminators reach the app byte for byte through portable-pty 0.8.1's
ConPTY, no passthrough flag or bundled `conpty.dll` needed. The same probe
measures the hook path (a node parent spawning a child with piped stdio,
the child writing to `CONOUT$`, or from Git Bash to `/dev/tty`); see the
workflow log for the result, which decides section 2.

**M2. Docker Desktop mounts** (the Docker port is built on these, untested):
- does `-v C:\Users\u\x:/c/Users/u/x` parse on the Windows docker CLI, or
  does it need `--mount type=bind,source=...,target=...`
  (`docker::render_argv`)?
- can a container running as `1000:1000` write a Windows bind mount?
- does the rewritten `.git` pointer mounted read-only over the worktree's
  own work (`git status` inside a Docker task on a worktree)?
- are the hook scripts termic writes executable inside the container? If
  not, register them as `sh <path>` for `Target::Docker`
  (`agent_hooks.rs`, `command_for`).

**M3. Which shell does each agent run hooks and `headersHelper` in on
Windows?** Claude Code uses Git Bash. codex and gemini are unknown. Decides
the MCP helper (section 4).

**M4. IME.** Japanese (MS-IME) and Korean (2-set) into an agent terminal:
each character must arrive once (`src/lib/ime.ts`, and the `keyCode === 229`
short-circuit in `TerminalPane.tsx` / `AuxTerminal.tsx`).

**M5. WebView2 clipboard.** Terminal paste uses
`navigator.clipboard.readText()`. If WebView2 prompts for permission, move
paste to the clipboard-manager plugin (needs
`clipboard-manager:allow-read-text` in `capabilities/default.json`).

**M6. A bare Alt press** may put the window into menu mode and swallow the
next key (Alt+arrow bindings).

## 2. Agent hooks

Not offered on Windows (`agent_hooks::HOOKS_AVAILABLE`). The ready / working
/ done signals, the `/clear` resume fix and the usage line all come from
them, so this is the biggest missing piece.

Today a hook script `printf`s an OSC to `$TERMIC_PTY`, the PTY slave path
from `ptsname` (`lib.rs`, `pty_slave_path`; `None` off unix). ConPTY has no
slave path. Two designs, chosen by M1:

- **If ConPTY passes OSC through:** a `termic hook <signal>` subcommand of
  the bundled CLI reads the hook's stdin JSON in Rust (replacing the
  scripts' `tr` / `awk`) and writes the OSC to `CONOUT$`, which the hook
  inherits from the agent's console.
- **If not:** per spawn, a PTY-scoped nonce (`TERMIC_PTY_KEY`; safe in env,
  it can only inject parser signals into one pane), and `termic hook
  <signal>` sends the payload over the control plane, authenticated by it.
  The server feeds the same OSC bodies into that pane's parser.

Either way the agent's config registers a direct `.exe` invocation, not a
`.sh` path, and the opencode / pi JS plugins spawn the same executable.
Docker tasks may already work (their hooks write to `/proc/1/fd/1`, relayed
by `docker run -it`), which M1 also answers.

## 3. Processes

`proc_ctl.rs` tree-kills with `TerminateProcess`. Two things remain:

- **Graceful stop, scripts.** Agents get a Ctrl+C typed into their
  pseudoconsole and STOP_GRACE to exit before the tree kill
  (`graceful_then_kill`). A run script restarted for port release has no
  console to type into (`CREATE_NO_WINDOW`), so it is killed outright;
  `GenerateConsoleCtrlEvent` does not reach a process without a console.
- **Job Objects** would make a tree kill exact (no snapshot race, children
  cannot escape) and let the handle replace the pid in `RUNNING_SCRIPTS`,
  `LSP_SERVERS` and the grep map. The PTY side needs
  `Child::clone_killer()` on the `PtySlot`.

## 4. CLI and MCP

- **Named-pipe transport.** The control plane is loopback TCP
  (`termic_proto::local`), so another local account can reach the three
  unauthenticated verbs (`hello`, `raise`, `open_url`). A named pipe named
  per data dir, created with `FILE_FLAG_FIRST_PIPE_INSTANCE`,
  `PIPE_REJECT_REMOTE_CLIENTS` and a current-user DACL, plus a peer SID
  check (`GetNamedPipeClientProcessId`, then the token user) closes that.
  All pipe IO must be overlapped: attach reads and writes one connection
  from two threads, which deadlocks on a synchronous pipe. The CLI must also
  verify the SERVER's identity before sending the token, because the pipe
  namespace is machine-wide.
- **Token file ACL.** The token files inherit the data dir's ACL (user,
  SYSTEM, Administrators). An explicit protected user-only DACL at creation
  (`cli_server::write_token_file`) would match the unix 0600.
- **Installing `termic` onto PATH** (`cli_server.rs`, `windows_unsupported`):
  keep a copy at `%LOCALAPPDATA%\termic\bin\termic.exe`, refreshed at launch
  when its version differs (rename the running one aside, then copy);
  "Add to PATH" appends that dir to `HKCU\Environment\Path` and broadcasts
  `WM_SETTINGCHANGE`. Never put the app's install dir on PATH (`termic`
  would resolve to `Termic.exe`). No `.cmd` wrapper: cmd re-parses `%*`.
  CLI auto-launch (`termic-cli/src/client.rs`) needs the app's path recorded
  somewhere it can read.
- **MCP headers helper** (`mcp_server.rs`, `helper_command`) is a POSIX
  `printf ... "$(cat ...)"`. Replace with a shell-free `termic-cli.exe
  mcp-headers` if M3 says an agent runs it outside bash.

## 5. Language servers

Done: pinned Windows downloads, and the Windows checkout layouts. Left:
zuban's own venv installer (`Scripts\python.exe`, `py -3`), and the tests
that pin the unix layouts are `#[cfg(unix)]`
(`the_checkouts_own_toolchain_wins_over_path` and its neighbours).

## 6. Smaller gaps

- **PDF preview.** Tauri serves custom schemes as
  `http://taskpdf.localhost/` on Windows, and the CSP's `object-src` does not
  cover it (`previewPaths.ts`). A CSP change: maintainer only
  (`src/lib/cspGuard.test.ts`).
- **Activity monitor** (`procmon_other.rs` answers "unsupported").
- Remaining macOS copy: the Settings sandbox text in `RepositorySection.tsx`
  and `TaskSandboxDialog.tsx` describes Seatbelt, which Windows never shows
  as a choice but still explains.
- Tray icon: `icon_as_template(true)` is a macOS idea; check it is visible on
  a dark taskbar.

## 7. Tests and CI

- **e2e on Windows.** The WebDriver is embedded
  (`tauri-plugin-wdio-webdriver`, which supports WebView2) and the binary
  path is fixed. Missing: a Node sibling of `scripts/fake-agent.sh` (the
  seed settings point every agent at it), `e2e/helpers.ts` reading the
  loopback endpoint from `termic.sock`, and `activity.e2e.ts`'s
  `/bin/sh -c "sleep 30"`. Then a `windows-latest` e2e job.
- **Release.** A `build-windows` job in `release.yml` (NSIS, updater
  signature, a `windows-x86_64` entry in `latest.json`), kept out of the
  release job's `needs` until Windows is supported. Authenticode signing
  (Azure Trusted Signing through `bundle.windows.signCommand`) or accept the
  SmartScreen warning.

## Open questions

- Is Windows supported or an experiment? Decides signing, the release job,
  and whether amd64 hardware gets bought for perf sign-off (Apple Silicon
  cannot run x64 Windows, and emulated timings are not a perf signal).
- Does anyone want it? No Windows demand is recorded in the repo.
