# Project panel goes out of sync with the kanban board after card moves

## Goal

When a card is moved on the kanban board (drag-drop, move-forward, move-backward, autoban, or remote control), the project panel's Kanban Plans tab keeps showing the card in its old column until the user manually switches tabs or the plan file changes on disk. Fix this so the project panel's `_kanbanPlansCache` refreshes whenever the board moves a card — the same way the kanban board and sidebar already do.

### Problem Analysis

The project panel (`project.html` / `project.js`) and the kanban board (`kanban.html` / `KanbanProvider`) both read plan columns from the **same** `kanban.db` `plans.kanban_column` field. They never disagree on the source of truth — they disagree on **when they last read it**.

The project panel refreshes its `_kanbanPlansCache` only in three situations:
1. The user switches to the kanban / projects / features tab (`project.js:52-59` sends `fetchKanbanPlans`).
2. The project panel becomes visible (`PlanningPanelProvider.ts:663` sends `refreshKanbanPlans` from `onDidChangeViewState`; `:530` and `:550` do the same on reveal/restore).
3. A **plan file** changes on disk — the file watcher debounces 800ms and sends `fetchKanbanPlans` (`PlanningPanelProvider.ts:1152-1177`).

Card moves on the kanban board only update the DB's `kanban_column` field — the plan file on disk is untouched, so trigger #3 never fires. And the project panel is usually not visible while the user is on the kanban board, so triggers #1 and #2 don't fire either. The cache goes stale silently.

### Root Cause

`TaskViewerProvider.refreshUI()` is the unified post-action refresh path. It refreshes the sidebar and the kanban board but **never notifies the project panel**:

```typescript
// TaskViewerProvider.ts:4418-4448 (HEAD)
public async refreshUI(workspaceRoot?: string) {
    // ... workspace activation guard (4419-4443) ...
    await Promise.all([
        this._refreshRunSheets(workspaceRoot),
        this._refreshConfigurationState()
    ]);
    // ← no message to the project panel
}
```

Card-move paths reach `refreshUI` via the command seam, not by direct call:

| Path | Reaches `refreshUI` via |
| :--- | :--- |
| `handleKanbanBackwardMove` → `_applyManualKanbanColumnChange` | `TaskViewerProvider.ts:5156` `executeCommand('switchboard.refreshUI')` |
| `handleKanbanForwardMove` → `_applyManualKanbanColumnChange` | `TaskViewerProvider.ts:5382` |
| `handleKanbanCompletePlan` | `TaskViewerProvider.ts:5610` |
| `KanbanProvider.moveCardToColumnByPlanFile` → `_refreshBoard` | `KanbanProvider.ts:3363` |
| `_scheduleBoardRefresh` (≈10 call sites) → `_refreshBoard` | `KanbanProvider.ts:3363` |
| Extension host command registration | `extension.ts:1624-1626` → `taskViewerProvider.refreshUI(workspaceRoot)` |

The project panel's own column-change path (`moveKanbanPlanColumn` → `moveCardToColumnByPlanFile` → `kanbanPlanColumnChanged` → `fetchKanbanPlans`) works because `project.js:702-704` explicitly re-fetches on success. But that path is only used when the move originates from the project panel itself — board-originated moves bypass it entirely.

### Second root cause (found during the improve pass)

`_refreshBoard` **early-returns when the kanban webview panel is closed**:

```typescript
// KanbanProvider.ts:3352-3369 (HEAD)
private async _refreshBoard(_workspaceRoot?: string) {
    if (!this._panel) {
        console.log('[KanbanProvider] _refreshBoard skipped: no panel');
        return;                     // ← refreshUI never runs
    }
    ...
    await this._seams().commands.executeCommand('switchboard.refreshUI', _workspaceRoot);
}
```

So a move made while the board panel is **closed** — `POST /kanban/move` (`LocalApiServer.ts:1316` `_handleKanbanMove`, the `kanban_operations` / orchestrator path), a remote-control move from Linear/Notion, an autoban advance, or a feature cascade — never reaches `refreshUI` at all. A hook placed only in `refreshUI` leaves that whole class of move unfixed, and the failure is invisible to a verification plan that keeps the board open.

### Third root cause (found during the improve pass)

The standalone host (`npx switchboard`, the Browser Switchboard cockpit) **does** serve the Project panel — `headlessPanelHtml.ts:506` lists `{ id: 'project', … enabled: true }` and `bootstrap.ts:792` constructs a real `PlanningPanelProvider` — but it never runs `TaskViewerProvider.refreshUI()`:

