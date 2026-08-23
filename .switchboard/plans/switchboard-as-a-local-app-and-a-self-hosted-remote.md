# An app that pairs two machines and lets you choose which one holds the board and which one runs the agents

## Goal

Ship Switchboard as something you launch rather than something you open an IDE to reach, and make joining a second machine a handshake instead of a networking exercise. The app's real job is **mode selection**: board here or there, agents here or there, established over a tunnel to loopback — never by opening a port.

> **Correction — this plan's first draft was wrong about the mechanism.** It proposed binding `LocalApiServer` off `127.0.0.1` behind mandatory auth. That is the wrong direction: `standalone-remote-access-story.md` documents loopback as enforced in four independent places plus WS-upgrade, CORS and cookie policy, backed by a documented DNS-rebinding threat model in `src/utils/loopbackHostname.ts` and a contract test forbidding a second copy of the predicate — and it establishes that **an SSH tunnel already passes every guard with no code change**. The correct design keeps the loopback lockdown absolute and tunnels to it. That also removes the reason the first draft deferred remote execution.

### Problem Analysis

**Reaching the board means opening an IDE.** `main` is `./dist/extension.js`; the shipped artifacts are the VSIX matrix from `scripts/package-targets.sh`. There is a `bin` — `switchboard` → `./dist/standalone/cli.js` — so a standalone host exists and serves the browser shell, but it is a terminal command a developer runs, not something an operator launches. Meanwhile the board is inherently always-on: the plan scanner sweeps every 10s by default, `AutoArchiveService` every 5 minutes, provider sync polls, teams and terminals hold liveness. All of it stops when the editor closes.

**Two-machine operation works and is undiscoverable.** Per `standalone-remote-access-story.md`, `ssh -L 7777:127.0.0.1:7777 you@host` then `http://127.0.0.1:7777/?token=…` passes all four guards, streams terminals (`terminals.js:200` derives the WS URL from `location.host`), and serves the API for agent clients on the same port. A reverse proxy works on the same basis given `proxy_set_header Host switchboard.localhost`. That plan's own finding is that the rigour "is real but invisible" — so today the capability exists and nobody can find it, and the two-machine setup is a manual tunnel an operator has to know to build.

**The mode choice is the actual product decision, and it is currently unexpressible.** Two axes — where the Board store lives, and where agents run — give four combinations, and the two worth naming pull in different directions:

- **Local board, local agents.** Today's shape, and the zero-configuration default. One machine owns everything; nothing is paired; no tunnel exists. This is a named mode, not an unnamed baseline — it must stay reachable with no setup, and no part of the pairing surface may be a precondition for it.
- **Remote board, local agents.** The board and its sync live on the always-on machine; PTYs and teams run on the laptop you are sitting at. Your board survives the laptop sleeping; your agents use the hardware in front of you, with your local checkouts.
- **Remote board, remote agents.** The always-on machine does everything; the laptop is a thin client onto its shell. Agents keep working while the laptop is shut.

**And these two cost very different amounts, which is the sequencing insight.** Remote-board-remote-agents needs *nothing* from the storage programme — the laptop runs no host, holds no store, syncs nothing; it opens the remote's shell through a tunnel. Remote-board-local-agents is the one that needs the store target, the tier split and the sync-owner lease, because two hosts are then live against one board.

### Root Cause

Switchboard began as an extension, so its unit of distribution was an extension. Every capability since — standalone host, browser shell, API server, sidecar — has moved toward being a service, and the packaging never followed. The loopback posture was then hardened correctly and documented nowhere, so the supported path to two-machine use exists only in the code that enforces it.

### Non-goals

- **Binding off loopback.** Explicitly out of scope, and the plan should be read as forbidding it. All four guards stay; so do the WS-upgrade predicate, the loopback-only CORS mirror and `SameSite=Strict`.
- A Switchboard-hosted service. Every remote is the operator's own machine.
- Replacing the VSIX. In-IDE stays a first-class client.
- Rewriting the UI. The browser shell already is the app's UI.
- Multi-tenancy. One operator, or one trusted team, matching the attribution-not-authorisation posture.

## Metadata

**Complexity:** 9
**Tags:** devops, infrastructure, backend, security, ux, feature, cli

## User Review Required

Yes — four decisions.

1. **App shell.** A full desktop wrapper (Electron/Tauri) versus a tray/menubar launcher supervising the standalone host and opening the shell in the default browser. Recommendation: **tray launcher** — a fraction of the work, no second browser engine, keeps the shell as the one UI, and delivers the taskbar presence the requirement asks for.
2. **Tunnel transport.** Recommendation: **support both SSH and Tailscale, detect what is present, and never implement our own tunnel.** SSH is universal and already works; Tailscale is what most people actually want for a machine that moves between networks. Both terminate on the remote's loopback, so both inherit every existing guard.
3. **Which mode ships first.** Recommendation: **local-board-local-agents is not "shipped", it is preserved** — it works today and the test that matters is that none of this work regresses it. Of the two new modes, **remote-board-remote-agents** first, because it needs none of the storage programme: packaging plus a tunnel plus a thin client. Remote-board-local-agents follows once the store target and sync lease land.
4. **Does the app manage tunnel lifecycle, or just document and detect it?** Recommendation: **manage it** — establish, monitor, re-establish, and show its state. A mode picker that silently depends on a tunnel the operator maintains by hand is the discoverability failure this plan exists to fix, one layer up.

