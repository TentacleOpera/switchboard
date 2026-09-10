# Terminal Group Lifecycle and Host Shutdown

**Complexity:** 7

## Goal

Make terminal groups ephemeral and make host shutdown safe, so a maintenance restart preserves work instead of destroying it. Groups become impromptu arrangements that die with their terminals or a crash, but survive a clean restart if their seats survive adoption. The shutdown path stops tearing the host down partway, and the PTY host outlives the board so seats can be adopted on restart.

## How the Subtasks Achieve This

- **`switchboard stop` Tears the Host Down and Leaves the Process Running**: Fixes the `/shutdown` path that today accepts, stalls partway, and latches so no retry can finish it. This is the hard prerequisite — the groups plan's sidecar write and the adoption plan's clean teardown both depend on a shutdown path that can actually close its own handles.
- **The PTY Host Should Outlive the Board, Not Die With It**: Makes the Go PTY host survive a board restart via a state file + adoption probe, so seats are adopted on the next start instead of destroyed. This is what makes the groups plan's sidecar useful — without adoption, seats die on restart and the sidecar points at dead names.
- **Groups Are Ephemeral, Teams Are Durable — One Store Cannot Be Both**: Moves manual groups out of the shared durable config DB into host in-memory session state with a crash-safe sidecar. Groups die with their terminals or a crash, but survive a clean maintenance restart if their seats survived adoption. FILL GRID becomes the sole creation path; `SAVE AS GROUP` is removed.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The PTY Host Should Outlive the Board, Not Die With It](../plans/the-pty-host-should-outlive-the-board-not-die-with-it.md) — **LEAD CODED** — ID: 0ae4378c-cbf9-4213-98f4-ccf57574119c
- [ ] [`switchboard stop` Tears the Host Down and Leaves the Process Running](../plans/switchboard-stop-tears-down-the-host-and-leaves-the-process-running.md) — **LEAD CODED** — ID: 3a0561b9-673b-4502-9e87-adca159eb1fb
- [ ] [Groups Are Ephemeral, Teams Are Durable — One Store Cannot Be Both](../plans/groups-are-ephemeral-teams-are-durable-one-store-cannot-be-both.md) — **LEAD CODED** — ID: b8aec6cd-3de8-4f4a-be22-79260e152c84
<!-- END SUBTASKS -->

## Dependencies & sequencing

Hard ordering: **`switchboard stop` Tears the Host Down** must land first. The `/shutdown` path today accepts, stalls partway, and latches — writing a sidecar or running a clean teardown against a shutdown that cannot close its own handles makes the failure worse.

Soft ordering: **The PTY Host Should Outlive the Board** should land second. Its adoption path is what makes the groups plan's sidecar useful — without it, seats die on restart, the sidecar points at dead names, and groups die on every restart (degrades gracefully to current behaviour). The sidecar is forward-compatible: harmless until adoption lands, then preserves groups.

Last: **Groups Are Ephemeral, Teams Are Durable**. Its sidecar write depends on the shutdown fix (hard), and its survival model depends on the adoption path (soft). Landing it before either dependency means the sidecar is inert and groups die on every restart — correct but not the intended end state.

## Implementation Summary

All three subtasks implemented and committed (b5dba3df). `switchboard stop` now unifies signal and /shutdown teardown behind a re-entrancy-latched teardownAndExit with a bounded force-exit timer, and the CLI replaces its fixed sleep with a liveness poll plus a Linux starttime recycle guard that fails loudly if the process survives. The PTY host gains a `--survive-parent` flag that gates the parent-death watcher, a 0600 state file recording host identity, and a PtyHostSupervisor adoption probe (protocol-version gated) wired in both composition roots; /health surfaces adopted-vs-spawned identity and `stop --fleet` tears a surviving host down. Manual groups (`grp_`) moved out of the durable config DB into an in-memory ManualGroupStore with a 0600 sidecar written on clean /shutdown and restored on boot intersected with the live adopted fleet; SAVE AS GROUP is retired and FILL GRID is the sole creation path, with terminal exits evicting members and reaping empty groups.