- `bootstrap.ts:812-817` registers its own `switchboard.refreshUI` command that calls `schedulePushFullState()` instead.
- `taskViewerProvider.setPlanningPanelProvider(...)` is called **only** from `extension.ts:1356`, so in standalone `_planningPanelProvider` is `undefined` and any push added to `refreshUI` no-ops twice over.

Under `npx switchboard` the bug therefore survives an extension-host-only fix, in direct tension with PRD contract #7 (two-layer completion) for a plan pinned to the Browser Switchboard project.

## Metadata

**Complexity:** 4
**Tags:** bugfix, frontend, backend
**Project:** Browser Switchboard

## User Review Required

None.

## The one thing that will go wrong if you rush it

**Don't send `fetchKanbanPlans` directly from any of the three hook points.** The project panel's `refreshKanbanPlans` handler (`project.js:433-439`) already debounces at 200ms and is the correct entry point — it collapses the burst of refresh signals that fire during a multi-card autoban sweep or a feature cascade move into a single DB read. Posting `fetchKanbanPlans` raw would bypass that debounce and fire one full multi-root DB scan (`PlanningPanelProvider.ts:3547-3597` loops every allowed root, reads plans + projects + column definitions per root) per signal, re-introducing the exact stampede the debounce was built to prevent. The 200ms debounce is also what makes the deliberate double-notify in Change 1 + Change 2 free: when the board panel *is* open, both hooks fire for one move and still produce exactly one fetch.

## Complexity Audit

### Routine
- Three one-to-two-line push insertions at existing, well-understood call sites.
- Message type `refreshKanbanPlans` already exists and is already handled — no new protocol verb, no schema entry, no catalog regeneration.
- `postMessageToProjectWebview` is the established helper for exactly this message (`PlanningPanelProvider.ts:530`, `:550`, `:663`) and is already called from `KanbanProvider.ts:320`.
- No DB write, no file I/O, no migration, no shipped-state change.

### Complex / Risky
- **Two hosts.** The extension host and the standalone host reach board refresh through structurally different chokepoints (`refreshUI` vs `schedulePushFullState`). Fixing one and asserting parity is the failure mode this plan exists to avoid.
- **A panel-visibility gate hides half the bug.** `_refreshBoard`'s `!this._panel` early-return means the most obvious test (board open, drag a card) passes while the API / remote-control / autoban paths stay broken.
- **Type widening on a structurally-typed field.** `TaskViewerProvider._planningPanelProvider` is declared as a narrow inline shape (`TaskViewerProvider.ts:737`) that does not include `postMessageToProjectWebview`; the field type and the `setPlanningPanelProvider` parameter type must be widened together or the change will not compile.

## Edge-Case & Dependency Audit

- **Race conditions.** `refreshUI` is async and may be called concurrently (a feature cascade fires `moveCardToColumnByPlanFile` per subtask, each scheduling a board refresh). The 200ms debounce in `project.js:433-439` coalesces these into one `fetchKanbanPlans`. With Change 1 and Change 2 both firing for a board-open move, the debounce collapses them to a single fetch — that overlap is intentional, not a duplicate bug.

- **`fetchKanbanPlans` stale-request guard — pre-existing, exposure increased, out of scope.** `PlanningPanelProvider.ts:3529-3533` rejects a request whose client-supplied `requestId` (a `Date.now()` value) is `<=` the last one seen on a single provider-global key `'kanban-plans'`:
  ```typescript
  if (requestId <= (this._latestRequestIds.get(guardKey) || 0)) { return { success: false, error: 'Stale request' }; }
  ```
  This is the exact anti-pattern the class doc at `PlanningPanelProvider.ts:214-237` says was already fixed elsewhere via the provider-side `_isFreshRequest` ticket; `fetchKanbanPlans` was never converted. With an editor Project panel and a browser-cockpit Project panel both open, out-of-order arrival can reject one client's request. **The UI still converges**, because the winner's response goes out via `_postToBothPanels` (`:3629` → `postMessageToProjectWebview` + main panel webview) and `project.js`'s `kanbanPlansReady` handler (`:440`) does **not** filter on `requestId`. The only casualty is an HTTP caller that reads the body. Do not fix it here — file it as a follow-up to convert `fetchKanbanPlans` to `_isFreshRequest`.

