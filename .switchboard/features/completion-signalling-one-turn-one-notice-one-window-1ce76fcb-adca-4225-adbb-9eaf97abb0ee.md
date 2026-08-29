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
- [ ] [One Completion Signal Per Agent Turn — Batch-Aware "Done" and a Falsifiable Silence Verdict](../plans/feature_plan_20260813100400_done-fires-per-plan-file-not-per-agent-turn.md) — **CODE REVIEWED** — ID: 6480bd50-bd74-4f48-a864-b12cee630181
- [ ] [One Completion Notice, In One Window — Cut the Terminals Panel's Four DONE Surfaces to Two](../plans/feature_plan_20260813100500_one-completion-paints-four-done-surfaces.md) — **CODE REVIEWED** — ID: 431ee1ab-caa6-4fee-8f81-09a6d32d6d93
<!-- END SUBTASKS -->

## Dependencies & sequencing

- **The two subtasks are independent and can land in either order, in parallel.** The reconciliation partitioned them by file: the engine subtask owns `KanbanDatabase.ts`, `PlanIngestionEngine.ts`, `TaskViewerProvider.ts`, `bootstrap.ts`, `extension.ts` and `package.json`; the rendering subtask owns `src/webview/terminals.js` and `src/webview/shell.js`. There is no shared file and therefore no merge-order constraint — this is what the restructure bought.
- **The only coupling is one additive payload field.** The engine subtask adds `planCount` to the `agentCompleted` push; the rendering subtask reads it and tolerates its absence (`Number.isFinite` guard falling through to the plain title). Whichever lands second turns the text on. Neither is blocked by the other.
- **If only one is dispatched, dispatch the engine subtask.** It fixes the reported bug (a six-subtask dispatch announcing done six times, the first within a minute); the rendering subtask reduces the noise of a notice that would still be wrong on its own.
- **Cross-feature contention:** the rendering subtask deletes a block from `updatePaneElement`'s title row. The *Pane Fidelity* feature's **Pane Header No Longer Shows the Agent Role** subtask rewrites that same block. A textual conflict is near-certain — do not dispatch both features concurrently.
- **One prerequisite fact for the coder:** commit `1bd39f4a` (2026-08-14) shipped the turn-end silence sweep, `switchboard.activityLight.turnEndSilenceMs` and the blocked/"Waiting on you" state. Both plans are written against that code, not against the pre-`1bd39f4a` engine. Re-read the sweep before editing it.

## Completion Summary

Both subtasks implemented and committed (494b44bc). The engine subtask gates the completion broadcast on the terminal's whole batch clearing via `countActiveDispatchedByTerminal` in `LocalApiServer`, carries `planCount` to both hosts through the `_onWorkingStateCleared` callback meta, fixes the silence sweep to iterate all rows via `getActiveDispatchedRowsByTerminal`, and cuts `blockedTimeoutMs` from 4h to 30min. The rendering subtask guards `handleAgentCompleted` on `!soloTerminalName`, deletes the pane-header DONE chip, coalesces completion toasts to one at a time, drops dwell to 4s, and renders `planCount` as "+N more". One fix round was required on the engine subtask to wire the batch-gating infrastructure into actual call sites.

## Review Findings (2026-08-29)

Reviewed commit `494b44bc` against both subtask plans. Five findings, ranked. Finding 1 is a
regression on the common path and must be fixed before this ships.

### 1. The batch gate suppresses the BOARD REFRESH, not just the toast — HIGH

`LocalApiServer.ts:3362-3377` wraps the **whole** `onWorkingStateCleared` call in
`if (remaining === 0)`. That seam is not broadcast-only. Both hosts hang a board refresh off
it:

- `TaskViewerProvider.ts:3829` → `this._kanbanProvider?.refreshIfShowing(wsRoot)`
- `bootstrap.ts:2980` → `pushFullState()`

Their own comments state why it is there: *"The API path clears the DB with nothing watching
the file, so without this the row goes clean while the card keeps showing a lit activity
light until some unrelated event refreshes."*

So for a batch of N, plans 1..N−1 now clear `dispatched_at` in the DB and **never repaint**.
The card keeps a lit activity light. That is the exact stuck-light this feature set out to
kill, reintroduced on the common path. Confirmed there is no second refresh later in
`_runQueueDone` — grepped the handler to its end for `refresh|pushFullState|broadcastWs`:
nothing.

Why the implementation drifted here: the plan put the gate at the **engine** seam
(`extension.ts:1014`), whose callback is `broadcastAgentCompleted` and nothing else. The
coder correctly discovered the engine seam is dormant (mtime completion is retired; `POST
/kanban/queue/done` is the live producer) and moved the gate to the API seam — but that seam
carries a second, unrelated responsibility.

Fix: gate the announcement, not the callback. Widen the meta to
`{ planCount: number; announce: boolean }`, call `onWorkingStateCleared` on every clear, and
let each host skip only `broadcastAgentCompleted` / `broadcastAgentCompletedForRecord` when
`announce === false`. The refresh then runs per card, as before.

### 2. The engine's turn-size helpers are dead code — MEDIUM

`PlanIngestionEngine.ts:279-298` adds `_turnSizes`, `_noteTurnClear` and `_takeTurnSize`.
**Zero callers.** `_onWorkingStateCleared` is never invoked anywhere in that file (its own
docblock at `:300-310` says DORMANT), so nothing in the engine ever notes or takes a turn
size. The live copy is a near-byte-identical duplicate at `LocalApiServer.ts:778-797`.

The docblock on the dead copy claims the map is *"consumed by the broadcast that closes the
turn"* — false in that file, and it is the longer, more authoritative-looking of the two. The
next reader edits the dead one. Delete `PlanIngestionEngine.ts:277-298` and move that
docblock onto the LocalApiServer copy.

### 3. The blocked digest now reports one seat as N seats — MEDIUM

Dropping `LIMIT 1` from the sweep means `blockedThisTick` gets one entry **per plan** per
seat (`PlanIngestionEngine.ts:754`), where it previously got one per seat.

`_runBlockedDigestSweep` (`:1203-1215`) paces per seat via
`pacing[`${wsId}|${terminalName}`]`, but `pacing` is only written **after** the loop
(`:1247`). So all N entries for one seat pass the pace check on the same tick, and
`getActiveDispatchedByTerminal` (still `LIMIT 1`) returns the same row for each — every one
passes the `rec.blockedAt` filter too.

Result for a 3-plan batch on `coder-1`:

```
[switchboard:turn-end] 3 seat(s) have gone quiet without writing a completion report:
  - coder-1 on plan-a.md, silent 120s
  - coder-1 on plan-b.md, silent 120s
  - coder-1 on plan-c.md, silent 120s
```

One seat, reported as three. Fix: dedupe `blockedThisTick` by `terminalName` before the
digest, or key `due` by seat and collect its plan files into one line.

### 4. `_noteTurnClear`'s staleness bound is hard-coded — LOW

`LocalApiServer.ts:780` takes `timeoutMs = 600000` as a parameter default and the call site
(`:3368`) never passes one, so `switchboard.activityLight.timeoutMs` is ignored. The plan
explicitly permitted a hard-coded fallback, so this is a note, not a defect: an operator who
raises `timeoutMs` gets turn-size entries expiring earlier than their own activity window,
which understates `planCount` on a long turn. Display-only.

### 5. Verification could not have run — the tree does not compile (PRE-EXISTING, blocking)

`src/services/PlanIngestionEngine.ts` does not parse:

```
$ npx tsc -p tsconfig.test.json --noEmit
src/services/PlanIngestionEngine.ts(1167,5): error TS1472: 'catch' or 'finally' expected.
```

Cause: `_applyFeatureLink` opens `try {` at `:1133` and its `} catch (e) {…}` was deleted by
commit `0b124e0c` ("Restore dispatch-prompt and completion-handshake chain end to end").
Bisected: clean at `af9ad46f`, broken at `0b124e0c`. **Not introduced by `494b44bc`.**

The consequence for this review is real, though. `out/` is stale (`out/services/LocalApiServer.js`
10:58 vs `src/services/LocalApiServer.ts` 22:05; `grep -c countActiveDispatchedByTerminal
out/services/LocalApiServer.js` → 0), so every node test ran against pre-change JavaScript.
`queue-done-lead-relay-contract.test.js` passes 13/13 without ever executing the new gate.
The engine plan's verification step 10 (`npm run compile-tests` clean) is unmet, and steps
1-8 have no test file. Restore the `catch` in `_applyFeatureLink`, recompile, then re-run.

(`completion-asserted-never-inferred.test.js` also has one red case — *"wireSpawnedTeam
installs context-aware completion order at team and team-head scopes"*. Unrelated to this
feature; pre-existing.)

### What is correct

- **Gate ordering.** The `countActiveDispatchedByTerminal` read happens after
  `clearWorkingState` (`LocalApiServer.ts:3283` then `:3365`), so the clearing row is already
  excluded. The plan flagged getting this backwards as the silent regression; it is right.
- **Both SQL shapes validated** against `sqlite3` — `COUNT(*) AS n` and the `LIMIT ?` bind
  both prepare and execute. The count correctly abandons `_readRows` for
  `stmt.step()`/`getAsObject()`, which the plan called out as a trap.
- **Empty-terminal fallthrough** is present (`|| from || ''`, then `remaining = 0`), so an
  unattributed dispatch still broadcasts immediately.
- **`SURFACES.common` tagging** is safe: `PANEL_SURFACES` maps `terminals →
  ['terminals','common']` (`wsHub.ts:72`), and the hub's filter (`:409`) passes tagged frames
  to any connection declaring the surface. Parity gap with standalone closed.
- **Host parity held**, and better than the plan asked: the gate lives in the shared
  `LocalApiServer`, so both composition roots inherit it from one site rather than two. Both
  roots forward `meta` (`extension.ts:1017`, `bootstrap.ts:786`/`:2972`).
- **`_blockedCandidates` re-key** to `wsId\0terminal\0planFile` is correct — the per-plan
  grace window is what the per-row sweep needs, and the map is still bounded by dispatched
  rows and cleared at `:2539`.
- **Rendering subtask (`431ee1ab`) is faithful and complete.** Solo guard at the function top
  (`terminals.js:10471`), pane-header `terminalBadges` block deleted with the `GAP` block
  below it intact, toast coalescing scoped with `:not(.is-error)` so
  `showTerminalErrorToast`'s `completion-toast is-error` (`:10565`) survives, added
  `toastContainerEl` guard, dwell 4s, `planCount` rendered via `Number.isFinite` into
  `textContent`. `soloTerminalName` is set only from the `?solo=` query param (`:204`), so the
  cockpit is unaffected. `shell.js` comment corrected.
  - One omission: the plan supplied a full docblock for `handleAgentCompleted` explaining why
    the cockpit owns the notice; only the bare `if (soloTerminalName) { return; }` landed. The
    "why" is the part that stops someone deleting the guard. Worth adding.

### Verdict

**Changes requested.** Finding 1 must be fixed — it reintroduces a stuck activity light on
every batch, which is a worse bug than the duplicate toast the feature removed. Findings 2
and 3 are cheap and should land in the same pass. Finding 5 blocks any verification of the
above and blocks a VSIX build; it is someone else's regression but it sits between this work
and a green gate.

## Review Findings (2026-08-30)

Re-reviewed commit `592175ad` at HEAD; the 2026-08-29 pass recorded findings but landed no
code, so all of them were still open. One CRITICAL defect on the live path: the batch gate in
`LocalApiServer._runQueueDone` suppressed `onWorkingStateCleared` whenever the seat still held
sibling rows, and since `POST /kanban/queue/done` clears exactly one row per turn while the
shipped standing order is one POST per turn ("Do NOT post after finishing individual parts",
`agentPromptBuilder.ts:1064`), a batch dispatch announced completion **never** — and because
that same callback carries each host's board refresh, its cards kept a lit activity light.
Replaced the gate with a turn-size computation (`planCount = remaining + 1`) so the callback
always fires and the toast still renders "+N more"; also deleted the dead
`_turnSizes`/`_noteTurnClear`/`_takeTurnSize` copy in `PlanIngestionEngine`, deduped the blocked
digest by seat (it reported one batched seat as N seats), and added the `handleAgentCompleted`
docblock the rendering plan supplied. Files changed: `src/services/LocalApiServer.ts`,
`src/services/PlanIngestionEngine.ts`, `src/services/KanbanDatabase.ts`,
`src/webview/terminals.js`. Verification: `tsc -p tsconfig.test.json` clean, `eslint` 0 errors,
`node --check` clean on both webview files, six parity/catalog gates and eleven contract suites
green — three CI-wired suites are red both before and after this work and are unrelated
(`completion-asserted-never-inferred`, `queue-pipeline`, `terminal-replay-gap`).

**Mechanism deviation, recorded for the author.** The plan's central mechanism — hold the
broadcast until every row of the batch clears — was designed against the per-plan mtime
producer. That producer is retired and `PlanIngestionEngine._onWorkingStateCleared` has zero
invocations, so the gate had no true positive available to it and one severe false negative.
The plan's *goal* (one accurate signal per agent turn, carrying the turn size) is achieved; the
gate is not the thing that achieves it. Destination, files and payload are unchanged.

## Deferred Findings

- MAJOR — The engine subtask's `### Automated` steps 1–8 (eight named unit tests for the batch gate, the sweep, feature-row exclusion and turn-size staleness) were never written; no test file exists and nothing in CI exercises the new query or the new callback meta. `src/test/` (no such file)
- MAJOR — A batch's sibling rows are never cleared by any completion path: `queue/done` clears one row and mtime completion is retired, so cards 2..N of a fan-out stay lit until `clearStaleWorkingState` retires them at `timeoutMs`. Pre-existing, outside this feature's diff. `src/services/LocalApiServer.ts:3381`
- MAJOR — `completion-asserted-never-inferred.test.js` red at HEAD ("wireSpawnedTeam installs context-aware completion order at team and team-head scopes"); introduced by `c5590f06` (teamWiring), not by this feature. `src/test/completion-asserted-never-inferred.test.js`
- MAJOR — `queue-pipeline-contract.test.js` has two red cases asserting `_scheduleQueuePop` and a `completedAt`/`heldByTeam` in-flight predicate; `_scheduleQueuePop` has never existed in `LocalApiServer.ts`. Pre-existing. `src/test/queue-pipeline-contract.test.js`
- NIT — `terminal-replay-gap-contract.test.js` red on the `clearTeamBadges` arm: a `terminalBadges.delete(name)` site with no `terminalReplayGaps` counterpart within 400 chars. Predates `592175ad`. `src/webview/terminals.js:1225`
- NIT — The one-tick grace `prior.cardKey !== cardKey` check is now unreachable: `_blockedCandidates`'s key contains `record.planFile`, which determines `cardKey`. `src/services/PlanIngestionEngine.ts:678`
- NIT — `SWEEP_ROW_CAP` is declared inside the per-terminal loop rather than at module or method scope. `src/services/PlanIngestionEngine.ts:650`
