# Remote control and remote machines

**Status: wishful design, not approved.** How Termic could be driven
from a phone and from other machines, in small steps. Nothing here is
decided or scheduled. Pairing as it ships today is in
[../peers.md](../peers.md); this doc does not describe the app.

## The requests

1. **A phone app that remote-controls the desktop app** (GH #165): see
   tasks, read what agents did, answer their questions, send prompts.
   The phone executes nothing.
2. **One Termic driving another machine's tasks**: see and drive the
   agents on your other computer from the one in front of you.
3. **Machine-to-machine orchestration**: agents on one machine
   prompting agents on another. Exists today as LAN pairing.
4. **Agents on a headless box** (GH #82: Raspberry Pis, an EC2
   instance) that keep working while the laptop sleeps.

## The approach: protocol first, engine later

The desktop app already runs every agent and knows every task. So the
phone and other computers talk to the **desktop app as it is**, over a
better version of the pairing connection. No rewrite of where task
logic lives, no new process, no daemon.

Only request 4 (a box with no Termic window on it at all) needs more,
and that choice waits until steps 1 to 3 have shipped and there is
usage to decide with (Step 4).

Why this order: each step ships something people use; the delicate code
(agent spawning, the send queue, agent-state detection) stays untouched;
and nothing is wasted, because a later headless backend would speak the
same protocol.

## Goals and non-goals

**Goals**

- The simplest thing that works, and keeps working on flaky networks.
- Reuse what exists: pairing and its crypto, the CLI verbs, the PTY
  output ring, the agent-state cache.
- No regression of the local experience: no extra latency on a local
  keystroke, no extra re-renders, no cost when nothing is connected.

**Non-goals**

- **No relay to begin with.** A phone or computer reaches the desktop
  on the same LAN or over a VPN of the user's choosing (Tailscale,
  WireGuard, a corporate VPN). Termic only needs an address it can
  reach. Nothing in the design depends on this (Trade-offs, 4).
- **No daemon.** Everything runs inside the desktop app, which must be
  running and awake.
- **The phone runs nothing.** No agents, shell or git: it is a remote
  control.
- No accounts, no hosted service, no NAT traversal.

## What already exists

| Piece | Where | Used for |
|---|---|---|
| Pairing: discovery, 4-digit code, SPAKE2, a key per pair, sealed messages | `peers.rs`, `peer_crypto.rs`, `mdns.rs` | trust between devices |
| Every verb the CLI and MCP have | `cli_server::dispatch_authenticated` | actions |
| Output ring (256 KiB) and live taps per agent PTY, with atomic subscribe-and-backlog | `PtyFeed` in `lib.rs` | `termic attach` today, the terminal view tomorrow |
| Attach session: input, resize, detach, backlog | `run_attach_session` in `cli_server.rs` | the same, over the network |
| Agent-state cache, pushed by the webview, refreshed every 20 s | `cliAgentState.ts` → `cli_agent_states` | task list and states without a webview round trip |
| Agent hooks and session transcripts | [../agent-hooks.md](../agent-hooks.md), each agent's session files | the phone's transcript view |

What is missing is one thing: **pairing sends one sealed HTTP request
per connection**, so it can carry verbs but not a live feed.

## The stream

One long-lived connection between a client (phone or computer) and a
desktop, sealed with the pair's key exactly as calls are today. It
carries:

1. **Hello**: versions and capabilities both ways, so an older desktop
   and a newer phone each disable what the other lacks instead of
   refusing to talk.
2. **Verbs**: today's `termic-proto` requests and replies, unchanged.
3. **State**: the task list and agent states, as a full snapshot on
   connect and on change, never as deltas. That is the discipline the
   agent-state cache already follows: a client that misses one simply
   gets the next.
4. **Terminal**: attach to a tab, receive the ring's backlog, then live
   bytes; send input. The mechanism `termic attach` already uses.
5. **Transcript**: the agent's turns, tool calls and questions, read
   from its session files and hooks.

Three rules keep it robust:

- **Only what a client shows streams.** A terminal streams while its
  view is open; everything else is state, which is small.
- **Behind means resync, never replay.** If a client falls behind (weak
  signal, the app was backgrounded), the desktop drops what is queued
  for it and resends the backlog. The client always sees the latest
  screen, never a slow catch-up.
- **No cost when nobody is connected.** Taps exist only while a client
  is attached; the local path stays as it is.

## Steps

### 1. The stream

Upgrade pairing from one request per connection to the stream above.
The existing `/call` is replaced, not kept beside it: pairing is
experimental and barely used. Agents' `--peer` and `peer_call` keep
working on top of it.

### 2. The phone app

- **Connects to the desktop app.** It pairs by scanning a QR code the
  desktop shows, carrying the desktop's address, id and a fresh 256-bit
  pair key, valid for a few minutes and once. The camera is the secure
  channel, so no code exchange (SPAKE2) is needed on the phone; the
  stream is then sealed with that key exactly as between computers.
  Pairing is one way: the phone drives the desktop, never the reverse.
