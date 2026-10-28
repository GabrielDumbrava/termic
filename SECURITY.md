# Security policy

## Reporting a vulnerability

Report it privately through GitHub:
[Security > Report a vulnerability](https://github.com/simion/termic/security/advisories/new).
Please do not open a public issue or PR for it.

Include the Termic version, your OS, and the steps or a proof of concept.
The report stays private between you and the maintainer until a fix ships,
and you are credited in the advisory unless you ask not to be.

Hardening ideas that are not an exploitable bug (a stricter default, a
missing check with no known way to abuse it) are fine as a normal issue.

## Supported versions

Only the latest release. Termic updates itself, and fixes ship as a new
release rather than a backport.

## What counts

Termic runs agents with real shell access on your machine, so the
boundaries it draws are the interesting part:

- Escaping the agent sandbox, or reaching hosts or files it should deny
  ([docs/sandbox.md](docs/sandbox.md)).
- Anything that lets a web page, a repo's content, a PR comment or an
  agent's output run code or read files outside what Termic intends.
- The local control surfaces: the `termic` CLI socket and token, the MCP
  endpoint, and LAN pairing between machines ([docs/peers.md](docs/peers.md)).
- The webview's content security policy (`src-tauri/tauri.conf.json`).
- The update channel and the signed builds.

Out of scope: what an agent does with the access you give it outside the
sandbox (YOLO mode on an unsandboxed task is that access, by design), and
bugs in the agent CLIs themselves, which belong to their vendors.