- **Security.** No new network surface, no new verb, no new payload field. `refreshKanbanPlans` carries no data — it is a "go re-read" signal, and the subsequent `fetchKanbanPlans` runs through the existing auth-gated verb route.

- **Side effects.** One extra `postMessage` per `refreshUI` (extension host), one per successful `moveCardToColumnByPlanFile` (extension host), one extra WS frame per `pushFullState` (standalone). All are no-ops when no project surface exists. Note that `refreshUI` also fires for non-move events (setup-panel saves, config-state refreshes, workspace activation) — the project panel will re-fetch on those too. That is a wider trigger than strictly needed and is accepted: the fetch is debounced and idempotent, and narrowing it would require re-introducing the per-move hooks the second root cause already rules out.

- **Browser cockpit fan-out.** `wsHub.ts` `PANEL_SURFACES` deliberately omits `project`, so the browser Project panel is undeclared and receives **everything** (documented fail-open). A `SURFACES.project`-tagged `refreshKanbanPlans` therefore reaches it, and the other cockpit panels ignore the unknown message type. `transport.js:195-202` unwraps the envelope into `{ type: 'refreshKanbanPlans', surface: 'project' }`; `project.js:433` matches on `type` and ignores the extra field.

- **Panel not open / not ready.** `postMessageToProjectWebview` (`PlanningPanelProvider.ts:985-996`) mirrors to WS first, then either delivers to the editor webview or queues into `_pendingProjectMessages`, which `_flushPendingProjectMessages` (`:1017-1026`) drains on ready. A refresh fired before the panel's first paint is not lost.

- **Dependencies & conflicts.** No dependency on other plans. `_planningPanelProvider` and `setPlanningPanelProvider` already exist in both `TaskViewerProvider` (`:737`, `:3728`) and `KanbanProvider` (`:292`, `:294`). PRD gates are unaffected: `scripts/check-push-routing.js` counts only `/\.webview\.postMessage\s*\(/` occurrences, and none of the three changes adds one — `TaskViewerProvider.ts` stays at its baseline of 1 and `KanbanProvider.ts` at 1. `verb-returns:check` and `parity:check` are untouched (no verb added, no arm's return shape changed).

- **Existing tests.** `src/services/__tests__/TaskViewerProvider.refreshUI.test.ts` tests the `refreshUI` workspace-activation guard against an inlined stand-in object, not the real method — appending a line after the `Promise.all` cannot break it. `src/test/webview-panel-runtime-surface.test.js:163-190` asserts that `setPlanningPanelProvider` assigns `_planningPanelProvider` and calls `setApiServer(this._localApiServer)`; widening the parameter's structural type leaves both regexes matching.

## Dependencies

- None.

## Adversarial Synthesis

**Risk Summary.** The original single-line fix was correct in intent but incomplete in reach: it targeted the one host that has no `_planningPanelProvider` problem while missing the standalone/browser cockpit entirely, and it hung the fix on `refreshUI`, which `_refreshBoard`'s `!this._panel` gate makes unreachable for every API / remote-control / autoban move made with the board closed. It also chose `postMessage` (planning + project) over `postMessageToProjectWebview` on a justification that does not hold — `planning.js` has no `refreshKanbanPlans` handler at all. Mitigations: three ungated hooks (`refreshUI` for the extension host's board-open paths, `moveCardToColumnByPlanFile` for the ungated extension-host paths, `pushFullState` for standalone), all routed through `postMessageToProjectWebview` / the `project` WS surface, all riding the existing 200ms debounce in `project.js` so the deliberate overlap collapses to one fetch. Residual risk is the pre-existing `fetchKanbanPlans` request-id guard, which is documented above as out of scope because the UI still converges through the shared push.

## Proposed Changes

### `src/services/TaskViewerProvider.ts` — notify the project panel from `refreshUI`

