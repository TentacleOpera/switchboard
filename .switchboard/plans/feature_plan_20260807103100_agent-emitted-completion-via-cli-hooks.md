# Agent-Emitted Completion via CLI Hooks — BUILT, THEN REMOVED (superseded by output-silence detection)

> **This card is closed. Do not build it.** The work described here was implemented, code-reviewed, and then **removed from the tree on 2026-08-08**. It is retained as a historical record so the reasoning is not rediscovered from scratch. The replacement is `feature_plan_20260808083000_pty-turn-end-from-output-silence.md`.

## Goal

*(Original, for the record.)* Have PTY-fleet agents report their own turn boundaries to the LocalApiServer via the CLI's native hook mechanism, and use those events to (a) clear the activity light the instant a turn ends rather than on filesystem-watch latency, and (b) introduce a third card state — **blocked / waiting on you** — which the board could not represent at all.

## Metadata

- **Complexity:** 7
- **Tags:** backend, terminals, kanban, api, database, security, removed

## Why It Was Removed

**Hooks are a Claude-Code-only mechanism.** No other agent CLI in use — Codex, Gemini CLI, Aider, wrapper scripts, custom roles — exposes an equivalent lifecycle-event facility. The implementation therefore lit the board correctly for exactly one CLI and silently fell back to the blind 10-minute timer for every other agent.

A completion signal whose behaviour depends on which agent happened to be dispatched is worse than a uniform approximation: the operator cannot learn to trust the board, because the board means different things per seat. The capability was sound; the mechanism was not general.

Secondary factor: the design added real attack surface for that single-CLI benefit — an authenticated POST endpoint, an HMAC minter inside the fleet, a per-terminal token in the pty environment, a secret in the ptyHost child's argv (readable by any local process via `ps`), and a generated settings file written inside the user's workspace.

## What Was Removed

| File | Removed |
|---|---|
| `src/standalone/ptyFleetService.ts` | `_maybeWriteHookFile`, `_deleteHookFile`, `setHookContext`, `HookContext`, `CLAUDE_CLI_INVOCATIONS`, `SHELL_METACHAR_RE`, `_shellQuote`, the `--settings` append, `SWITCHBOARD_API_PORT` / `SWITCHBOARD_HOOK_TOKEN` env injection |
| `src/services/LocalApiServer.ts` | `POST /agent/event`, `_handleAgentEvent`, `_checkHookAuth`, the `verifyHookToken` and `onAgentTurnEnd` options |
| `src/standalone/ptyHost.ts` | `--api-port` / `--hook-secret` argv, `applyHookContext`, the stdin JSON handshake |
| `src/services/TaskViewerProvider.ts` | `_ptyHookSecret`, both spawn args, the `hookContext` stdin write, both option callbacks |
| `src/standalone/bootstrap.ts` | the HMAC verifier, `onAgentTurnEnd`, the `setHookContext` wiring |
| `protocol-catalog.json` | the `/agent/event` entry (regenerated) |
| `.switchboard/agent-hooks/` | the generated per-terminal settings files, and the directory |

Verified after removal: zero orphaned references anywhere in `src/`, typecheck clean (only the 5 pre-existing `TS2835` import-extension errors that are also present at HEAD), eslint 0 errors, and all four static ratchets green (catalog, verb allowlist, protocol parity, icon parity).

## What Was Deliberately Retained

All of it CLI-agnostic, and all of it the seam the replacement plan plugs into:

- **V59 `blocked_at`** column and **`setBlockedState`** — the blocked capability itself. Currently writer-less by design.
- **`clearWorkingState`'s transition boolean** (`getRowsModified`) — the double-broadcast gate, load-bearing for any second completion clearer.
- **`getActiveDispatchedByTerminal`** / **`getActiveDispatchedByCwd`** — terminal→plan attribution, needed by any mechanism.
- **`SWITCHBOARD_TERMINAL`** in the pty environment — seat identity, free for any CLI to read.
- The board's **dashed-amber blocked ring** and **"Waiting on you" badge** in `kanban.html`.

## Lessons Worth Carrying Forward

Recorded here because they were paid for in review findings and would otherwise be relearned:

1. **Completion evidence must be the plan file's `mtime`, never `updated_at`.** `updated_at` only advances when the watcher re-ingests, which happens *after* any completion signal fires — so keying on it can never detect a real completion. This defect made the hook path structurally inert until it was found in review.
2. **`setBlockedState` must not touch `updated_at`.** Bumping it there makes a blocked → user-answers → turn-end sequence read its own side effect as evidence of work, producing a false completion.
3. **A second concurrent clearer requires a real transition gate.** Two clearers racing one turn both fire the completion toast unless the clear returns a true non-NULL→NULL transition and both callers gate on it.
4. **A startup command is shell text typed into an interactive shell, not an argv.** Appending flags to it corrupts `zsh -ic 'claude'`, `claude && echo x`, and wrapper scripts. Any future design that rewrites the launch command inherits this whole problem — which the replacement avoids by not touching it.
5. **Never assume a third-party CLI's event names.** `PermissionRequest`, `Elicitation` and `StopFailure` were specified from documentation and never verified against the installed build; the generated files also used the wrong schema shape (flat `{type,command}` instead of the required `{matcher?, hooks:[…]}` wrapper), so every hook was inert and surfaced only as settings-validation errors.

## Replacement

`feature_plan_20260808083000_pty-turn-end-from-output-silence.md` — derives turn-end from sustained output silence on the pty stream the fleet already reads, filling in the one empty branch left by the liveness subtask. Requires nothing from the agent, so it behaves identically for every CLI, and it gives `blocked_at` its first writer.
