# Usage footer

A per-provider usage readout in the task footer: how much of the subscription's
rolling limits the currently shown account has spent. Requested in GH #277 by a
user who moved from Orca and misses it.

**The chip SHIPPED in 1.2.3**, and 1.3.0 added the running cost and the
per-account split. What is still an idea is the bottom half of this file: the
open questions are product calls nobody has made, and none of them blocked the
part that shipped. The comparison above them is kept because the rejected
options are the expensive part to re-derive, not because the decision is open.

Everything now TRUE OF THE APP has moved to the reference docs, which are the
ones to trust: the claude status line, its three measurements and the
slot-ownership rule are in [agent-hooks.md](../agent-hooks.md); the codex RPC
is
in [ipc.md](../ipc.md). This file keeps the comparison that chose them, because
the rejected options are the expensive part to re-derive.

## What it shows

Orca's footer reads `58% 5h - 41% wk` per logged-in provider. That is NOT
context usage, which is the natural misreading. It is the two rolling windows a
subscription enforces: the short session window and the long one. Some sources
carry context usage in the same payload, so a context readout would be nearly
free, but it is a different number and would need its own label.

## What was built

- **claude** reports itself, through a status line installed alongside the
  agent hooks (schema v7). It prints nothing and writes one OSC 777 on the
  hook channel, so the agent looks unchanged.
- **codex** is asked, over `account/rateLimits/read` on `codex app-server`.
- **devin** is asked too, over Connect `GetUserStatus` on the seat-management
  service named in the account's own `credentials.toml` - the same call the
  TUI's "Pro · N% remaining" header makes. No child process at all: the
  request is one HTTPS JSON POST carrying the account's API key, and it
  answers cold with no agent running. The response reports REMAINING percent
  on a daily and a weekly quota, so `agent_usage.rs` inverts it before it
  reaches the windows the footer draws.
- **claude also reports SESSION COST in USD**, `cost.total_cost_usd`, from the
  same status line payload. It arrives on every turn, on an account with or
  without a plan, and reading it costs nothing extra: the script was already
  draining that stdin and throwing the field away. Codex gets no equivalent,
  and deliberately: its own spend data is a TOKEN count, so dollars would mean
  a per-model price table inside termic that goes silently wrong the day
  prices move. A wrong number is worse than no number here.
- The cost rides as a FIFTH field on the same `usage` body, appended and never
  inserted, so a running app with an older status line installed sends four
  and the missing fifth reads as absent.