## Complexity Audit

### Routine

- A tray/menubar launcher per platform supervising the existing standalone host, with start/stop/open and running state.
- A `switchboard remote install|start|stop|status` subcommand group writing a `launchd` or `systemd` unit, plus a container image.
- Surfacing the current mode and tunnel health in the Database panel's status contract.

### Complex / Risky

- **Pairing is a key-exchange problem wearing a friendly hat.** "Easy handshake" must not become "paste this token into that box" with a token that never expires, nor a discovery protocol that trusts the LAN. Recommendation: pairing rides the tunnel that already authenticates — SSH keys or Tailscale identity — and Switchboard's own credential is provisioned *through* the established tunnel, never over an unauthenticated channel. The app's job is to make that sequence one button, not to invent a second trust system beside it.
- **The durable session token is a hard prerequisite, not a nicety.** `standalone-remote-access-story.md` notes a bearer credential that dies on every relaunch makes remote agent use impractical. A supervised service that restarts on reboot needs a stable credential or every reboot breaks every paired client.
- **Two hosts, one store, is the clobber scenario.** A tray app and an IDE extension on one machine, or a local host and a remote both pointed at one database, is what the sidecar plan exists to prevent. Needs a store lock and a discoverable "another Switchboard owns this store" state.
- **Mode transitions are the part that will actually break.** Switching remote-agents → local-agents mid-session means live PTYs on the wrong machine. Terminals cannot migrate, so the honest behaviour is: a mode switch does not move running work; it changes where *new* work starts, and the UI must say which machine each existing terminal belongs to. Getting this wrong looks like terminals vanishing.
- **Tunnel loss is not a crash, and must not present as one.** The remote keeps working; the laptop loses its view. Every surface needs a disconnected state distinct from empty, and the reconnect must not duplicate dispatches — a dispatch acknowledged by the remote but unseen by the client is the case to get right.
- **Update and version skew.** A VSIX updates through the Marketplace; a tray app and a service do not. An old client against a newer remote is the schema-migration hazard again, and takes the same rule: refuse, never downgrade.
- **The remote is unattended.** No dialogs. Every failure must be legible in a log and over a status endpoint, and nothing may block on interactive input — including the secrets store, which currently assumes a user is present.

## Edge-Case & Dependency Audit

**Race conditions**
- Tray app and IDE extension racing to become the sidecar: single-flight on a lock, first wins, second attaches as a client.
- Tunnel re-establishing while a dispatch is in flight.
- Service restart mid-migration; resumability is already required by the storage plans.

**Security**
- **The loopback guards are load-bearing and stay.** A contract test should assert the bind address remains unconditional and that no configuration path can change it — the guard against a future well-meaning "just add a `--bind` flag".
- Secrets on an unattended host cannot be protected by a user session that does not exist. State the reduced guarantee rather than implying desktop parity.
- A self-hosted remote holds every project the operator works on: `0600` databases, `0700` directories, refuse to run as root.
- Remote execution's boundary is the tunnel's identity — SSH keys, Tailscale ACLs — which is materially stronger than a bearer token on an open port. That is *why* remote agents are acceptable here, and the plan should say so rather than leaving it implicit.

**Side effects**
- The Database panel gains mode, tunnel health, and store ownership — it becomes where the posture is visible.
- `/switchboard-cloud` and remote agents get a documented endpoint, which is the capability the whole storage arc has been circling.
- Capability gating already has a precedent: the panel manifest gates `terminals` on `ptyReady`. A remote without `node-pty`, or a thin client, should hide what its host cannot do rather than fail.

**Migration**
- Nothing to migrate; both forms are new artifacts and the VSIX is untouched. Moving a board between machines uses the store adoption and rollback flows from the libSQL plan.

## Dependencies

- **Hard prerequisite:** `standalone-remote-access-story.md`, especially its durable-session-token subtask and the tunnel-breakage fixes (the absolute-URL asset route). This plan is the productisation of that plan's posture.
- **Hard prerequisite:** the sidecar plan — without a single owner reachable over HTTP, a second host is a second writer.
- **Hard prerequisite:** `storage-topology-one-choice-three-stores.md` — decides what a remote holds (Board, Archive if it follows the target, never Runtime).
- **For remote-board-local-agents only:** the tier split, a store target, and the sync-owner lease. The remote-agents mode needs none of them.
- **Requires** `board-read-endpoints-must-survive-the-storage-topology.md` for the mode matrix to be complete for agents, not just for humans.

## Adversarial Synthesis

