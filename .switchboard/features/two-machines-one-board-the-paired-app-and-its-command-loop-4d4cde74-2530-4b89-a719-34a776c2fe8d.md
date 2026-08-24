# Two Machines, One Board - the Paired App and Its Command Loop

**Complexity:** 9

## Goal

Ship Switchboard as something you launch rather than something you open an IDE to reach, and make joining a second machine a handshake instead of a networking exercise, with the operator choosing which machine holds the board and which runs the agents. The remote command vocabulary that loop speaks is deliberately closed at two verbs, because a third turns a reviewed-plan pipeline into a remote shell.

## How the Subtasks Achieve This

- **An app that pairs two machines and lets you choose which holds the board** — the productisation: a launcher, a pairing handshake, and the mode matrix for which machine holds the board and which runs the agents.
- **The remote command vocabulary is closed at two verbs** — completes the cloud-to-local control loop and fixes the vocabulary that loop speaks, so it cannot grow into a remote shell.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The remote command vocabulary is closed at two verbs, because the third one turns a reviewed-plan pipeline into a remote shell](../plans/the-remote-command-vocabulary-is-closed.md) — **CREATED**
- [ ] [An app that pairs two machines and lets you choose which one holds the board and which one runs the agents](../plans/switchboard-as-a-local-app-and-a-self-hosted-remote.md) — **CREATED**
<!-- END SUBTASKS -->
## Dependencies & sequencing

The vocabulary can be specified in parallel but must land before the app exposes the loop to users. The app plan names as hard prerequisites: **Storage Topology and the Shared/Runtime Schema Split**, its board-read-endpoints subtask, and standalone-remote-access-story (already CODE REVIEWED, so satisfied).