- **Transcript first.** Every working mobile client (Happy, Claude
  Remote Control, Codex, opencode) leads with a chat-style transcript
  and approval buttons, because a TUI at phone width is unreadable.
- **Terminal second, at the desktop's width.** The phone renders the
  tab with xterm.js at its real size: fit to width, pinch to zoom,
  landscape helps. **The phone never resizes the PTY**, so the desktop
  is never disturbed and the two never fight over the size. Input goes
  through a native text box that sends a whole prompt, plus a key bar
  (Esc, Tab, arrows, Ctrl-C, y/n) for TUI menus.
- **Actions**: prompt, approve, interrupt, start and archive tasks. All
  of them run on the desktop.
- **A sleeping or quit desktop** shows as offline, not a spinner.
  Optionally Termic holds a power assertion against idle sleep while a
  phone is connected; a closed lid still sleeps.
- **Notifications** while the app is open or briefly backgrounded; it
  catches up when it reconnects. Push needs a server (Trade-offs, 4).
- **Face ID or passcode** to open the app: holding the phone is holding
  control of the desktop's agents.

### 3. Paired computers in the sidebar

The same stream, consumed by another Termic instead of a phone. A
paired machine's tasks appear in the sidebar under its name, with
state, transcript and a terminal drawn by the local xterm. Actions run
on the machine that owns the task. A file tree and diff for a remote
task come later through file and git verbs, if people ask.

This covers "handle everything from one Termic" for any machine that
can run the app: a Mac mini, a second laptop, a Windows or Linux
desktop.

### 4. Headless boxes (decided later)

For a box with no Termic window (a Pi, an EC2 instance), there are two
options. Choose once steps 1 to 3 have shipped and the demand is real.

| | A. Thin helper, brain on the laptop | B. Headless backend |
|---|---|---|
| What runs on the box | a small `termic` helper over SSH stdio that holds PTYs and runs git and file operations | the whole Termic backend, without a window |
| Agents survive the laptop sleeping | yes, the helper holds them | yes |
| New tasks, schedules, agents orchestrating while the laptop is off | no | yes |
| Cost | the helper, PTY holding, and file, git and diff calls proxied to it (about 50 commands) | moving task logic from React to Rust (about 10k lines of TypeScript), a terminal emulator in Rust for agent-state detection, splitting the backend out of Tauri |
| Prior art | VS Code Remote-SSH | herdr, Zed's remote server, opencode |

Either way the transport is the system `ssh` running `termic` on the
box over stdio: the user's `~/.ssh/config`, ProxyJump and keys just
work, no port opens, and Termic stores no credentials. Either way the
box speaks the same stream, so the sidebar, the phone and `--peer`
work unchanged.

If B is chosen, its first piece is moving agent-state detection off
xterm into Rust, running silently beside the current detector for a
release and logging disagreements before switching: agent-state
regressions are what no test catches.

## Security

- **Grants as today.** A paired computer is Drive or Reply only. A
  phone is a remote control: prompt, approve, interrupt, start and
  archive on its paired desktops. Drive is remote code execution as the
  user ([../peers.md](../peers.md)), and this design widens who can
  hold it, so revocation stays first-class.
- **A lost phone** is unpaired on the desktop, which cuts it off at
  once.
- **Listeners stay off by default.** The peer port binds only while
  sharing is on, as today. SSH (step 4) needs none.
- **The sandbox threat model is unchanged**: agent processes are
  sandboxed, Termic is not.

## Trade-offs

### 1. Protocol first or backend first

| | For | Against |
|---|---|---|
| **Protocol first (proposed)** | visible to users from step 2; no rewrite of delicate code; nothing wasted if a headless backend comes later | until step 4, every machine runs the app; the phone needs the desktop awake (true of any design where the phone controls the desktop) |
| Backend first | one clean end state; headless boxes from the start | months of refactoring with nothing to show; the riskiest code moves first; a half-finished move leaves two writers of the same state |

### 2. How the terminal reaches a client

