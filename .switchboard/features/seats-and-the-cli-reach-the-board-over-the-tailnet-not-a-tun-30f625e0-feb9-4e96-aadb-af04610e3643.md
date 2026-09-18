# Seats and the CLI Reach the Board Over the Tailnet, Not a Tunnel

**Complexity:** 5

## Goal

A board running on one machine — the Pi appliance — is operated from every other machine on the tailnet: an agent seat spawned over ssh or mosh reads its plan and reports next/done over HTTP, and an operator running switchboard on a laptop drives the same commands against the same board. Today the tailnet carries only the browser. The Node CLI is hardcoded to loopback, the host never tells a spawned seat where the board is, and the server answers a workspaceRoot it has never heard of with a byte-identical 200, so the only way through is a reverse tunnel that works by making the wrong assumption accidentally true. The six subtasks close that gap from both ends — the seat path and the operator path — around one shared endpoint, root and credential vocabulary, so a seat and a laptop resolve the same board by the same rules and every resolved value says where it came from.

## How the Subtasks Achieve This

The feature has one spine: **one resolution chain, resolved once, tagged with its source, read by both clients and fed by the host.** Each subtask owns one segment of it.

- **The host inlines seat identity and the board URL into a remote spawn** (complexity 5) — the host composes every spawn command itself, so it inlines the seat's identity and the board's tailnet URL into the remote command (`env SWITCHBOARD_TERMINAL=… SWITCHBOARD_AGENT_INSTANCE_ID=… SWITCHBOARD_SERVER_URL=… SWITCHBOARD_WORKSPACE_ROOT=… <innerCli>`) rather than hoping `ssh` forwards environment whose `AcceptEnv` it cannot guarantee. Allowlisted keys only — a credential never crosses in a typed command. This is the head of the chain: it produces the values everything downstream reads.
- **A tagged `ApiTarget` — one board resolution chain, both clients** (complexity 5) — one module that decides which board a command talks to, shaped like the Go client's shipped resolver and extended with the tiers this feature needs. It owns the whole precedence chain, including the env tier the seat path depends on, so there is exactly one implementation and the two clients cannot drift.
- **Every Node command dials the resolved target, not loopback** (complexity 5) — threads that target through the ~38 sites that currently take a port, so `apiRequest` builds its URL from the target instead of a `127.0.0.1` literal. Plus the three guards whose failures are silent: the argv splice that stops `--remote` before the verb launching a board on the laptop, the local-only subcommand refusals, and the token gate that stops a laptop's credential reaching the Pi.
- **The board refuses a `workspaceRoot` it does not serve** (complexity 4) — the server half. `_resolveKnownRoot` already exists with the right refusal and is wired only into two write handlers; this wires it into `_resolveDbFromQuery` and the seat-facing write routes, so a root the board does not serve is refused instead of silently answered from the host's own root.
- **Named remotes and the source line, in both clients** (complexity 5) — the operator layer: `switchboard remote add|list|remove|default` backed by `~/.switchboard/remotes.json` at `0600`, read identically by the Go binary and `npx switchboard`, plus the line every remote command prints naming the board it resolved and where that came from.
- **A remote machine's CLI path and working directory** (complexity 4) — so a remote seat runs *that* machine's binary in *that* machine's checkout, not the board host's absolute `dist/linux-arm64/switchboard` path on an x86_64 box.