> **Superseded:** `this._planningPanelProvider?.postMessage({ type: 'refreshKanbanPlans' })`, justified as "`PlanningPanelProvider.postMessage()` forwards to both the planning panel and the project panel webviews — which is correct, because the planning panel's Kanban tab (the legacy `implementation.html`) has the same stale-cache bug and benefits from the same refresh."
> **Reason:** The justification is false. `refreshKanbanPlans` is handled in exactly one place in the entire webview tree — `project.js:433`. `planning.js` has no handler for it (only unconditional `fetchKanbanPlans` sends at `:1741`, `:1744`, `:4291`, `:4297`, `:4355`), so the planning-panel half of `postMessage` is a message dropped on the floor plus a wasted `broadcaster.push('planning')` WS frame. Separately, the planning panel's Kanban tab *does* stay fresh under the narrower call anyway: the project panel's resulting `fetchKanbanPlans` replies through `_postToBothPanels` (`PlanningPanelProvider.ts:3629`, `:1371-1374`), which posts `kanbanPlansReady` to the main planning webview as well. Every existing `refreshKanbanPlans` push site in the codebase (`:530`, `:550`, `:663`) uses `postMessageToProjectWebview`.
> **Replaced with:** `this._planningPanelProvider?.postMessageToProjectWebview?.({ type: 'refreshKanbanPlans' })`, with the field and setter types widened to expose the method.

**Context.** `refreshUI` (line 4418) is the unified post-action refresh for the sidebar and the kanban board and is reached from every extension-host card-move path via `executeCommand('switchboard.refreshUI')`.

**Logic.** After the existing `Promise.all`, push the debounced refresh signal to the project surface. `postMessageToProjectWebview` mirrors to WS clients tagged `'project'` *and* delivers to (or queues for) the editor Project panel, so both the editor and an attached browser cockpit converge.

**Implementation.**

1. Widen the field type at line 737:

```typescript
// TaskViewerProvider.ts:737 — add postMessageToProjectWebview to the structural type.
// Optional (`?`) because the field also accepts narrower service-verb-only shapes.
private _planningPanelProvider?: {
    postMessage(message: any): void;
    postMessageToProjectWebview?(message: any): void;
    handleServiceVerb(verb: string, payload: any): Promise<any>;
};
```

2. Widen the setter parameter identically at line 3728 (`setPlanningPanelProvider`), leaving its body unchanged so `webview-panel-runtime-surface.test.js` keeps matching:

```typescript
public setPlanningPanelProvider(provider: {
    postMessage(message: any): void;
    postMessageToProjectWebview?(message: any): void;
    handleServiceVerb(verb: string, payload: any): Promise<any>;
}) {
    this._planningPanelProvider = provider;
    if (this._localApiServer && typeof (provider as any).setApiServer === 'function') {
        (provider as any).setApiServer(this._localApiServer);
    }
}
```

3. Append the push at the end of `refreshUI` (after the `Promise.all` closing at line 4447):

```typescript
        await Promise.all([
            this._refreshRunSheets(workspaceRoot),
            this._refreshConfigurationState()
        ]);
        // Keep the Project panel's Kanban Plans cache in sync with board moves.
        // Card moves touch only plans.kanban_column in the DB — no plan file changes —
        // so the panel's file watcher never fires and its cache goes stale silently.
        // postMessageToProjectWebview (NOT postMessage): refreshKanbanPlans is handled
        // only by project.js:433; planning.js has no handler for it. The planning
        // panel's Kanban tab still refreshes, because the resulting fetchKanbanPlans
        // replies through _postToBothPanels. project.js debounces at 200ms, so a burst
        // of refreshUI calls collapses into a single fetch.
        this._planningPanelProvider?.postMessageToProjectWebview?.({ type: 'refreshKanbanPlans' });
    }
```

**Edge cases.** `_planningPanelProvider` is `undefined` in standalone and before the panel is registered — both `?.` guards no-op. `refreshUI` can early-return at line 4435 when the workspace guard fires; that return is deliberate (wrong workspace context) and correctly skips the push too.

### `src/services/KanbanProvider.ts` — push from the ungated move funnel

> **Superseded:** "Every card-move path funnels through `refreshUI` … `KanbanProvider.moveCardToColumnByPlanFile` → `_refreshBoard` → `refreshUI`", used to argue that a single hook in `refreshUI` is sufficient.
> **Reason:** `_refreshBoard` (`KanbanProvider.ts:3352-3356`) returns early when `!this._panel`. With the kanban webview closed, `moveCardToColumnByPlanFile` never reaches `refreshUI`, and neither do the ~10 `_scheduleBoardRefresh` call sites. `POST /kanban/move` (`LocalApiServer.ts:1316`), remote-control moves, autoban advances, and feature cascades all land there. A `refreshUI`-only fix leaves them broken, and every step of the original verification plan keeps the board open, so the gap would never surface in testing.
> **Replaced with:** an additional, panel-independent push inside `moveCardToColumnByPlanFile`'s success branch.