| | For | Against |
|---|---|---|
| **The ring's backlog, then live bytes (proposed)** | already built for `termic attach`; xterm rebuilds the screen itself | up to 256 KiB on attach, fine on Wi-Fi and a VPN |
| A screen snapshot (xterm's serialize add-on, or a terminal emulator in Rust) | smaller | new code; only worth it if backlogs prove too heavy |
| Rendered cell grids (herdr) | thin text-UI clients | Termic's clients run xterm.js already |

### 3. Who sets the terminal's size

The desktop. A phone that resized the PTY would make the agent redraw
narrow on the desktop too, and herdr's "last device touched wins" makes
the desktop view jump whenever the phone is used. A "fit to phone"
action can come later if asked for.

### 4. Starting without a relay

The costs: a phone away from home needs a VPN (Tailscale on both ends
is the common case); there are no push notifications, because APNs and
FCM need a server holding the key; and a machine with no VPN and no SSH
is unreachable. What it buys: no service to run, no accounts, nothing
leaves the user's machines, and the
[termic.dev/local](https://termic.dev/local/) promise and
`cspGuard.test.ts` stay true. A relay would be one more way to carry
the same sealed frames, and fits without changing anything else as long
as sealing stays end to end between device and desktop.

### 5. Phone stack

| | For | Against |
|---|---|---|
| **React Native with Expo (proposed)** | the phone is a remote control: lists, a transcript, buttons and a text box, which is what React Native does natively; mature builds, Keychain (`expo-secure-store`) and, if ever wanted, push; QR pairing means the crypto is only HKDF and ChaCha20-Poly1305, available in pure JS (`@noble/hashes`, `@noble/ciphers`, audited) | a second, small UI codebase in React and TypeScript; the terminal view is xterm.js inside a WebView; message types generated from `termic-proto` so the two sides cannot drift |
| Tauri 2 mobile | the desktop's Rust compiles for iOS and Android unchanged, including SPAKE2 | its mobile side is younger (fewer plugins, a rougher build loop); a web view feels like a web page for keyboard, gestures and safe areas; its main advantage is the crypto, which QR pairing removes |
| Web app served by the desktop | no App Store | `http://<LAN address>` is not a secure context: no `crypto.subtle`, service worker, install or Web Push |

iOS suspends a backgrounded app and its connection whatever the stack;
the resync rule handles that. iOS asks for Local Network access on the
first LAN connection; a VPN address does not.

## Risks

- **The webview is the brain.** The phone's task list comes from the
  agent-state cache the webview pushes, so a frozen webview shows as
  stale data (the cache already fails waits after 120 s instead of
  lying).
- **Agents run only in opened tabs.** Today an agent starts when its
  tab mounts, so starting a task from the phone has to open it on the
  desktop (`open_task` exists), which also makes it visible there.
- **Local performance.** Taps and the stream must cost nothing when no
  client is attached, and remote state must never be written into the
  store unchanged ([../performance.md](../performance.md) bear trap 8).
- **Cross-version pairs.** Two releases must keep talking: capabilities
  in the hello, new fields optional, frozen message shapes with tests.
  Today two machines on different CLI protocol versions refuse each
  other.
- **Grants.** The phone holds control of the desktop's agents: Face ID,
  revocation, and Reply only for paired computers that should not drive
  stay first-class.

## Open decisions

1. **Keeping the desktop awake for a connected phone**: opt-in or
   default.
2. **A fallback when the camera is unavailable**: typing the 4-digit
   code, which needs SPAKE2 on the phone (a port, or the Rust crate
   through a native module).
3. **Step 4: thin helper or headless backend**, once there is demand.
4. **Host per project or per task** for step 4 (open in #82).

## Rejected

- **Integrating herdr.** Its documented API gives pane snapshots and
  input; live attach is its private binary protocol. It would put a
  competitor's internals and a second agent model under Termic.
- **Running the TypeScript brain in Node or Deno on a server.** A
  second runtime to ship, code bound to zustand, xterm's buffer and
  Tauri, and the brain in two places.

## Prior art (read 2026-10-18)

| | Who owns agents | What clients get | Remote reach | Auth |
|---|---|---|---|---|
| herdr | one server per user, libghostty-vt on the server | rendered cell grids; only the focused machine streams | `ssh host herdr remote-client-bridge` over stdio, self-install | socket file mode; plain SSH |
| Zed remote | a daemon behind `ssh ... proxy`, alive 10 min after disconnect | protobuf envelopes with an ack/replay queue | self-installs a versioned server over SSH | SSH |
| opencode | `opencode serve`; PTYs in a separate daemon | REST plus lossy SSE (refetch on gap); PTY WebSocket with replay | loopback by default | QR single-use code |
| Happy | CLI wrapper and daemon on the user's machine | structured transcript, no terminal | a hosted service | QR carrying a public key; E2E sealed |
| vibe-kanban | Rust + Tauri; runs die on restart | HTTP over yamux, then WebRTC | a hosted service | OAuth then SPAKE2; signed, not encrypted |
| Claude Remote Control, Codex | the CLI or app-server | transcript | the vendor's service | account and QR |
| VS Code Remote-SSH | a server on the box, brain in the editor | everything tunnelled | SSH | SSH |

Taken from them: only the visible terminal streams, and resync instead
of replay (herdr, mosh); lossy state with refetch (opencode);
transcript-first mobile (all of them); SSH stdio for headless boxes
(herdr, Zed, VS Code). Not taken: accounts, a hosted service in the
path, server-rendered screens, authentication by socket permissions.
