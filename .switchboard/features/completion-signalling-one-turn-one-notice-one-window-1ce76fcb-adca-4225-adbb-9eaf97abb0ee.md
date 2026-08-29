# Completion Signalling — One Turn, One Notice, One Window

**Complexity:** 7

## Goal

Make an agent finished a single, accurate, once-per-turn signal instead of four simultaneous surfaces firing once per plan file in every open window. Today one completion paints a rail pulse, a sidebar chip, a pane-header chip and a toast, in the cockpit and in every pop-out, and it fires once per plan row, so a six-subtask feature dispatch announces done six times, the first within a minute of dispatch. These plans fix the signal's granularity (per turn, not per plan row), its audience (the cockpit, not every window), its surface count (two durable, one transient), and its failure mode (a card whose agent went silent without writing its plan file stays lit far too long).

## How the Subtasks Achieve This

- **One Completion Signal Per Agent Turn — Batch-Aware "Done" and a Falsifiable Silence Verdict**: the engine and the wire. Gates the completion broadcast in `PlanIngestionEngine` on the terminal's whole batch clearing, fixes the silence sweep's `LIMIT 1` so every row of a batch is tested rather than one, carries the turn size (`planCount`) to both hosts from one site, tags the extension-host broadcast with `SURFACES.common` for parity with the standalone path, and bounds the silence-derived "Waiting on you" verdict so a seat that goes quiet without writing its plan file stops holding the light for four hours. Owns `KanbanDatabase`, `PlanIngestionEngine`, both broadcasters, and the `activityLight` config block.
- **One Completion Notice, In One Window — Cut the Terminals Panel's Four DONE Surfaces to Two**: the rendering. Guards `handleAgentCompleted` on `!soloTerminalName` so the cockpit owns the notice, deletes the pane-header `DONE` chip, coalesces completion toasts to one at a time, drops the dwell from 8 s to 4 s, and renders the turn size when present. Leaves the rail pulse and the sidebar chip as the two surfaces that earn their place. Owns `src/webview/terminals.js` and `src/webview/shell.js` outright.

## Reconciliation record (2026-08-14)

This feature was reconciled from four subtasks to two. The set is now partitioned strictly by file, so the two subtasks share **no source file** and can be coded in parallel by two agents.

- **Merged away — *Completion Toasts Fire in Every Pop-Out Window, Not Just the Cockpit*.** Its `terminals.js` guard went to the rendering subtask; its `TaskViewerProvider` `SURFACES.common` parity fix went to the engine subtask. Both halves survive; the split follows the file boundary.
- **Merged away — *Clear the Activity Light on Sustained Terminal Quiescence*.** Superseded in substance by commit `1bd39f4a` (2026-08-14), which shipped `switchboard.activityLight.turnEndSilenceMs`, the silence sweep and the blocked state — i.e. the config key, the "inert third branch" fill-in and the sweep that plan proposed. Two of its premises were false against HEAD: the third liveness branch is no longer inert, and `clearStaleWorkingState` has never called `_onWorkingStateCleared`, so a quiescence clear could not have fired a completion toast and needs no `reason` field. Its genuine residue — a silence-derived verdict holding the activity light for four hours on a guess — moved into the engine subtask, which already owns that sweep loop.
- **The `planCount` design changed.** It is computed once in `PlanIngestionEngine` and handed to both hosts through the `_onWorkingStateCleared` callback, replacing a `countTurnPlansByTerminal` query duplicated in each broadcaster — whose `updated_at` anchor did not hold on the sweep path anyway.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [One Completion Signal Per Agent Turn — Batch-Aware "Done" and a Falsifiable Silence Verdict](../plans/feature_plan_20260813100400_done-fires-per-plan-file-not-per-agent-turn.md) — **LEAD CODED** — ID: 6480bd50-bd74-4f48-a864-b12cee630181
- [ ] [One Completion Notice, In One Window — Cut the Terminals Panel's Four DONE Surfaces to Two](../plans/feature_plan_20260813100500_one-completion-paints-four-done-surfaces.md) — **LEAD CODED** — ID: 431ee1ab-caa6-4fee-8f81-09a6d32d6d93
<!-- END SUBTASKS -->

## Dependencies & sequencing

- **The two subtasks are independent and can land in either order, in parallel.** The reconciliation partitioned them by file: the engine subtask owns `KanbanDatabase.ts`, `PlanIngestionEngine.ts`, `TaskViewerProvider.ts`, `bootstrap.ts`, `extension.ts` and `package.json`; the rendering subtask owns `src/webview/terminals.js` and `src/webview/shell.js`. There is no shared file and therefore no merge-order constraint — this is what the restructure bought.
- **The only coupling is one additive payload field.** The engine subtask adds `planCount` to the `agentCompleted` push; the rendering subtask reads it and tolerates its absence (`Number.isFinite` guard falling through to the plain title). Whichever lands second turns the text on. Neither is blocked by the other.
- **If only one is dispatched, dispatch the engine subtask.** It fixes the reported bug (a six-subtask dispatch announcing done six times, the first within a minute); the rendering subtask reduces the noise of a notice that would still be wrong on its own.
- **Cross-feature contention:** the rendering subtask deletes a block from `updatePaneElement`'s title row. The *Pane Fidelity* feature's **Pane Header No Longer Shows the Agent Role** subtask rewrites that same block. A textual conflict is near-certain — do not dispatch both features concurrently.
- **One prerequisite fact for the coder:** commit `1bd39f4a` (2026-08-14) shipped the turn-end silence sweep, `switchboard.activityLight.turnEndSilenceMs` and the blocked/"Waiting on you" state. Both plans are written against that code, not against the pre-`1bd39f4a` engine. Re-read the sweep before editing it.

## Completion Summary

Both subtasks implemented and committed (494b44bc). The engine subtask gates the completion broadcast on the terminal's whole batch clearing via `countActiveDispatchedByTerminal` in `LocalApiServer`, carries `planCount` to both hosts through the `_onWorkingStateCleared` callback meta, fixes the silence sweep to iterate all rows via `getActiveDispatchedRowsByTerminal`, and cuts `blockedTimeoutMs` from 4h to 30min. The rendering subtask guards `handleAgentCompleted` on `!soloTerminalName`, deletes the pane-header DONE chip, coalesces completion toasts to one at a time, drops dwell to 4s, and renders `planCount` as "+N more". One fix round was required on the engine subtask to wire the batch-gating infrastructure into actual call sites.