**Context.** `moveCardToColumnByPlanFile` (line 6986) is the single funnel for every non-webview move: `advanceCards` (`:2711`), the two dispatch paths (`:3034`, `:3117`), `POST /kanban/move`, and the project panel's own `moveKanbanPlanColumn`. `KanbanProvider._planningPanelProvider` is typed as the concrete `PlanningPanelProvider` (line 292), so `postMessageToProjectWebview` is directly callable — precedent at line 320.

**Logic.** Inside the existing `if (moved) { … }` block, immediately after `await this._refreshBoard(workspaceRoot);`, push the same debounced signal unconditionally.

**Implementation.**

```typescript
// KanbanProvider.ts — moveCardToColumnByPlanFile, inside `if (moved)` after line 7032
                await this._refreshBoard(workspaceRoot);
                // Panel-independent Project-panel sync. _refreshBoard early-returns when
                // the board webview is closed (line 3353), so the refreshUI-driven push
                // never fires for POST /kanban/move, remote-control, autoban, or cascade
                // moves made while the board is not open. Pushing here covers those.
                // When the board IS open both hooks fire for one move; project.js's 200ms
                // debounce (project.js:433-439) collapses them into a single fetch.
                this._planningPanelProvider?.postMessageToProjectWebview({ type: 'refreshKanbanPlans' });
```

**Edge cases.** In standalone, `KanbanProvider.setPlanningPanelProvider` is never called (only `extension.ts:1314` calls it), so this no-ops there — Change 3 covers that host. The push is inside `if (moved)`, so a failed or no-op move sends nothing. The surrounding `try/catch` (line 7033-7036) already swallows and logs.

### `src/standalone/bootstrap.ts` — cover the browser cockpit

> **Superseded:** "**Standalone mode:** `bootstrap.ts:734` registers its own `switchboard.refreshUI` handler that calls `schedulePushFullState()` — it does not go through `TaskViewerProvider.refreshUI()`. The standalone host has no project panel, so the added line is never reached there. No change needed in `bootstrap.ts`."
> **Reason:** The premise is wrong. The standalone host **does** serve the Project panel: `headlessPanelHtml.ts:506` publishes `{ id: 'project', route: '/project', enabled: true }` in the `/panels` manifest, `:520` renders it, and `bootstrap.ts:792` constructs a real `PlanningPanelProvider` wired into `planningVerb` (`:1443`, delegating at `:1589`). The correct conclusion is the opposite of the one drawn: because standalone never calls `TaskViewerProvider.refreshUI()` **and** never calls `taskViewerProvider.setPlanningPanelProvider(...)`, the extension-host fix misses it entirely — leaving the bug live under `npx switchboard`, the very host this plan's project (Browser Switchboard) exists to serve. (Line reference also drifted: the registration is now at `bootstrap.ts:812`.)
> **Replaced with:** ride the standalone board-push chokepoint, `pushFullState`.

**Context.** In standalone the reliable chokepoint is `schedulePushFullState` → `pushFullState` (`bootstrap.ts:381-415`), which is driven both by the registered `switchboard.refreshUI` command (`:812-817`) and by the `kanbanVerb` `default:` arm's post-mutation push (`:1155`). Hooking the command registration alone would be unreliable, because `KanbanProvider._refreshBoard`'s `!this._panel` gate is *always* true in standalone (there is no VS Code webview panel), so the command frequently never fires.

**Logic.** `pushFullState` already builds a `state` array and broadcasts each entry with `server.broadcastWs(msg.type, msg, msg.surface)`. Add one entry tagged with the `project` surface.

**Implementation.**

```typescript
// bootstrap.ts — pushFullState(), appended to the `state` array (after the updateBoard entry)
                { type: 'updateBoard', cards, dbUnavailable: false, /* …unchanged… */ surface: SURFACES.kanban },
                // The Project panel reads plan columns from its own kanban.db query, not
                // from updateBoard. Tell it to re-fetch whenever the board state is pushed
                // — the standalone equivalent of the extension host's refreshUI hook.
                // project.js:433 debounces this at 200ms; PANEL_SURFACES deliberately omits
                // 'project' (wsHub.ts) so the undeclared browser Project panel receives it.
                { type: 'refreshKanbanPlans', surface: SURFACES.project },
```

**Edge cases.** `pushFullState` already returns early when `!server` (boot ordering) and is wrapped in `try/catch`. `SURFACES.project` is an existing member of the `SURFACES` const (`wsHub.ts`). Every element of the `state` array already carries both `type` and `surface`, so the union the array infers keeps `msg.type` / `msg.surface` accessible in the broadcast loop — no cast needed. `pushFullState` is coalesced at 40ms upstream (`PUSH_COALESCE_MS`, `:461`) and again at 200ms in `project.js`, so an autoban sweep still produces one fetch.

