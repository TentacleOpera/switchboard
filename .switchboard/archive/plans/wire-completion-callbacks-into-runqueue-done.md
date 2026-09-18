# Wire completion callbacks into the _runQueueDone path

## Goal

The `POST /kanban/queue/done` endpoint (`_runQueueDone` in `LocalApiServer.ts`) already calls `clearWorkingState` (the activity-light off-switch), but it does NOT fire the completion broadcast (`broadcastAgentCompleted` — the browser Terminals panel toast) or the turn-end notifier (`notifyTurnEnd` — the notification to the lead + autoban dispatch). Both of these are currently fired only from the file-watcher path in `PlanIngestionEngine.ts`. This subtask wires the same callbacks into `_runQueueDone` so the API-based completion path has feature parity with the file-watcher path.

### Background

This is Part 3 of the feature "Replace mtime-based completion detection with explicit API-based completion." Once the mtime-based detection is removed (sibling subtask "Remove mtime-based completion detection"), the API POST becomes the sole completion trigger. The callbacks must fire from `_runQueueDone` or the lead never gets notified and the autoban never wakes.

### What this subtask does

1. Adds two new optional callbacks to `LocalApiServerOptions`.
2. Fires them in `_runQueueDone` when `clearWorkingState` returns `transitioned = true`.
3. Wires the callbacks in the extension host (`TaskViewerProvider.ts`).
4. Wires the callbacks in the standalone host (`bootstrap.ts`).

## Metadata

**Complexity:** 5
**Tags:** bugfix, backend, refactor
**Project:** Browser Switchboard

## Proposed Changes

### 3a. Add callbacks to LocalApiServer options — `src/services/LocalApiServer.ts`

Add two new optional callbacks to the `LocalApiServerOptions` interface (alongside the existing `clearTerminalContext` at line 359 and `terminalVerb` at line 284):

```ts
/** Fired when a seat's working state is cleared (non-NULL→NULL transition) via
 *  queue/done. Mirrors PlanIngestionEngine._onWorkingStateCleared →
 *  broadcastAgentCompleted. The record is the pre-clear read (still has
 *  dispatchedAt, dispatchedTerminal, etc.) so the broadcast can include them. */
onWorkingStateCleared?: (record: any, workspaceRoot: string) => void;

/** Fired when a seat's turn ends via queue/done. Mirrors
 *  PlanIngestionEngine._turnEndNotifier → notifyTurnEnd + handleAutobanTurnEnd.
 *  The host resolves the recipient and delivers the notification. */
onTurnEndNotify?: (info: { seatName: string; planFile: string; outcome: 'completed'; workspaceRoot: string; body?: string }) => void;
```

### 3b. Fire the callbacks in _runQueueDone — `src/services/LocalApiServer.ts` (~line 2212)

After `clearWorkingState` returns `transitioned = true`, fire both callbacks. Insert this block immediately after the `if (!transitioned)` early-return at line 2223, before the clear-terminal-context block at line 2239:

```ts
if (transitioned) {
    // Fire the completion broadcast (browser toast) — mirrors the
    // file-watcher path's _onWorkingStateCleared callback.
    if (this._options.onWorkingStateCleared) {
        try { this._options.onWorkingStateCleared(held, workspaceRoot); } catch (e) {
            console.warn('[LocalApiServer] onWorkingStateCleared callback failed:', e);
        }
    }
    // Fire the turn-end notifier (lead notification + autoban) — mirrors
    // the file-watcher path's _turnEndNotifier callback. Composed body
    // uses the same composer as the watcher path for consistency.
    if (this._options.onTurnEndNotify) {
        try {
            const body = composeCompletedTurnEndBody(held, from, held.planFile, Date.now());
            this._options.onTurnEndNotify({
                seatName: from,
                planFile: held.planFile,
                outcome: 'completed',
                workspaceRoot,
                body,
            });
        } catch (e) {
            console.warn('[LocalApiServer] onTurnEndNotify callback failed:', e);
        }
    }
}
```

Note: `composeCompletedTurnEndBody` is exported from `PlanIngestionEngine.ts` (line 2308). Import it into `LocalApiServer.ts` — `LocalApiServer` already imports from other service modules.

### 3c. Wire the callbacks in TaskViewerProvider.ts — `src/services/TaskViewerProvider.ts` (~line 3438)

`LocalApiServer` is constructed in `TaskViewerProvider.ts` at line 3438 (`this._localApiServer = new LocalApiServer({...})`). Add the new callbacks to the options object (inside the `new LocalApiServer({...})` call), alongside the existing `clearTerminalContext` option at line 3487:

```ts
onWorkingStateCleared: (record, wsRoot) => {
    this.broadcastAgentCompleted(record, wsRoot);
},
onTurnEndNotify: (info) => {
    this.notifyTurnEnd(info);
    this.handleAutobanTurnEnd(info);
},
```

This mirrors the existing engine wiring at extension.ts:1086 (`setOnWorkingStateCleared`) and extension.ts:1153 (`setTurnEndNotifier`), but on the API server's options instead of the engine's setter.

### 3d. Wire the callbacks in bootstrap.ts — `src/standalone/bootstrap.ts`

The standalone host has different callback patterns than the extension host. It uses `broadcastAgentCompletedForRecord` (defined at bootstrap.ts:715) instead of `taskViewerProvider.broadcastAgentCompleted`, and `deliverPrompt` (defined at bootstrap.ts:263) instead of `notifyTurnEnd`.

