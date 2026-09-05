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
- [ ] [The remote command vocabulary is closed at two verbs, because the third one turns a reviewed-plan pipeline into a remote shell](../plans/the-remote-command-vocabulary-is-closed.md) — **LEAD CODED** — ID: 767be11f-f733-4737-aafa-ff55ae188299
- [ ] [Switchboard Installs Like an Application — Desktop Entry, Settings GUI, and Pairing Only When You Want It](../plans/switchboard-as-a-local-app-and-a-self-hosted-remote.md) — **LEAD CODED** — ID: 9adefb23-5f90-4a9d-b8b7-f56ba1f78872
- [ ] [Agents Write to an Intake Folder, and the Scanner Watches Only That](../plans/the-plan-watcher-is-a-setting-when-the-board-does-not-own-the-tree.md) — **LEAD CODED** — ID: 65f5b055-ffae-443f-88d7-65e072daa8b1
- [ ] [A Raspberry Pi Installs Switchboard With `apt`, Not Six Manual Steps and a Template to Hand-Edit](../plans/raspberry-pi-installs-switchboard-with-apt.md) — **LEAD CODED** — ID: 179c1a28-df2b-4cf9-8e4f-d265adfe1964
- [ ] [Every Shipped Autostart Template on All Three Platforms Invokes `switchboard start`, Which Was Removed and Exits 1](../plans/autostart-unit-invokes-removed-switchboard-start.md) — **LEAD CODED** — ID: bd730499-0f9d-4819-abac-158358dc0f09
<!-- END SUBTASKS -->

## Dependencies & sequencing

The vocabulary can be specified in parallel but must land before the app exposes the loop to users. The app plan names as hard prerequisites: **Storage Topology and the Shared/Runtime Schema Split**, its board-read-endpoints subtask, and standalone-remote-access-story (already CODE REVIEWED, so satisfied).