## Verification Plan

### Automated Tests

No automated tests are added and none are run for this change, per the session directives (SKIP COMPILATION / SKIP TESTS). The behaviour under change is a webview push whose effect is a debounced re-fetch in a browser context, which the existing harnesses do not cover: `TaskViewerProvider.refreshUI.test.ts` exercises an inlined copy of the workspace guard rather than the real method, and the headless verb harness builds its own `BroadcastHub` and so cannot observe production push wiring. Manual verification is the gate.

For a future hardening pass, the natural fit is a **source assertion** in the style of `src/test/webview-panel-runtime-surface.test.js` — assert that `refreshUI`'s body, `moveCardToColumnByPlanFile`'s `if (moved)` block, and `pushFullState`'s `state` array each contain a `refreshKanbanPlans` push. That form survives the absence of a webview harness. Not in scope here.

### Manual verification — extension host, board panel open

1. **Reproduce the bug first (pre-fix).** Open the kanban board and the project panel side by side. Note a plan in CREATED on both. Drag it forward to PLAN REVIEWED on the board. The board updates immediately; switch to the project panel's Kanban Plans tab and confirm the plan is **still in CREATED**.
2. **Verify the fix.** Apply all three changes, reload the extension, repeat step 1. The project panel shows **PLAN REVIEWED** within ~200ms.
3. **Move-backward path.** Drag a plan from PLAN REVIEWED back to CREATED. Project panel reflects CREATED.
4. **Move-forward via prompt copy.** Click "Copy Prompt" on a board card (auto-advances the column). Project panel updates.
5. **Complete-plan path.** Complete a plan from the board. Project panel moves it to COMPLETED (or drops it from the active list, per the completed hot-window).
6. **Feature cascade.** Move a feature card on the board. Project panel reflects the new column for the feature **and** all subtasks.
7. **Debounce under load.** Trigger an autoban sweep or select 3+ cards and move them forward. Watch the Project panel's webview console: exactly **one** `fetchKanbanPlans` round-trip, not one per card — and not two per card despite Change 1 and Change 2 both firing.

### Manual verification — extension host, board panel CLOSED (covers root cause #2)

8. **API move with the board closed.** Close the kanban board panel, leave the Project panel open on its Kanban Plans tab. From a terminal, `POST /kanban/move` (via `.agents/skills/_lib/sb_api_call.sh` or the `kanban_operations` `move-card.js` path) for a plan visible in the panel. Confirm the Project panel updates within ~200ms. **Pre-fix and with a `refreshUI`-only fix this stays stale** — this step is the one that distinguishes the complete fix from the incomplete one.
9. **Remote-control move with the board closed.** Trigger a column change from Linear/Notion remote control with the board panel closed. Project panel updates.
10. **No panel open.** Close the Project panel entirely, move a card on the board, and confirm no errors in the extension host console (`_planningPanelProvider` undefined or the optional method absent — both `?.` guards no-op). Reopen the Project panel; it shows the correct column via the existing `onDidChangeViewState` refresh.

### Manual verification — standalone / browser cockpit (covers root cause #3)

11. **Browser board → browser Project panel.** Run `npx switchboard`, open the cockpit, open the Board and the Project panel. Move a card on the Board. Confirm the Project panel's Kanban Plans list reflects the new column within ~200ms, and that the WS frame `refreshKanbanPlans` appears in the browser devtools network/WS log.
12. **Standalone API move.** With the cockpit's Project panel open, `POST /kanban/move` against the standalone server. Project panel updates.
13. **Cross-host.** With the VS Code extension running and a browser cockpit attached, move a card in the editor's board and confirm **both** the editor Project panel and the cockpit Project panel refresh (`postMessageToProjectWebview` mirrors to WS `'project'` and delivers to the editor webview).

### Gate checks (run these, they are not compilation or tests)

14. `npm run push-routing:check` — must stay green. None of the three changes adds a `.webview.postMessage(` call, so `TaskViewerProvider.ts` remains at baseline 1 and `KanbanProvider.ts` at baseline 1.
15. `npm run parity:check` — must stay green. No verb added, no allowlist or catalog entry changed.

## Agent Recommendation

**Send to Coder** (complexity 4).