The standalone host's `LocalApiServer` options object is at bootstrap.ts:2370 (`const options: any = {...}`), and `server = new LocalApiServer(options)` is at line 2643. Add the new callbacks to the options object:

```ts
onWorkingStateCleared: (record, _wsRoot) => {
    // Reuse the existing broadcast function defined at line 715.
    broadcastAgentCompletedForRecord(record);
},
onTurnEndNotify: (info) => {
    // Reuse the same deliverPrompt pattern as the engine's setTurnEndNotifier
    // at line 2183. The standalone host resolves the recipient (parentInstanceId
    // → live terminal, orchestrator fallback) and delivers via deliverPrompt.
    // PRACTICAL APPROACH: The engine's setTurnEndNotifier closure (line 2183)
    // already handles recipient resolution + deliverPrompt + autoban. Extract
    // the closure into a named function (e.g. `handleTurnEndNotify`) and call
    // it from both the engine's setTurnEndNotifier AND the LocalApiServer's
    // onTurnEndNotify callback. This avoids duplicating the delivery logic.
    handleTurnEndNotify(info);
},
```

The practical approach requires extracting the turn-end delivery closure from the engine's `setTurnEndNotifier` (line 2183-2259) into a named function so both the engine and the API server can call it. The closure currently captures `deliverPrompt`, `taskViewerProvider`, and `ptyFleetService` — all in scope at the options object construction point.

## What does NOT change

- `POST /kanban/queue/done` endpoint logic — unchanged except for the new callback firing.
- `clearWorkingState` — unchanged (the `IS NOT NULL` gate ensures single-fire).
- The file-watcher path's callbacks — unchanged (they will be removed in the sibling subtask "Remove mtime-based completion detection").

## Verification Plan

### Automated Tests
1. `node --check src/services/LocalApiServer.ts` — syntax check
2. `node --check src/services/TaskViewerProvider.ts` — syntax check
3. `node --check src/standalone/bootstrap.ts` — syntax check
4. Run `src/test/queue-pipeline-contract.test.js` — updated mtime/clearWorkingState assertions pass
5. Add test: `_runQueueDone` fires `onTurnEndNotify` and `onWorkingStateCleared` on `transitioned = true`

### Manual Verification
6. Grep `onTurnEndNotify` in `LocalApiServer.ts` — confirm the callback is fired in `_runQueueDone` on `transitioned = true`
7. Grep `onTurnEndNotify` in `TaskViewerProvider.ts` — confirm it's wired to `notifyTurnEnd` + `handleAutobanTurnEnd` in the `LocalApiServer` construction
8. Grep `onWorkingStateCleared` in `TaskViewerProvider.ts` — confirm it's wired to `broadcastAgentCompleted` in the `LocalApiServer` construction
9. Grep `onTurnEndNotify` in `bootstrap.ts` — confirm it's wired in the standalone `LocalApiServer` options

## Completion Report

Wired the two completion callbacks (`onWorkingStateCleared`, `onTurnEndNotify`) into the `_runQueueDone` path in `LocalApiServer.ts`, firing both on the `transitioned = true` gate (parity with the file-watcher path's single-fire contract). Added the callback fields to `LocalApiServerOptions` and imported `composeCompletedTurnEndBody` from `PlanIngestionEngine` (verified no circular dependency). Wired the callbacks in `TaskViewerProvider.ts` (`broadcastAgentCompleted` + `notifyTurnEnd` + `handleAutobanTurnEnd`) and in `bootstrap.ts` (reusing `broadcastAgentCompletedForRecord` and a newly-extracted `handleTurnEndNotify` named function shared between the engine's `setTurnEndNotifier` and the API server's `onTurnEndNotify`, avoiding duplicated delivery logic). Files changed: `src/services/LocalApiServer.ts`, `src/services/TaskViewerProvider.ts`, `src/standalone/bootstrap.ts`. No issues encountered; all grep-based manual verification checks (steps 6–9) pass. Compile and automated tests skipped per session directives.

## Review Findings

CRITICAL fixed in `src/services/LocalApiServer.ts`: the callback block fired unconditionally on `transitioned`, so a `{"outcome":"failed"}` report — which the standing orders explicitly instruct seats to send — notified the lead `outcome: 'completed'` ("seat X finished its turn on <plan>") and mirrored a `kind: finished` orchestrator report while the escalation ladder re-staged or parked the card; the block is now gated on `outcome === 'finished'`. MAJOR fixed in `src/services/TaskViewerProvider.ts` and `src/standalone/bootstrap.ts`: the retired watcher path cleared working state and fired `planDiscovered` in the same tick (the board's only re-render trigger), so the new callbacks now also call `refreshIfShowing` / `pushFullState` or the card keeps a lit activity light after the POST. MAJOR fixed in `LocalApiServer.ts`: the release-arm no longer fires on the team-in-flight 409 — that pop result is the normal outcome for a head-paced team member and arming rebinds the workspace queue watch's `headTerminal` to the finishing coder, silently redirecting later stall nudges away from the lead. Verified: `npm run compile-tests` clean, eslint 0 errors, `test:contract:queue-pipeline` green with 2 new tests (failed-outcome suppression, no-arm-on-409), `terminal-plan-attribution` 41/41. Remaining risk: this endpoint is release-**and-pop**, so a head-paced coder's normal completion still answers with a 409 `success:false` body, and if the head moved the card out of its coding column first the pop can dispatch a staged card without the head — a follow-up decision, not fixed here.
