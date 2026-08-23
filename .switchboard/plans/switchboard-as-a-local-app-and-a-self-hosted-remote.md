# Switchboard as an app you launch and a remote you install, not only an extension you open an IDE to reach

## Goal

Ship two packaged forms beyond the VSIX: a **local app** an operator launches from the taskbar or dock, and **Switchboard Remote**, a program installed on a machine they own — a Mac mini, a home server, a VPS — that owns the board and serves every other machine. Between them, three postures are all first-class: everything local, everything on your own remote, or the hybrid where the non-thrashing operations live on Turso.

### Problem Analysis

**Today reaching the board means opening an IDE.** `main` is `./dist/extension.js` and the shipped artifacts are the VSIX matrix built by `scripts/package-targets.sh` (four platform targets plus a universal fallback, staged per-target because `node-pty` prebuilds are 58 MB). There is a `bin` — `switchboard` → `./dist/standalone/cli.js` — so a standalone host exists and serves the browser shell, but it is a terminal command a developer runs, not something an operator launches. The board is a thing you get to by way of an editor.

**That is a poor fit for what the board is.** It is a persistent, always-on surface: the plan scanner sweeps every 10 seconds by default, `AutoArchiveService` sweeps every 5 minutes, provider sync polls, teams and terminals have liveness. All of it stops when the editor closes. An operator who wants their board visible while not writing code has to keep an IDE open to hold it.

**And the remote posture has no artifact at all.** `grep` for `electron`, `tauri`, `menubar`, `launchd`, `systemd` across `package.json`, `scripts/` and `src/standalone/` returns only incidental Electron-ABI commentary in `ptyHost.ts`. There is no daemon packaging, no service definition, no non-loopback story, and `LocalApiServer` binds to `127.0.0.1` — which is correct for today's threat model and is precisely what a self-hosted remote must change, carefully.

**The storage work makes both forms newly coherent.** Once the sidecar owns the database and every client reaches it over HTTP (`sidecar-owned-db-real-sqlite-binding.md`), the difference between "the sidecar on this machine" and "the sidecar on the Mac mini" is a URL. The architecture for a self-hosted remote is a consequence of a decision already taken for other reasons; what is missing is packaging, binding, and authentication.

### Root Cause

Switchboard began as an extension, so its unit of distribution was an extension. Every capability since — the standalone host, the browser shell, the API server, the sidecar — has moved toward being a service, without the packaging ever following.

### Non-goals

- A Switchboard-hosted service. There is no SaaS. Every remote is the operator's own machine; Switchboard ships the program, never the hosting.
- Replacing the VSIX. The extension stays, and in-IDE remains a first-class client.
- Rewriting the UI. The browser shell already is the app's UI; this packages it.
- Multi-tenancy. A self-hosted remote serves one operator or one trusted team, matching the attribution-not-authorisation posture.

## Metadata

**Complexity:** 9
**Tags:** devops, infrastructure, backend, security, ux, feature, cli

## User Review Required

Yes — four decisions.

1. **Local app shell.** A full desktop wrapper (Electron/Tauri) versus a tray/menubar launcher that supervises the existing standalone host and opens the shell in the default browser. Recommendation: **the tray launcher.** It is a fraction of the work, ships no second browser engine, keeps the shell as the one UI, and gives the taskbar presence the requirement actually asks for. A full wrapper can follow if window management demands it.
2. **Remote packaging.** Recommendation: a **service install** — `launchd` on macOS, `systemd` on Linux — driven by a `switchboard remote install` subcommand on the existing `bin`, plus a container image for anyone who prefers it. Not an installer GUI.
3. **Transport for remote access.** Recommendation: **HTTPS with a token, and refuse plain HTTP on any non-loopback bind.** Document putting it behind a tunnel or reverse proxy as the recommended deployment, but do not *depend* on one, because "it's only on my LAN" is how boards end up unauthenticated on a coffee-shop network.
4. **Does the remote run PTYs and agents, or only the board?** Recommendation: **board and sync only in the first cut.** Remote PTYs mean remote code execution as a product feature, and it deserves its own plan and its own threat model rather than arriving as a side effect of packaging.

## Complexity Audit

### Routine

- A `switchboard remote` subcommand group (install, start, stop, status) on the existing `bin`.
- Service unit templates for `launchd` and `systemd`.
- Tray/menubar binaries per platform that supervise the standalone host and expose start/stop/open.

### Complex / Risky

- **Unbinding from loopback is the single most dangerous change in this plan.** `LocalApiServer` on `127.0.0.1` is currently a security boundary doing real work. Moving off it converts every existing endpoint into a remotely reachable surface at once — including the verb routers, the kanban mutation paths, and anything that shells out. The bind change must be gated on authentication existing and being mandatory, and the audit is per-endpoint, not global.
- **The auth model has to be built, not configured.** Today's model is "you are on this machine". A remote needs tokens, expiry, revocation, and a first-run secret that is not a default. Attribution is not authorisation (`sync-owner-lease-and-write-attribution.md`), so a token is the whole boundary and has to behave like one.
- **`node-pty` and the binding matrix multiply.** The VSIX matrix already exists because of `node-pty` prebuilds; now the tray app and the remote service need their own platform matrices, and the remote needs the SQLite binding for its platform. Following the "board and sync only" recommendation removes `node-pty` from the remote entirely, which is most of the difficulty — worth stating as a reason for that recommendation rather than only a consequence.
- **Two sidecars must never own one store.** A tray app and an IDE extension on one machine, or a local host and a remote both pointed at the same database, is the clobber scenario the sidecar plan exists to end. Needs a lock and a clear "another Switchboard owns this store" state, discoverable from the Database panel.
- **Update and lifecycle.** A VSIX updates through the Marketplace. A tray app and a service do not. Version skew between an old extension and a newer remote is the schema-migration hazard from the libSQL plan in a second guise, and needs the same refusal-not-downgrade rule.
- **The remote is unattended.** No one sees a dialog. Every failure mode has to be legible in a log and over a status endpoint, and nothing may block on interactive input — including the secrets store, which currently assumes a user is present.

