# Two Machines, One Board - the Paired App and Its Command Loop

<!-- board-collapse-07 -->
> **PARKED IN BACKLOG 2026-09-04 (Board Collapse 07).** Not cancelled — **unreachable until the storage programme's first step lands**: *Move the database behind a single sidecar owner and replace sql.js with a real SQLite binding*. sql.js holds the whole database in memory and rewrites the entire image on each persist, so nothing here that assumes concurrent or remote writers can be built on it. The full seven-step order is stated once, in the *Storage layer overhaul* feature file. Leaving these in Planned invited a coder to start one; move it back when step 1 lands.

**Complexity:** 9

## Goal

Ship Switchboard as something you launch rather than something you open an IDE to reach, and make joining a second machine a handshake instead of a networking exercise, with the operator choosing which machine holds the board and which runs the agents. The remote command vocabulary that loop speaks is deliberately closed at two verbs, because a third turns a reviewed-plan pipeline into a remote shell.

## How the Subtasks Achieve This

- **An app that pairs two machines and lets you choose which holds the board** — the productisation: a launcher, a pairing handshake, and the mode matrix for which machine holds the board and which runs the agents.
- **The remote command vocabulary is closed at two verbs** — completes the cloud-to-local control loop and fixes the vocabulary that loop speaks, so it cannot grow into a remote shell.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The remote command vocabulary is closed at two verbs, because the third one turns a reviewed-plan pipeline into a remote shell](../plans/the-remote-command-vocabulary-is-closed.md) — **BACKLOG** — ID: 767be11f-f733-4737-aafa-ff55ae188299
- [ ] [An app that pairs two machines and lets you choose which one holds the board and which one runs the agents](../plans/switchboard-as-a-local-app-and-a-self-hosted-remote.md) — **BACKLOG** — ID: 9adefb23-5f90-4a9d-b8b7-f56ba1f78872
- [ ] [The Plan Watcher Becomes a Setting, Because a Paired Board Does Not Own the Plans Tree](../plans/the-plan-watcher-is-a-setting-when-the-board-does-not-own-the-tree.md) — **BACKLOG** — ID: 65f5b055-ffae-443f-88d7-65e072daa8b1
<!-- END SUBTASKS -->

## Dependencies & sequencing

The vocabulary can be specified in parallel but must land before the app exposes the loop to users. The app plan names as hard prerequisites: **Storage Topology and the Shared/Runtime Schema Split**, its board-read-endpoints subtask, and standalone-remote-access-story (already CODE REVIEWED, so satisfied).