- Both are keyed by AGENT ENTRY id AND ACCOUNT, so two tasks spending one quota
  share a number and two on different logins never do. The account half arrived
  with the switcher (GH #278) and was a real defect until it did: an agent
  entry used to BE a login, and once one entry could hold several accounts the
  two wrote into a single slot. The account in the key is the one the PROCESS
  was spawned with, never the configured one. See
  [agent-accounts.md](../agent-accounts.md#usage-is-keyed-by-account-and-was-not).
- The chips are leftmost in the footer's right group, so they and the "N
  blocked" chip grow leftwards and the sandbox status stays pinned rightmost.
  Each self-hides until its account has actually reported, so an agent with no
  source costs that row no width.
- **One chip per AGENT the task runs**, task's own agent first, not one chip
  for the task. A task can hold a claude tab and a codex tab, and the footer
  was bound to `task.cli`: the second agent's quota was nowhere, which is what
  the reporter came back about on #277. When the bar is too narrow to hold
  them all (measured: under 780px of footer) the ones the user is not looking
  at drop, so what survives is the agent whose tab is on screen. They are
  dropped by a container query rather than unmounted, so a chip off screen
  keeps reporting and comes back with the room. `lib/footerAgents.ts` decides
  the set and the order; the order deliberately does NOT follow focus, because
  a chip that moves when you switch tabs is a chip you have to find again.

Verified live end to end: the generated status line against Claude Code 2.1.260
in a real PTY, and the RPC against a real codex 0.153.2
(`cargo test codex_rate_limits_live -- --ignored`). Three e2e cases in
`agent.e2e.ts` drive the whole chain through a real window.

## The source hunt

Every candidate was measured against the installed binaries, not reasoned
about. Three of the seven are dead, and they are recorded so nobody re-walks
them.

| source | verdict |
| --- | --- |
| claude `statusLine` stdin payload | BUILT |
| codex `account/rateLimits/read` RPC | BUILT |
| devin Connect `GetUserStatus` | BUILT |
| claude OAuth usage endpoint | works, but needs the keychain on a Mac host |
| codex rollout JSONL `token_count` | works, but the RPC dominates it |
| devin `user_status.*.bin` disk cache | works, but stale between devin runs and keyed by an opaque digest |
| devin `/usage` TUI command | DEAD: renders inside the TUI, no print-mode output |
| claude hook payloads | DEAD: no usage fields |
| claude transcript JSONL | DEAD: written only once already rejected |
| claude OTEL metrics | DEAD: no such metric, and needs a collector |

The three dead ones are written up in [agent-hooks.md](../agent-hooks.md),
which
is where the next person hunting for a claude signal will be standing.

The codex rollout file (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`, a
`token_count` event carrying `rate_limits` plus `model_context_window`) is a
real second source, kept documented as the fallback if the RPC ever goes away.
The RPC beats it on every axis: it answers cold with no agent running, it
returns `accountId` so attribution is explicit rather than inferred, it needs
no
directory walking, and it dodges the trap that `session_meta.cwd` inside Docker
is the path as the CONTAINER sees it and can never be matched against a host
worktree.

## The OAuth endpoint, and why it is not the default

`GET https://api.anthropic.com/api/oauth/usage` with the Claude Code OAuth
token, `anthropic-beta: oauth-2025-04-20` and a `claude-code/*` UA. Verified
live, HTTP 200, returning `five_hour` and `seven_day` utilisation with
`resets_at`, plus per-model weekly windows and a spend block. Kept out of the
build, for reasons worth keeping written down.

**It is not an OAuth flow.** termic would never run the authorize/PKCE
exchange and never open a browser; it would reuse the token claude already
holds. There is nothing to implement. That is the obvious first fear rather
than the real one.

**The real one is the refresh.** The stored credential carries `expiresAt`,
`refreshToken` and `refreshTokenExpiresAt`, and a live access token measured
here had 3.5 hours left. Something has to refresh it, and that something must
never be termic: if termic spends the refresh token and the server rotates it,
claude's own credential goes stale and a footer has logged the user out of
Claude Code. Read-only, always. Riding a turn-end edge would make read-only
sufficient rather than merely safe, since claude has just used that token
milliseconds earlier.

**On a Mac host it needs the keychain, and the ACL is the blocker.**
`~/.claude/.credentials.json` looks like the fallback and is a decoy: measured,
a 280-byte skeleton with the right keys and an EMPTY `accessToken`. The token
lives in the keychain and nowhere else. That keychain item's only
decrypt-authorised application is `/usr/bin/security`, claude itself included
in
what is NOT listed, so a native Security-framework read from termic.app raises
a
system dialog naming another app's secret. Shelling out to `/usr/bin/security`
sidesteps it, but rests on an ACL termic does not own, and **termic touches no
keychain today at all**.

**Docker inverts it.** A container has no keychain, so claude writes a real
credentials file into the mounted config dir, which termic already owns. Free
there and awkward on the host, which is the wrong shape for a footer.

Where it would still earn its place is the cold start below.

## Open questions

These are why this is still an idea.

- **Is the status line slot worth taking at all?** It is claimed only when
  free,
  handed back on uninstall, and prints nothing, so the cost is invisible rather
  than zero: a user who later opens `~/.claude/settings.json` finds a termic
  script in a slot they did not fill. The install preview says so in as many
  words, which may or may not be enough.
- **A project-level status line shadows ours.** Measured: a repo's own
  `.claude/settings.json` statusLine outranks the user-level one termic
  installs, and termic's OSC never fires. termic must not write into a repo's
  settings to win that fight, so it DETECTS the case instead and says so: a
  `usage n/a` chip naming the file in force, with a prompt to hand to the agent
  that owns that status line. What is still not built is termic doing the edit
  itself, and it probably should not: the script can be in any language and
  only the file knows how it is structured.
- **Cold start.** The status line only speaks while a turn runs, so the chip is
  absent until a task takes one, which is the opposite of what a footer is for.
  Today it shows nothing, and codex does not have the problem because the RPC
  answers cold. The options are to cache the last value per agent entry and
  show it with its age, or to spend one call per provider at launch, which is
  the one thing the OAuth endpoint would be good for.
- **The codex refresh cadence.** Every refresh spawns an app-server, so the
  chip asks every two minutes, for the visible task only. That is a guess,
  not a measurement. If it ever matters the honest fix is to drive it off the
  `Stop` hook termic already receives rather than to tune the interval.

  The MOUNT is no longer part of that cadence, which was a separate bug rather
  than a tuning question. The timer lives in an effect keyed on `visible`, so
  it re-ran on every task switch and asked immediately each time: two tasks on
  one login respawned `app-server` to re-fetch a number already in the store,
  seconds old, because the reading is per credential and the chip is per task.
  `firstPollDelay` now schedules the first ask against the shared reading's
  age, so a cold entry still asks at once and a warm one waits out the
  remainder. Staleness stays bounded by the interval instead of the interval
  plus however long ago somebody last switched tasks.
- **Scope.** claude, codex and devin. The other agents have no measured
  source, and Orca's answer for them is a hidden PTY that runs the agent's own
  `/usage` and scrapes the TUI, which is the part of their implementation that
  would be worst to copy.