Key risks: the first draft's proposal to unbind from loopback would have dismantled a four-layer, threat-modelled guard to enable something a tunnel already does better; pairing can easily become an invented second trust system or a LAN-trusting discovery protocol; mode transitions cannot migrate live PTYs and will look like terminals vanishing if that is not stated in the UI; tunnel loss must read as disconnected rather than empty, without duplicating dispatches on reconnect; and an unattended host can neither show a dialog nor protect a master key with a user session. Mitigations: loopback kept absolute with a contract test forbidding a bind flag; pairing credentials provisioned only through an already-authenticated tunnel; mode switches defined to affect new work only, with per-terminal host labels; explicit disconnected states and idempotent dispatch on reconnect; and honestly stated reduced secret guarantees on unattended hosts.

## Proposed Changes

1. **A tray/menubar launcher** per platform supervising the standalone host, showing state, opening the shell.
2. **`switchboard remote install|start|stop|status`** writing a `launchd`/`systemd` unit, plus a container image.
3. **A pairing flow** in the app: detect SSH or Tailscale, establish the tunnel to the remote's loopback, provision the Switchboard credential through it, verify, and remember the peer. One button, no invented trust system.
4. **A mode picker** over the two axes — where the board lives, where agents run — with the three named modes as presets, local/local as the default, and the mode surfaced in the Database panel. Selecting local/local must require no pairing, no tunnel and no credential.
4b. **Identical agent board access in every mode.** Agents reach the board through the API, reads included — the migration off SQL is settled in `teams-reach-state-through-endpoints-not-host-files.md` and scoped in `skills-declare-preconditions-and-degrade.md`, and `board-read-endpoints-must-survive-the-storage-topology.md` makes the endpoints correct once there is a window, an Archive and a possibly-remote store. Without that, the mode matrix has a hole: agents can move cards in all three modes but can only read the board in one, and an archived card reads as nonexistent rather than archived.
5. **Tunnel lifecycle management**: monitor, re-establish, and expose health; a disconnected state distinct from empty on every dependent surface.
6. **Mode-transition semantics**: a switch changes where new work starts, never moves running terminals; every terminal is labelled with its host.
7. **A store ownership lock** with a discoverable "another Switchboard owns this store" state.
8. **Version-skew refusal** between client and remote — refuse, never downgrade.
9. **A loopback-invariance contract test** asserting the bind address is unconditional and no configuration path can alter it.

### Migration

No existing install affected; the VSIX is unchanged and stays a first-class client. Board relocation uses the already-specified adoption and rollback flows.

## Verification Plan

- **Loopback invariance:** assert the bind address is unconditional, that no flag, setting or env var changes it, and that the four guards plus the WS-upgrade predicate are intact. This is the regression test for this plan's own first draft.
- **Pairing:** from a clean pair of machines, complete pairing in the app and assert a working board over the tunnel — with no credential having crossed an unauthenticated channel.
- **All three modes end-to-end:** local board + local agents on a machine that has never been paired, with no tunnel, no credential and no configuration — the regression test for this whole programme; remote board + remote agents (laptop as thin client, agents surviving laptop shutdown); remote board + local agents (PTYs local, board remote, zero remote writes for liveness).
- **Agent parity across modes:** run the same agent board read and the same card move in all three modes; assert identical results in each.
- **Reboot survival:** reboot the remote. Assert the service returns, the durable token still authenticates, and paired clients reconnect without re-pairing.
- **Tunnel loss:** sever the tunnel mid-dispatch. Assert the client shows disconnected rather than empty, the remote continues, and reconnect neither duplicates the dispatch nor loses its acknowledgement.
- **Mode switch:** switch modes with live terminals on both machines. Assert no terminal is lost, each is labelled with its host, and only new work follows the new mode.
- **Single ownership:** tray app plus IDE extension against one store. Assert one owner, one client, and that the panel names the owner.
- **Unattended legibility:** kill the store mid-operation on a headless remote. Assert the failure reaches the log and the status endpoint and nothing waits on input.
- **Version skew:** old client against newer remote and the reverse. Assert refusal with an actionable message and no migration.
- **Capability gating:** a remote without `node-pty`. Assert terminal surfaces hide rather than break, matching the manifest's `ptyReady` behaviour.
- **Service lifecycle:** install, reboot, stop, uninstall. Assert nothing is left running and no data removed.

## Outstanding Questions

- Tray launchers are three binaries to sign and notarise. macOS first with others following, or all three at once?
- For remote-board-local-agents, does the local host reach the remote's *store* (a tunnelled sqld or sidecar) or does that mode effectively require a libSQL target? The first keeps everything self-hosted; the second is simpler to build.
- Should the remote run the plan scanner against repositories it can see, or is scanning strictly client-side? This decides whether the remote needs access to code at all.
- Is the fourth combination — board local, agents remote — worth supporting, or explicitly refused? It is coherent (laptop holds the board, the mini executes) but doubles the mode matrix.
