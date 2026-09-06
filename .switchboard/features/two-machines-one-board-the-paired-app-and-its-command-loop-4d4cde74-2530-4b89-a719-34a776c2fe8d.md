# Switchboard Installs Like an Application — One Machine, or Two Paired

> **Unparked 2026-09-06.** The park condition was *"move it back when step 1 lands"* — storage
> step 1, *Move the database behind a single sidecar owner and replace sql.js with a real SQLite
> binding*. It has landed: `sidecar-owned-db-real-sqlite-binding` and
> `single-global-database-in-home-store` (step 4) are both **COMPLETED**, sql.js is gone from
> production dependencies, `better-sqlite3` 12.11.1 is the only driver, and the board lives at
> `~/.switchboard/boards/<workspaceId>.db`. Step 7 (shared stores) remains open and the park never
> depended on it.

**Complexity:** 9

## Goal

Ship Switchboard as something you launch rather than something you open an IDE to reach, and make joining a second machine a handshake instead of a networking exercise, with the operator choosing which machine holds the board and which runs the agents. The remote command vocabulary that loop speaks is deliberately closed at two verbs, because a third turns a reviewed-plan pipeline into a remote shell.

## How the Subtasks Achieve This

- **An app that pairs two machines and lets you choose which holds the board** — the productisation: a launcher, a pairing handshake, and the mode matrix for which machine holds the board and which runs the agents.
- **The remote command vocabulary is closed at two verbs** — completes the cloud-to-local control loop and fixes the vocabulary that loop speaks, so it cannot grow into a remote shell.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The remote command vocabulary is closed at two verbs, because the third one turns a reviewed-plan pipeline into a remote shell](../plans/the-remote-command-vocabulary-is-closed.md) — **CODE REVIEWED** — ID: 767be11f-f733-4737-aafa-ff55ae188299
- [ ] [Switchboard Installs Like an Application — Desktop Entry, Settings GUI, and Pairing Only When You Want It](../plans/switchboard-as-a-local-app-and-a-self-hosted-remote.md) — **CODE REVIEWED** — ID: 9adefb23-5f90-4a9d-b8b7-f56ba1f78872
- [ ] [Agents Write to an Intake Folder, and the Scanner Watches Only That](../plans/the-plan-watcher-is-a-setting-when-the-board-does-not-own-the-tree.md) — **CODE REVIEWED** — ID: 65f5b055-ffae-443f-88d7-65e072daa8b1
- [ ] [A Raspberry Pi Installs Switchboard With `apt`, Not Six Manual Steps and a Template to Hand-Edit](../plans/raspberry-pi-installs-switchboard-with-apt.md) — **CODE REVIEWED** — ID: 179c1a28-df2b-4cf9-8e4f-d265adfe1964
- [ ] [Every Shipped Autostart Template on All Three Platforms Invokes `switchboard start`, Which Was Removed and Exits 1](../plans/autostart-unit-invokes-removed-switchboard-start.md) — **CODE REVIEWED** — ID: bd730499-0f9d-4819-abac-158358dc0f09
<!-- END SUBTASKS -->

## Dependencies & sequencing

The vocabulary can be specified in parallel but must land before the app exposes the loop to users. The app plan names as hard prerequisites: **Storage Topology and the Shared/Runtime Schema Split**, its board-read-endpoints subtask, and standalone-remote-access-story (already CODE REVIEWED, so satisfied).


## Review Findings

All five subtasks were reviewed in place against their own plan files. Two subtasks are complete as
delivered or after small fixes — the autostart templates (no changes needed) and the intake watcher
(three fixes: an archive-clobbering rename, a collision check in the wrong directory, and three
writers doing a pointless intake→archive hop that could double-import). The remote vocabulary is
enforced and wired at the single construction site, but its gate was fail-*open* when columns were
absent, its run-history seam had no persisted backing field, its documentation obligation was not
done, and its contract test required a `dist/` path webpack never emits and was invoked by neither
`package.json` nor CI — all fixed. The Pi package shipped four defects that each yield a unit that
never starts (systemd does not expand `${VAR}` in `User=`/`WorkingDirectory=`/`Environment=`; the
symlinked CLI was not executable; `--import` copied the board to a path nothing reads; `exitFlushed`
falls through so a bad workspace still enabled the service) — all fixed, but **nothing was verified
on arm64 hardware, so that subtask's verdict is provisional**. The app subtask's `/settings` write
and `/pair` endpoints were non-functional scaffolding and were removed; see its `### Review
Deviations`. Two separate landmines were caught: `machineAttribution.ts` planted a top-level
`vscode` import into `KanbanDatabase`'s require graph, breaking every headless consumer, and the
implementation commit left `protocol-catalog.json` stale so `npm test`'s first gate was red.

## Deferred Findings

See each subtask plan's own `## Deferred Findings` section. Feature-level:

- CRITICAL `src/services/ArchiveManager.ts:1` — pre-existing and NOT this feature's doing, but it makes a band of CI gates red on `main`: `ArchiveManager` statically imports `vscode`, `RetentionService` imports it, and `LocalApiServer:15` imports that, so every contract test that loads `LocalApiServer` from `out/` dies at require time (`test:contract:workspace-root-write-path`, `task-complete`, `queue-pipeline`, and others the workflow invokes). Verified against HEAD: both imports long predate this work.
- MAJOR `src/test/cli-board-commands-contract.test.js` — also red at HEAD and unrelated: it opens `.agents/protocols/switchboard-mission-control/SKILL.md`, which does not exist (`.agents/protocols/` holds only `improve-feature` and `improve-plan`).
- MAJOR — the feature's own sequencing note says the vocabulary "must land before the app exposes the loop to users". It did; but the app subtask exposes nothing yet, so the ordering constraint is satisfied vacuously rather than exercised.