## Edge-Case & Dependency Audit

**Race conditions**
- Tray app and IDE extension starting simultaneously and both trying to become the sidecar. Single-flight on a lock, first wins, second attaches as a client.
- Service restart mid-migration; the migration must be resumable, which the storage plans already require.

**Security**
- The bind audit is the gate for everything else in this plan.
- Secrets on an unattended host: the encrypted store's master key cannot be protected by a user session that does not exist. State the reduced guarantee honestly rather than implying parity with a desktop.
- A self-hosted remote holds every project the operator works on. Filesystem permissions, `0600` databases, and a refusal to run as root.
- Default-deny: a fresh remote with no token configured must serve nothing but a setup path, never an open board.

**Side effects**
- The Database panel gains "which host owns this store" and remote reachability — it becomes the surface where the posture is visible.
- `/switchboard-cloud` and remote agents get a real endpoint to talk to, which is the capability the whole storage arc has been circling.
- `isPtyAvailable()`-style degradation is the precedent for every capability the remote lacks: the shell should hide what the host cannot do, exactly as the panel manifest already gates `terminals` on `ptyReady`.

**Migration**
- Nothing to migrate for existing installs; both forms are new artifacts and the VSIX is untouched. An operator moving from local to remote uses the store adoption flow from the libSQL plan, which is where that risk already lives.

## Dependencies

- **Hard prerequisite:** the sidecar plan. Without a single owner reachable over HTTP, a remote is a second writer.
- **Hard prerequisite:** the storage topology plan, which decides what a remote actually holds (Board, and Archive if it follows the target; never Runtime).
- **Pairs with** the libSQL plan — a self-hosted remote and a libSQL target are two answers to the same question, and the panel presents both.
- **Blocks nothing**, but its bind-audit work is a prerequisite for anything else that exposes the API beyond loopback.

## Adversarial Synthesis

Key risks: unbinding from loopback converts every existing endpoint into a remotely reachable surface simultaneously, and loopback is currently doing real security work; the auth model must be built rather than configured, because attribution is explicitly not authorisation; two sidecars owning one store is the clobber scenario the sidecar plan exists to end, and two new launch paths make it likelier; and an unattended host cannot protect a master key with a user session or surface a dialog. Mitigations: bind change gated on mandatory auth with a per-endpoint audit; default-deny on a fresh remote; a store lock with an "another Switchboard owns this" state visible in the panel; board-and-sync-only first cut, which removes `node-pty` and remote code execution from the remote entirely; and honestly stated reduced secret guarantees on unattended hosts.

## Proposed Changes

1. **A tray/menubar launcher** per platform that supervises the existing standalone host, shows running state, and opens the shell — taskbar presence without a second browser engine.
2. **`switchboard remote install|start|stop|status`** on the existing `bin`, writing a `launchd` or `systemd` unit; plus a container image.
3. **A per-endpoint bind audit** of `LocalApiServer`, and a hard refusal to bind non-loopback unless authentication is configured and plain HTTP is off.
4. **Token authentication** with expiry and revocation, default-deny on first run, and a setup-only surface until configured.
5. **A store ownership lock** with a discoverable "another Switchboard owns this store" state surfaced in the Database panel.
6. **Version-skew refusal** between client and remote, matching the migration rule: refuse, never downgrade.
7. **Capability gating** so the shell hides what a given host cannot do, following the `terminals`/`ptyReady` precedent already in the panel manifest.
8. **Board-and-sync-only remote** in the first cut; remote PTYs deferred to their own plan with their own threat model.

### Migration

No existing install is affected; the VSIX is unchanged and remains a first-class client. Moving a board to a remote uses the store adoption and rollback flows already specified.

## Verification Plan

- **Bind refusal:** attempt a non-loopback bind with no auth configured. Assert refusal with a clear reason. Attempt plain HTTP non-loopback; assert refusal.
- **Default-deny:** a fresh remote with no token. Assert every endpoint except the setup path returns unauthorized, and that no board data is served.
- **Per-endpoint audit:** an enumeration test asserting every registered route declares an auth requirement, so a new route cannot be added unauthenticated by omission.
- **Single ownership:** start the tray app and an IDE extension against one store. Assert exactly one becomes owner, the other attaches as a client, and the panel names the owner.
- **Three postures end-to-end:** all-local; all-remote against a self-hosted service; hybrid with Board on Turso and Runtime local. Assert each works and that the hybrid produces zero remote writes for liveness.
- **Unattended failure legibility:** kill the store mid-operation on a headless remote. Assert the failure appears in the log and the status endpoint, and that nothing waits on interactive input.
- **Version skew:** an old client against a newer remote and the reverse. Assert refusal with an actionable message, and that no migration ran.
- **Capability gating:** a remote without `node-pty`. Assert terminal surfaces are hidden rather than broken, matching the existing manifest behaviour.
- **Service lifecycle:** install, reboot the host, assert the remote came back and reattached; stop and uninstall, assert nothing is left running and no data was removed.

## Outstanding Questions

- Tray launcher per platform is three binaries to sign and notarise; is that acceptable, or should macOS ship first and others follow?
- Does the remote need its own web login (sessions, a password) or is a bearer token in the client's config sufficient for a single-operator or small-team deployment?
- Should the remote be able to run the plan scanner against repositories it can see, or is scanning strictly a client-side activity? This decides whether the remote needs filesystem access to code at all.
