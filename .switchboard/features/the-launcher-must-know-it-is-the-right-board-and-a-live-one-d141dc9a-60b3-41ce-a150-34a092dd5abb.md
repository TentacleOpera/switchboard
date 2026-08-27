# The Launcher Must Know It Is The Right Board, And A Live One

**Complexity:** 4

## Goal

Make the switchboard launcher prove two things it currently guesses: that the board answering on the port belongs to this workspace, and that a port file means a live process.

The launcher skill states the hazard correctly in its own preamble - a port file is not liveness, it survives a crashed extension, and every workspace port file holds the same port because the standalone CLI pins a default. Having named it, the skill then branches on an HTTP status code alone and discards the response body, even though the health payload already returns the roots that would answer the question. The previous version of that document performed the check, so this is a guard that regressed. The adopt call then omits the workspace root entirely and the server substitutes its own, which is how the orchestrator seat gets adopted for a workspace the user is not in.

The liveness half has the mirrored problem. Inside an agent sandbox, loopback curl returns 000 even when the board is up, so a shipped fix made the launcher fail safe: with a port file present and liveness unconfirmed, do not spawn. That traded a destructive failure for a recoverable one, and left a false positive - after a genuine crash the port file survives and the launcher now refuses to start a board forever, with undiscoverable manual recovery. What is needed is a filesystem object backed by a kernel object that dies with the process.

## How the Subtasks Achieve This

- **/switchboard Accepts Any Board On The Shared Port**: cross-checks the workspace root against `health.roots` — a guard that previously existed and regressed — and makes the adopt call send its workspace root and the server reject one it does not serve, instead of silently substituting its own. Adopting the orchestrator seat for the wrong workspace becomes impossible rather than unlikely.
- **Sandbox-Surviving Board Liveness Via A Unix Domain Socket**: gives the launcher a liveness signal that is accurate inside an agent sandbox, so it can tell a board it cannot reach over TCP from a board that is actually dead — and launch only in the second case.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Sandbox-Surviving Board Liveness via a Unix Domain Socket](../plans/sandbox-surviving-board-liveness-via-unix-socket.md) — **CREATED** — ID: 0da8db54-0ac8-4d83-9090-640ec099ed37
- [ ] [`/switchboard` accepts any board on the shared port and adopts the wrong workspace — verify identity on both sides of the adopt call](../plans/switchboard-launcher-adopts-the-wrong-workspace.md) — **CREATED** — ID: 928f142e-89b8-4a6d-8d5b-abbe3800258f
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints, but sequence rather than parallelise: both edit the launcher's identity and liveness checks in the same skill document, and concurrent edits there conflict.

The two are complementary halves of one question the launcher currently guesses at. Identity asks *is this my board*; liveness asks *is any board alive*. Getting one right without the other still leaves a wrong answer available: a live board that fails the identity check must not be hijacked, and a dead board that passes a stale port-file check must not block a launch forever.

The recorded history matters for whoever codes these. A shipped fix (`switchboard-launcher-sandbox-false-negative-health-check`) already traded a destructive failure — sandboxed `curl` returning 000, the launcher concluding dead, spawning, overwriting the port file and hijacking a live session — for a recoverable one, and said so explicitly. The liveness subtask closes that plan's own Outstanding Question 2. Do not reintroduce a spawn-on-unconfirmed path while implementing it: fail-safe is the current behaviour and the floor, and the socket is what lets the launcher do better than failing safe.

Both hosts unlink the port file on clean shutdown, so its presence is a decent proxy for exactly the case where it lies — an unclean exit. That is the case the socket has to cover.