The same rule runs through all six. A board endpoint, a workspace root and a credential are configuration, routing and identity reads, so each resolves to `{ value, source }` and the source is shown where it is used — and a named-but-unreachable board is an error, never a quiet demotion to loopback.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [A tagged ApiTarget — one board resolution chain, both clients](../plans/the-cli-reaches-a-remote-board-over-the-tailnet.md) — **CODE REVIEWED** — ID: 08fe2cb8-1920-465f-9d1b-d236ee1a6cd7
- [ ] [The host inlines seat identity and the board URL into a remote spawn](../plans/a-remote-seat-reaches-the-board-over-http-not-a-tunnel.md) — **CODE REVIEWED** — ID: af1fda8c-4990-474e-ba6c-76cc21a797f4
- [ ] [Every Node command dials the resolved target, not loopback](../plans/every-node-command-dials-the-resolved-target-not-loopback.md) — **CODE REVIEWED** — ID: cc536040-c1ca-4763-9695-79e12f6e5d87
- [ ] [The board refuses a workspaceRoot it does not serve](../plans/the-board-refuses-a-workspaceroot-it-does-not-serve.md) — **CODE REVIEWED** — ID: 8dd1bedb-06f4-47df-a181-f0df94ee91ea
- [ ] [Named remotes and the source line, in both clients](../plans/named-remotes-and-the-source-line-in-both-clients.md) — **CODE REVIEWED** — ID: e9ad0945-209f-41c2-b88d-52da5737dc3a
- [ ] [A remote machine's CLI path and working directory](../plans/a-remote-machines-cli-path-and-working-directory.md) — **CODE REVIEWED** — ID: 8bdf95e9-eaf7-4f63-b65e-ef9b7c2a3734
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Two hard orderings, both for the same reason: a subtask must not land before the thing that makes it safe.**

1. **The server refusal must not precede the env injection.** *The board refuses a `workspaceRoot` it does not serve* turns a silent-but-correct 200 into a loud 400. That is only safe once *The host inlines seat identity and the board URL into a remote spawn* is injecting `SWITCHBOARD_WORKSPACE_ROOT` into every seat's env — otherwise a worktree-cwd seat starts getting 400s with nothing to fix them.
2. **The resolver precedes its consumers.** *A tagged `ApiTarget`* defines `resolveApiTarget` and the precedence tiers; *Every Node command dials the resolved target* imports them, and *Named remotes and the source line* writes the config those tiers read and prints the source they carry.

**`src/standalone/cli.ts` is the contended file** — three subtasks touch it and they are deliberately serialized rather than run in parallel. *A tagged `ApiTarget`* takes the health probe, *Every Node command dials the resolved target* takes `apiRequest` and the call sites, *Named remotes* takes the new subcommand and the three whitelists. No two of them run in the same round.

**One implementation of the precedence chain, not two.** The earlier two-subtask split had the seat plan implementing an env tier in `cli.ts` and the CLI plan refactoring it into `apiTarget.ts` — the same seam, twice, by two coders. *A tagged `ApiTarget`* now owns it outright, including the env tier the seat path needs, which is what keeps the Go and Node clients from diverging. There is no third vocabulary: `--server` / `--endpoint` / `SWITCHBOARD_SERVER_URL` keep their existing behaviour, and `--remote` / `SWITCHBOARD_REMOTE` are added as a *higher* tier accepting a name or a URL. The seat path uses only the `SWITCHBOARD_SERVER_URL` tier, which is exactly what the host injects.

**Suggested rounds:** (1) the spawn env injection; (2) the `ApiTarget` resolver and the per-machine CLI path, in parallel; (3) the call-site conversion and the server refusal, in parallel; (4) named remotes and the source line.

**Out of scope for all six**, and tracked as follow-ups rather than folded in here: retargeting `controller`'s `ControllerApiRequest`, attaching to a remote pty over the WS hub, remote `stop`, and a credential-carrying seat. The seat design deliberately sends no token — tailnet-listener membership is its auth, and a credential must never be interpolated into a typed startup command, which lands in scrollback, `handle.startupCommand` and the spawn log.

**Prior work all six build on, all landed:** `go-cli-client-verbs` (the tagged `Resolved[T]` vocabulary and the `--server` / `--workspace-root` / `--token-file` names), `agents-are-saved-per-machine-and-a-team-picks-one` (machine threading, `renderSpawnCommand`, `startupCommandInner`), and `auth-belongs-at-a-boundary-and-a-local-cli-is-not-one` (tailnet membership is the remote device's credential).

## Review Findings

All six subtasks reviewed together as one delivery unit; the spine holds — one resolution chain in `src/standalone/apiTarget.ts` mirrored by `internal/client/resolve.go`, fed by the host's `seatEnv` inlining, consumed by every converted call site, backed by the server-side root refusal, and made visible by the printed source line. Six issues were fixed: no wall-clock guard on the resolver's health dial (`apiTarget.ts`, a hang with no output), the Go client answering a named-remote failure with local offline guidance (`cmd/switchboard/main.go`, wrong-machine advice and a client-parity divergence), two self-inflicted red assertions in `src/test/cli-remote-config-contract.test.js`, the two suites that pin this feature being defined but invoked by no CI gate, and a corrupt-`remotes.json` message that named no repair in either client. Files changed by this review: `src/standalone/apiTarget.ts`, `cmd/switchboard/main.go`, `internal/client/resolve.go`, `src/test/cli-remote-config-contract.test.js`, `.github/workflows/integration-tests.yml`. Verification: `tsc -p tsconfig.test.json` clean; `test:contract:api-target`, `test:contract:remote-config`, `test:contract:agent-machines` and `test:contract:workspace-root-write-path` all pass; `go build ./...`, `go vet`, `go test -count=1 ./internal/... ./cmd/...` all ok. Remaining risk: no step in this pass exercised a real second machine, so the end-to-end tailnet hop — a seat on box B reporting `next`/`done` to a board on box A with no tunnel — is still only pinned by resolution-level and message-shape assertions.

## Deferred Findings

- MAJOR (pre-existing, not this feature) `src/test/cli-board-commands-contract.test.js:1087` — the suite is invoked by CI and is currently RED on `ENOENT` for `.agents/protocols/switchboard-mission-control/SKILL.md`, a file that is untracked and absent from `HEAD`. Not caused by these six subtasks and out of their scope, but CI cannot be green until it is resolved.
- MAJOR (pre-existing, not this feature) `npm run catalog:check` reports drift from another agent's uncommitted `.agents/skills/*` and `src/services/bundledProtocols.ts` edits present in the working tree; not staged or touched by this review.
- NIT `npm test` cannot complete on this machine — its first step `standalone-parity:check` runs a webpack build that OOMs on the Pi. The three non-webpack members (`catalog:check`, `icons:parity`, `banner:check`) were run individually instead.
- Per-subtask NITs are listed under each subtask plan's own `## Deferred Findings`.
