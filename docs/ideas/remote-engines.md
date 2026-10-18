# One engine, many screens

**Status: wishful design, not approved.** An architecture proposal for
running and driving agents beyond the one window they started in.
Nothing here is decided or scheduled; it exists so four requests stop
being designed separately. Pairing as it ships today is documented in
[../peers.md](../peers.md). This doc does not describe the app.

## The requests

1. **Agents on a remote box over SSH**, with the desktop UI local
   (GH #82: Raspberry Pis, an EC2 instance; a contributor design is in
   the thread).
2. **A headless agent server** (Linux box, Pi, EC2) whose agents keep
   working while the laptop sleeps or is closed.
3. **Machine-to-machine orchestration**, which exists today as LAN
   pairing, plus users asking to see and drive the other machine's
   tasks from one Termic.
4. **A mobile app** to watch agents, answer their questions and send
   prompts (GH #165).

## Goals and non-goals

**Goals**

- One architecture serves all four: one protocol, one permission model.
- Agents on a server engine outlive the laptop, its sleep and a dropped
  network. A client that reconnects picks up where it was.
- A remote machine's tasks are first-class in the sidebar: terminal,
  file tree, diff, editor, PR card.
- No regression of the local experience: no added latency on a local
  keystroke, no extra re-renders (CLAUDE.md, "Performance trumps
  polish").
- Stay on-device. Termic runs no server and holds no accounts; the
  [termic.dev/local](https://termic.dev/local/) promise stays true.

**Non-goals**

- **No relay to begin with.** Reaching a machine is the user's
  network: the same LAN, a VPN of their choosing (Tailscale, WireGuard,
  ZeroTier, a corporate VPN), or SSH. Termic only needs an address it
  can reach. The architecture does not depend on this: a relay would be
  one more transport (Trade-offs, 6).
- No cloud sandboxes and no provisioning of machines. The user brings
  the box.
- No multi-user collaboration on one engine. A paired machine is the
  same person's other computer, as pairing is today.

## Why the four are one problem

Each needs something that owns tasks and agents without a window.
Today nothing does (measured 2026-10-18):

- **The task brain lives in the webview.** Creating a task, opening
  tabs, sending a prompt, archiving and schedules run in React. The CLI,
  MCP and paired machines reach them through `webview_rpc`
  (`src/lib/cliRpc.ts`, 16 handlers; `TauriHost` in `cli_server.rs`).
- **An agent runs only while its terminal is mounted.** The only
  `ptySpawn` callers are `TerminalPane.tsx` and `AuxTerminal.tsx`.
- **Agent state is read off xterm.** OSC 9/777/133/1337 handlers, the
  title classifier and tail-row checks (`hasPendingWork`,
  `permissionPromptShown`) read xterm's rendered buffer. Rust caches
  what the webview pushes and nothing more.
- **Quitting kills every agent** (`RunEvent::Exit` →
  `cleanup_children`). `--headless` is windowless mode: the webview,
  and the brain with it, stays alive.
- **Pairing is one sealed HTTP request per connection.** Enough for
  verbs, unable to carry a terminal.

Solved one at a time, the four become an SSH realm, peer forwarding, a
mobile API and a daemon: four protocols and four permission models for
one idea. herdr, opencode, Zed, Codex app-server and vibe-kanban all
converged on the shape below (Prior art).

## The whole design in six rules

The aim is the simplest architecture that is still robust. Everything
below follows from these, and anything that does not is a candidate
for cutting.

1. **One engine binary, the same everywhere.** The desktop app embeds
   it; a server runs it alone. There is no second implementation for
   remote, for servers or for the phone.
2. **Every screen is a client.** The desktop UI, the phone, the CLI,
   MCP and other machines' agents all talk to an engine the same way,
   including the desktop UI to its own engine.
3. **One protocol**: the verbs Termic already has, plus events,
   terminal streams and file/git calls.
4. **A transport is just an encrypted or trusted byte pipe.** In
   process, SSH stdio, the paired stream. The protocol never knows which
   one it is on, so adding one (a relay included) touches nothing else.
5. **Every stream resumes from a cursor or a snapshot, never by
   replaying history.** Events and terminals alike. This one rule is
   what makes sleep, flaky Wi-Fi and phones work.
6. **Only what is on a screen streams.** Everything else sends agent
   state, which is small.

What is deliberately left out of the first version, because each adds
moving parts without serving a request: a holder process per PTY
(agents resume their sessions after an engine restart instead), a
desktop daemon (the desktop engine lives in the app; servers run it as
a service), server-rendered screens, accounts, NAT traversal.

## Architecture

```
   Desktop UI      Phone (PWA)     CLI / MCP     agents on other machines
        \               |              |              /
         └──────── one protocol, framed, versioned ───┘
        |               |              |              |
   in-process       SSH stdio     paired stream   paired stream
   (same app)      (ssh host      (LAN, or the    (LAN, or the
                   termic bridge)  user's VPN)     user's VPN)
        |               |              |              |
   ┌─────────┐    ┌──────────┐   ┌──────────┐   ┌──────────┐
   │ engine  │    │ engine   │   │ engine   │   │ engine   │
   │ this Mac│    │ EC2 / Pi │   │ laptop   │   │ ...      │
   └─────────┘    └──────────┘   └──────────┘   └──────────┘
```

### The engine

A Rust process that owns everything that must keep running. The desktop
app embeds one; a server runs the same crate as a binary with no GUI.

```
 engine
 ├── task manager       projects, tasks, worktrees, tabs, persistence
 ├── agent supervisor   spawn, resume, send queue, ralph loop, archive
 ├── PTY layer          portable-pty, feed with absolute offsets,
 │                      one VT emulator per agent PTY
 ├── agent state        hooks + OSC/title + screen rules → one writer
 ├── schedules          the clock and the decision to run
 ├── fs / git / LSP     file tree, diff, editor, language servers
 ├── realms             login shell, sandbox-exec, Docker
 ├── grants             owner / Drive / Reply only, per connection
 └── transports         in-process, SSH stdio, paired stream
```

What stays in the desktop UI: rendering (xterm.js, CodeMirror, diff),
split layout, prefs, themes, shortcuts, the guide, PR badges. That is
most of `src/`.

### Clients

Every client is equal and owns no state: the desktop UI, a phone, the
CLI, MCP clients, and other engines' agents. The desktop UI subscribes
to its own engine through the same protocol it uses for a remote one,
so a remote task and a local task render through one code path.

### The protocol

Four parts over one framed connection:

1. **Verbs**: the existing `termic-proto` request/reply set (CLI
   protocol v22), unchanged in meaning.
2. **Events**: task, tab and agent-state changes. Lossy by design: on a
   gap the client refetches a snapshot instead of the engine replaying
   history (opencode's SSE does this).
3. **Terminal streams**: output bytes tagged with an absolute offset,
   input, resize, and an interest lease (below).
4. **File and git calls**: what the file tree, diff and editor need, so
   a remote task gets the full right panel.

**Framing**: length-prefixed frames. Control frames are JSON, the
serde types `termic-proto` already has. Terminal output is raw bytes in
a binary frame, never a JSON number array (today's `pty://` events pay
roughly 4x for that).

**Versioning**: a hello/welcome exchange where the engine advertises
its methods and capabilities. A client facing an older engine disables
the one feature it lacks instead of refusing to connect. Published
frame shapes are frozen; new fields are optional; enums carry an
unknown fallback. Today two paired machines on different CLI protocol
versions refuse each other entirely; this replaces that.

### Transports

| Transport | For | Auth | Listener |
|---|---|---|---|
| In-process | the desktop UI and its own engine | none needed | none |
| SSH stdio | remote boxes, servers | OpenSSH | none |
| Paired stream | other machines, the phone, on the LAN or the user's VPN | SPAKE2 pairing, sealed frames | the existing peer port, off by default |

**SSH stdio.** The desktop runs `ssh host termic bridge`. On the box,
`bridge` starts the engine if it is not running and pipes the protocol
over the SSH channel. Termic uses the system `ssh` with a ControlMaster
it owns, so `~/.ssh/config`, ProxyJump, 1Password and FIDO keys work.
No port opens on the server, and Termic stores no credentials. First
connection installs the engine by versioned binary name: copy the local
binary when the platform matches, download otherwise, always after the
user confirms. Background reconnects never install, update or prompt.
herdr and Zed both work this way.

**Paired stream.** Today's pairing (code typed once, SPAKE2, a key per
pair, ChaCha20-Poly1305 per direction) is kept. The change is from one
HTTP request per connection to one long-lived connection carrying
sealed frames. Discovery stays mDNS on the LAN; on a VPN the user pairs
by address, which already exists. Termic does not traverse NAT.

### What crosses the wire

- **Agent state and events always**, for every connected engine. They
  are small.
- **Terminal bytes only for what a client shows.** A client leases the
  tabs on its screen and only those stream; every other tab sends state
  alone (herdr's `surface_interest`). This keeps a phone, a slow VPN
  and a dozen agents workable.
- **Reconnect is offset or snapshot, never full history.** If the
  engine's ring still holds the client's last offset, it resumes from
  there. If not, the engine sends a screen snapshot from its VT
  emulator, then live bytes (the mosh idea). A phone that slept an hour
  gets one screen, not an hour of output.

### Security model

- **Grants per connection.** In-process and SSH clients are the owner.
  A paired machine is Drive or Reply only, as pairing is today. A phone
  defaults to Reply only plus answering approvals; Drive is opt-in.
- **Drive is remote code execution as the user** ([../peers.md](../peers.md)).
  Nothing about this design softens that; it widens who can hold it, so
  the grant UI and the per-machine revocation stay first-class.
- **A lost phone** is unpaired from any of the user's machines, and the
  revocation reaches every engine that phone was paired with.
- **Listeners stay off by default and loopback where possible.** SSH
  needs none. The peer port binds only while sharing is on, as today.
- **The sandbox threat model is unchanged**: the agent CLI process is
  sandboxed, the engine is not. On Linux engines `sandbox-exec` does not
  exist; Docker is the realm there.

### Agent lifetime

Three levels, each a separate decision:

1. **Survives the window closing and the laptop sleeping**: any engine
   that is not the webview gives this.
2. **Survives the engine restarting or upgrading**: needs either a
   small holder process per PTY that the engine reattaches to (the #82
   design, opencode's PTY daemon) or passing PTY file descriptors to the
   new engine (herdr's experimental handoff).
3. **Survives a reboot**: agents resume their own sessions
   (`claude --resume` and friends), which Termic already does for a
   closed tab.

### Mobile

- **Transcript first, terminal second.** Every working mobile client
  (Happy, Claude Remote Control, Codex, opencode, claudecodeui) shows a
  chat-style transcript with approval prompts. A TUI agent's raw stream
  at 40 columns is unreadable and drains the battery. The transcript is
  built from the hook stream ([../agent-hooks.md](../agent-hooks.md))
  and the agents' session files, read beside the PTY, so the desktop
  keeps a real terminal and nothing takes the agent over. A terminal
  view opens on demand: snapshot, then live bytes.
- **Reach**: the phone talks to an engine over the paired stream, on
  the same Wi-Fi or over the user's VPN (the Tailscale app on the phone
  is the common case).
- **Client**: a PWA served by the engine is the cheapest first client
  (opencode and claudecodeui do this). A native app earns its cost when
  background notifications and a Keychain-held pairing key matter.
- **Notifications are the hard part without a server** (Trade-offs, 6).

## Trade-offs

### 1. Where the brain lives

| Option | Serves | Fails | Cost |
|---|---|---|---|
| **Engine split (proposed)** | all four | nothing | ~10k lines of TS to Rust, a Rust VT emulator, the `lib.rs` crate split |
| Remote realm, brain stays on the laptop (#82 as first proposed) | SSH | phone and the box's own agents need the laptop awake; ~50 fs, git, diff and LSP commands proxied | medium to high, and a third realm beside Docker and login |
| TS brain run headless in Node or Deno | server, part of mobile | a second runtime to ship; code bound to zustand, xterm's buffer and `invoke`; the brain exists twice | high, and slower |

The split is not the cheapest way to deliver any single request. It is
the cheapest way to deliver all four, and each alternative is a subset
of its work that would be redone later.

### 2. What the engine sends a terminal client

| Option | For | Against |
|---|---|---|
| **Raw bytes + engine-side VT for snapshots and detection (proposed)** | clients run xterm.js already; local path stays one hop | an emulator on both ends |
| Rendered cell grids (herdr) | thin TUI clients, cheap diffs | Termic's clients would re-render cells xterm can parse itself |
| Transcript only | best on a phone | the desktop needs a real terminal |

Transcript is added for mobile, beside raw bytes, not instead of them.

### 3. How a remote engine is reached

| Option | For | Against |
|---|---|---|
| **SSH stdio (proposed for servers)** | no listener, no credentials of ours, the user's SSH config just works | needs SSH access; Windows needs OpenSSH |
| Paired stream (proposed for the user's other computers and the phone) | already built and audited; no SSH setup | a listener on the network, LAN or VPN only |
| Our own listener with TLS | works anywhere | certificates, a second auth system, a port open on a server |

### 4. One protocol for every transport, or one per use

One protocol costs the in-process path a framing step it does not
strictly need. Measure it in phase 0: if a local keystroke picks up
latency, the in-process transport may pass frames by reference rather
than serialising. Per-use protocols were rejected: they are the four
designs this doc exists to avoid.

### 5. Engine lifetime

| Option | For | Against |
|---|---|---|
| **Desktop: engine inside the app process (proposed)** | no daemon on the desktop; simplest | agents die on quit, as today |
| **Server: the same engine as a service (proposed)** | agents survive the laptop entirely | per-OS lifetime work (systemd, launchd); a daemon on that box (CLAUDE.md: ask first) |
| Desktop engine as its own process | agents survive quitting the desktop app | a daemon on every desktop; deferred until users ask |
| Plus a holder process per PTY | agents survive engine upgrades | more processes and a reattach protocol; deferred, agents resume their sessions instead |

The proposed split keeps the desktop exactly as it is about lifetime
and puts the daemon only where the user explicitly installs an engine.

### 6. Starting without a relay

The first version runs no relay. The costs, stated plainly:

- **A phone off the network needs a VPN.** For most users that is
  Tailscale on both ends; Termic documents it and does not depend on it.
- **No native push notifications.** APNs and FCM need a server holding
  the provider key, which Termic does not run. Options without one:
  - Web Push from the engine straight to the browser's push service.
    The payload is encrypted end to end (RFC 8291), so the push service
    sees ciphertext. It needs the PWA on a secure origin (HTTPS), which
    a LAN address is not; `tailscale serve` provides one.
  - Notifications only while the app is open, which is the floor.
- **A machine behind NAT with no VPN and no SSH is unreachable.** That
  is the user's network to fix.

What it buys: no service to run or secure, no accounts, nothing of the
user's ever leaves their machines, and the termic.dev/local promise and
`cspGuard.test.ts` stay true without exceptions.

A relay fits the architecture without changing it (rule 4): the engine
dials out to a forwarder that moves frames already sealed with the
pairing key, so it sees ciphertext and a routing id only. The one
requirement on today's design is to keep sealing end to end between
engine and client, never per hop, so that option stays open.

### 7. Mobile client

| Option | For | Against |
|---|---|---|
| **PWA served by the engine (proposed first)** | no App Store, ships with the engine, one codebase with the desktop UI's React | needs HTTPS for install and push; iOS limits background work |
| Native app (Expo or Swift) | Keychain, background behaviour, polish | a second codebase; native push needs a server (6) |

## Phases

Ordered so each step pays off on its own.

0. **Terminal layer in Rust.** A feed with an absolute offset for every
   PTY; a VT emulator per agent PTY (alacritty_terminal, vt100, or
   libghostty-vt, which herdr vendors); agent-state detection moved into
   Rust so Rust is the writer and the webview a reader; `pty://` events
   replaced by raw bytes over a `Channel`. Alone it gives correct `wait`
   and `list` without a window, cheap reattach, and a faster terminal
   path. Run the Rust detector shadowed beside the xterm one for a
   release, logging disagreements, before flipping: agent-state
   regressions are what no suite catches.
1. **Spawn ownership and the send queue in Rust.** A task's agents run
   when the engine says, not when React mounts. Then the 16 `cliRpc`
   handlers, then schedules.
2. **Extract `termic-core`.** The seam exists: `trait CliHost`
   (`cli_server.rs`), plus an `EventSink` replacing
   `emit_to_window`/`emit_scoped`, and a plain `Arc<PtyManager>`
   replacing `State`. `docker.rs`, `sandbox.rs`, `schedules.rs` and
   `peer_crypto.rs` already have no Tauri dependency. The headless
   binary is nearly free after this.
3. **SSH.** `termic bridge`, versioned install, health pings, retry with
   backoff, interest leases. Delivers #82 and the agent server.
4. **Pairing becomes a stream.** Paired machines' tasks appear in the
   sidebar. The one-shot `/call` is replaced, not kept beside it.
5. **Mobile.** PWA over the paired stream, transcript view, approvals,
   terminal on demand.

## Open decisions

1. **A daemon on the boxes a user installs an engine on.** The
   proposal keeps the desktop daemon-free; a server engine is one.
   `schedules/runner.ts` chose "no daemon; launchd around `termic new`"
   on purpose, and CLAUDE.md asks for sign-off.
2. **Agents surviving upgrades**: the proposal accepts that an upgrade
   restarts agents and they resume their sessions. A holder per PTY or
   an fd handoff only if that proves not enough.
3. **Host per project or per task** (open in #82). Leaning per project,
   with a per-task override later.
4. **Phone notifications**: engine-sent Web Push over a VPN's HTTPS
   origin, or in-app only.
5. **Linux sandboxing**: Docker only, or a native option (bubblewrap,
   Landlock).

## Risks

- **Store fan-out** ([../performance.md](../performance.md) bear trap
  8). Engine-pushed state must skip unchanged values, and two writers
  (the engine plus optimistic UI updates) is a new way to break it.
  Extend `selectorFanout.test.ts` with the engine as a writer.
- **Agent-state parity.** Porting detection off xterm (OSC parsing,
  alternate screen, title stack) can silently break bells and settles.
  Hence the shadow phase.
- **Cross-version compatibility and remote liveness.** This is where
  herdr spends its effort: frozen frames with digest tests, half-open
  links after sleep, stale ControlMasters, auth recovery that never
  prompts in the background.
- **Windows.** ConPTY's EOF quirk and the hook pipe sit in the PTY path
  phase 0 rewrites; SSH stdio needs OpenSSH. Gate on the Windows e2e
  job.
- **Scope.** Phases 0 to 2 change nothing a user can see and touch the
  most delicate code in the repo. They need to land in pieces, each
  behind a passing suite, not as one branch.

## Prior art (read 2026-10-18)

| | Who owns agents | What clients get | Remote reach | Auth |
|---|---|---|---|---|
| herdr | one server per user, PTYs held directly, libghostty-vt on the server | rendered cell grids; ANSI frames for observers; only the focused machine streams | `ssh host herdr remote-client-bridge` over stdio, ControlMaster, self-install | socket file mode; plain SSH |
| Zed remote | a daemon behind `ssh ... proxy` over stdio, alive 10 min after disconnect | protobuf envelopes with an ack/replay queue | self-installs a versioned server over SSH | SSH |
| opencode | `opencode serve`; PTYs in a separate persistent daemon | REST plus lossy SSE (refetch on gap); PTY WebSocket with replay | loopback by default; tunnel opt-in | QR single-use code exchanged for a cookie |
| Happy | CLI wrapper and daemon on the user's machine | structured transcript, no terminal | outbound to a hosted service | QR carrying a public key; E2E sealed |
| vibe-kanban | Rust/axum + Tauri; runs die on restart | HTTP over yamux, upgraded to WebRTC | outbound to a hosted service | OAuth then SPAKE2; signed, not encrypted |
| Claude Remote Control, Codex | the CLI or app-server | transcript (JSON-RPC items for Codex) | the vendor's service | account and QR |
| Coder, VS Code Tunnels | an agent on the box | everything tunnelled | WireGuard or vendor service, E2E | account |

What Termic takes: the engine split and SSH stdio bootstrap (herdr,
Zed), interest leases and snapshot-not-replay reconnects (herdr, mosh),
lossy events with refetch (opencode), transcript-first mobile (all of
them), and a frozen, negotiated protocol (herdr's endpoint contract).
What it does not take: authentication by socket permissions alone,
server-rendered cells, accounts, or a hosted service in the path.
