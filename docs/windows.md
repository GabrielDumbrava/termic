# Windows

Status: **experimental.** The app builds on Windows 11 x64, and CI builds,
installs and launches it on every push (`.github/workflows/windows.yml`),
but nobody has used it day to day yet. There are no signed or auto-updating Windows releases, and
some features are not available yet (see "Not on Windows yet"). What is
still to do, and the measurements that decide how, is in
[ideas/windows.md](ideas/windows.md).

## Building it

Everything runs from **Git Bash** (it comes with Git for Windows, which the
app needs anyway). One-time setup:

1. Admin PowerShell: enable long paths, then reboot.

   ```powershell
   New-ItemProperty HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem `
     -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force
   ```

   Optional: Settings, System, For developers, Developer Mode on. Without
   it the app links directories with junctions and files with hard links
   instead of symlinks (`src-tauri/src/fs_link.rs`), which works for
   everything it links.
2. Visual Studio Build Tools with the C++ workload:
   `winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`
3. `winget install Git.Git`, then in Git Bash:
   `git config --global core.autocrlf false` and
   `git config --global core.longpaths true`. (`.gitattributes` pins LF
   for this repo regardless.)
4. GNU make: `winget install ezwinports.make`.
5. For Docker mode: Docker Desktop with the WSL2 backend, in Linux
   containers mode (`wsl --install`, then `winget install Docker.DockerDesktop`).
6. Then, in Git Bash, in the clone: `make setup`. It installs Rust and
   Node 22 through winget if they are missing (open a new Git Bash when it
   says so and run it again), then `npm install` and a first `cargo check`.

Daily use is the same as on macOS:

| Command | On Windows |
|---|---|
| `make dev` | Vite + `tauri dev`. |
| `make check`, `make check-web`, `npm test`, `cargo test` | As on macOS. |
| `make build` | An NSIS installer in `src-tauri/target/release/bundle/nsis/`. No MSI: WiX depends on VBScript and is unreliable on Windows 11 24H2. |
| `make install` | Builds, installs per user (silent NSIS, no admin prompt) into `%LOCALAPPDATA%\Termic`, launches it. |
| `make beta` | The current branch as `Termic Beta`, installed next to the shipped app and sharing its data dir, exactly as on macOS. |
| `make uninstall` | Runs both apps' uninstallers silently. |
| `make reset`, `make reset_dev` | The Windows data locations (`%LOCALAPPDATA%\termic`, the WebView2 profile, window state). |
| `make cli-dev` | Copies (not links) the debug CLI to `~/.local/bin/termic-dev.exe`. Re-run after rebuilding it. |
| `make e2e`, `make perf` | Not run on Windows yet: the specs' fake agent is a bash script and several specs assume unix paths (see below). `make perf`'s local section is macOS-only and says so. |

`make release` and `make icons` are maintainer tooling and stay macOS.

Without the updater signing key, `make build` skips the updater artifacts
rather than failing (on every platform).

## How it works differently

Each of these is a deliberate choice; the reasoning lives next to the code.

- **Sandbox: Docker only.** The macOS Seatbelt sandbox does not exist on
  Windows, and is not offered. A Seatbelt mode stored on a task (a Mac
  teammate's committed `.termic.yaml`, a project default, `--sandbox
  enforce`) reads as Off everywhere, backend
  (`Task::effective_sandbox_mode`) and frontend (`effectiveSandboxMode`),
  so it can never spawn uncaged while the UI calls it caged. See
  [sandbox.md](sandbox.md).
- **Docker paths.** The container is Linux, so a host path maps to
  `/c/Users/u/repo` inside it (`docker::in_container`, mirrored by
  `toContainerPath` in `src/lib/osPath.ts` for pasted and dropped files).
  A worktree's `.git` pointer file is rewritten to that form and mounted
  read-only over the host one. `core.autocrlf` is passed into the
  container, and automatic `git gc` is off there, because the worktree
  metadata holds host paths. Containers run as `1000:1000`: Claude refuses
  its skip-permissions mode as root. "Docker is ready" means a daemon
  running Linux containers.
- **Shells.** `.termic.yaml` scripts, command tabs, and session-capture
  commands run under Git for Windows' own `bash.exe`, found from `git`'s
  location (`shell_env::script_bash`). A bare `bash` on Windows is
  System32's WSL launcher. Plain terminal tabs open `pwsh`, then Windows
  PowerShell, then `cmd`.
- **PATH.** The inherited environment is the resolved one: a GUI app on
  Windows gets the registry PATH from Explorer, so there is no login-shell
  probe. Every PATH walk splits with the platform separator and resolves
  PATHEXT (`shell_env::which_in`), skipping npm's extensionless shell shim
  that sits next to every `.cmd` one.
- **Processes.** No process groups: stopping a script, a language server or
  an agent kills its process tree (`proc_ctl.rs`, a ToolHelp snapshot with
  a creation-time check so a reused pid is never mistaken for a child).
  There is no graceful SIGTERM for console programs, so Stop is forceful.
  Every background command is spawned with `CREATE_NO_WINDOW`.
- **CLI control plane.** Loopback TCP on an ephemeral port, whose address
  is written into the `termic.sock` path (`termic_proto::local`). The
  per-boot token in the per-user data dir remains the credential. This is
  weaker than unix (no kernel peer-identity check): another local account
  can reach the unauthenticated `hello`, `raise` and `open_url` verbs.
  `termic attach` uses console VT mode, with the window size polled.
- **Paths in the UI.** `src/lib/osPath.ts` holds the platform rules:
  segment-safe `relUnder`, `baseName`, standard `file:///C:/...` URIs for
  the language servers (mirrored by `lsp_path_to_uri`), and quoting rather
  than backslash-escaping a dropped path.
- **Window.** Native title bar and caption buttons. The app's own bar is
  not a drag region there, and `-webkit-app-region` is applied only on
  macOS: WebView2 honours it (WKWebView ignores it), so a dialog's
  full-screen backdrop would have become window caption on Windows. WebView2's browser keys (F5 and Ctrl+R reload, Ctrl+P prints) are
  switched off (`disable_browser_accelerators`).
- **Keys.** Ctrl stands in for Cmd, and shortcut hints read `Ctrl+Alt+P`.
  In a terminal, plain Ctrl+letter goes to the shell (Ctrl+P is readline's,
  not the file finder), and Ctrl+V pastes, as in every Windows terminal.
- **Editor.** A file whose line breaks are all CRLF is saved as CRLF.
- **Closing the window quits**, as Windows users expect. The macOS
  close-to-menu-bar behaviour is macOS-only.

## Not on Windows yet

- **Agent hooks** (the ready / working / done signals and the usage line):
  their transport writes to the PTY slave device, which ConPTY does not
  have. Not offered on Windows; agent state falls back to output-based
  detection.
- **Installing `termic` onto PATH** from Settings. Agents inside Termic
  still get it.
- **Language-server downloads.** Servers on PATH work; the pinned downloads
  have no Windows entries, and repo-local Python venvs and `node_modules`
  shims use unix layouts.
- **Activity monitor**, **PDF preview** (needs a CSP change), **code
  signing and updates**, and the **e2e suite** on Windows.
