---
description: 'The standalone board runs as a service, not a foreground script'
---

# The standalone board runs as a service, not a foreground script

**Complexity:** 5

## Goal

Make `npx switchboard` deployable — on the dev laptop at login, or on a spare machine that never sleeps — instead of being a foreground process whose lifetime is the terminal that launched it. Three things block that today, and each is small on its own: the session secret is regenerated per launch so any restart 401s every open tab, there is no verb to start/stop/inspect the server, and the loopback-only posture is undocumented while one asset URL breaks under every documented way of reaching it remotely.

The common thread is that every ingredient already exists and none is wired to something a user can reach. `switchboard.apiToken` is already a shipped secret key the extension host reads and the standalone host ignores. `/health` already reports port, roots and terminal count, and `findRunningInstance` already probes it — privately, only to refuse a second instance. The loopback guards are already a single-source-of-truth module with an explicit DNS-rebinding threat model and a contract test forbidding a second copy. This feature surfaces what is already built rather than adding a subsystem.

Deliberately excluded: no `--bind` flag, no public exposure, no accounts, no hosted service. The four loopback guards are unchanged by every subtask here, and one subtask carries a verification step proving it.

## How the Subtasks Achieve This

- **Standalone auth is destroyed on every restart — adopt the already-shipped `switchboard.apiToken` as a durable session token**: teaches the standalone host's `getAuthToken` to prefer the stored secret over its per-launch `randomBytes(32)`, makes enrolment tokens mintable on demand rather than one per boot, closes the `TerminalWsGateway` auth bypass that would otherwise leave the board rendering while terminals hang, adds `switchboard token show|set|rotate|clear`, and pins a default port so the URL stops moving. Two cases it exists to fix: the `sb_session` cookie expires after 8 hours and the only token that can replace it is consumed on first use, so today the board locks the operator out with no restart involved and the only recovery is restarting the server — killing every running agent to regain a login. And `_checkAuth` reads an empty token as *allow everything*, so a blank stored secret must fail closed rather than silently disabling auth.
- **`npx switchboard` has no lifecycle — add detached start/stop/status/logs and per-OS autostart**: promotes the existing `findRunningInstance` + `/health` probe into a real `status` command, adds `start --detach` with a log sink, a graceful `stop` whose grace period covers the debounced `kanban.db` persist, and launchd/systemd-user/Task Scheduler templates carrying the two non-obvious requirements (Node ≥ 22 and an agent-CLI `PATH`) that a service manager does not inherit from a login shell.
- **The loopback lockdown is undocumented, and the asset route bakes the server port into absolute URLs**: states the four-guard posture as a deliberate decision and documents the supported ways through it, and fixes `TicketsPanelProvider._buildLocalAssetUrl` — the only non-origin-relative URL the board emits, which pins the real listening port and so breaks every ticket and design image under a port-shifted tunnel or a reverse proxy, and is mixed content behind HTTPS.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [`npx switchboard` has no lifecycle — add detached start/stop/status/logs and per-OS autostart](../plans/standalone-daemon-lifecycle.md) — **PLAN REVIEWED**
- [ ] [Standalone auth is destroyed on every restart — adopt the already-shipped `switchboard.apiToken` as a durable session token](../plans/standalone-durable-session-token.md) — **PLAN REVIEWED**
- [ ] [The loopback lockdown is undocumented, and the asset route bakes the server port into absolute URLs](../plans/standalone-remote-access-story.md) — **PLAN REVIEWED**
- [ ] [Remote external-team-lead verification over HTTP — close the file-inbox gap](../plans/remote-team-lead-verification-over-http.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

- **Durable session token first.** The other two are shippable alone but incomplete without it: `switchboard status` prints a board URL that 401s after any restart, an autostarted server is precisely the case where nobody is watching stdout for the replacement token, and the remote-access doc would have to instruct the reader to re-enrol from a terminal on every restart.
- **Lifecycle second.** It depends on nothing in the docs subtask, and the autostart units are only worth installing once a session survives the restarts they cause.
- **Remote access is independent and can run in parallel with either.** Its one code change (`_buildLocalAssetUrl`) touches a file neither other subtask opens. Two caveats for whoever takes it: the tunnel recipes are testable today without either other subtask landing, but the Tailscale path needs its exact working configuration verified before publishing rather than asserted — a tailnet name is not in the accepted Host set — and no snippet ships unrun, since an untested recipe in a security document is worse than no document.
