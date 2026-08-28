# Push the eight missing board-state messages from the shared state builder

## Goal

Standalone's board never receives eight of the fourteen state messages the extension's board receives. The most consequential is `updateAgentNames`: without it the shared board silently strips every forward drag-drop before it reaches the backend. Close the gap in the **shared** state builder so both hosts emit the same set from one route.

### Problem Analysis

The shared board HTML (`src/webview/kanban.html`) gates forward drops on knowing which agent sits behind the target column:

```js
// kanban.html:10206
if (dropMode === 'cli' && cliTriggersEnabled && !isColumnAgentAvailable(effectiveTargetColumn)) {
    forwardIds.length = 0;   // forward moves stripped; backward moves proceed
}
```

`isColumnAgentAvailable` (`:8471`) → `isColumnAgentAssigned` (`:8464`) reads `lastAgentNames[role]`. `lastAgentNames` has exactly one writer: `case 'updateAgentNames'` (`:10969`).

`updateAgentNames` is posted from one place: `KanbanProvider.refreshWithData` (`src/services/KanbanProvider.ts:2502`). Its only caller is `TaskViewerProvider._refreshRunSheetsImpl` (`:21259`) — the **extension's** refresh path.

The two composition roots diverge on what `switchboard.refreshUI` means:

| Host | `switchboard.refreshUI` runs | Message types delivered |
| :--- | :--- | :--- |
| Extension (`src/extension.ts`) | `TaskViewerProvider.refreshUI` → `_refreshRunSheets` → `KanbanProvider.refreshWithData` | 14 |
| Standalone (`src/standalone/bootstrap.ts:1130`) | `schedulePushFullState()` → `pushFullState` (`:588`) → `KanbanProvider.getFullStateMessages` (`:1319`) | 6 |

`getFullStateMessages` returns only: `updateColumns`, `updateWorkspaceSelection`, `cliTriggersState`, `updateBoard`, `updateAutobanConfig`, `updatePairProgrammingMode`.

Missing in standalone, all eight:

| Message | Consequence in the browser |
| :--- | :--- |
| `updateAgentNames` | `lastAgentNames` stays `{}` → **every forward drag silently discarded** |
| `visibleAgents` | falls back to `DEFAULT_VISIBLE_AGENTS` (`sharedDefaults.js`, `tester:false`) → ACCEPTANCE TESTED rejects forward drops regardless of real config |
| `updateColumnDragDropModes` | `columnDragDropModes` stays `{}` → `dropMode` always resolves `'cli'` (`:10201`); a column persisted as `prompt` behaves as CLI after every reload, and the column-header `.mode-toggle` renders `cli` while the DB says otherwise |
| `dynamicComplexityRoutingState` | complexity-routing toggle shows its default, not stored state |
| `allowUnknownComplexityAutoMoveState` | same class |
| `collapseCodersState` | same class |
| `clearTerminalBeforePromptState` | same class |
| `liveSyncStates` | pause/resume indicator shows a default |

`_refreshBoardImpl` returns early on `!this._panel` (`:3934`), which is why standalone substituted its own push in the first place — that part is correct. `refreshWithData` itself is broadcaster-capable (`:2286` guards on `!panel && !broadcaster`), so the auxiliary pushes are not editor-specific; they are merely sequenced inside a method standalone cannot reach.

### Root Cause

Exactly the failure mode `CLAUDE.md` names: not verb reachability but **composition-root wiring**. Standalone answers every verb (the `default:` arm at `bootstrap.ts:1470` delegates); what differs is the read-back path each host wires. The auxiliary state pushes live inside a method reachable from one root only, and `Promise<void>` push seams make "never wired" and "working" the same value.

Aggravating factor: the fix must not land in `bootstrap.ts`. A standalone-only literal push would be a second route that can disagree with the first — the divergence pattern `CLAUDE.md` forbids. `getFullStateMessages` already computes `visibleAgents` at `:1356` and simply does not emit it.

## Metadata

**Complexity:** 5
**Tags:** backend, ui, bugfix, reliability

## Approach

1. **Emit all eight from `getFullStateMessages`.** One route, both hosts. `visibleAgents` is already in scope; `updateAgentNames` needs `await this._getAgentNames(root)` (already headless-safe — it prefers `_taskViewerProvider.getStartupCommands`, falling back to reading `.switchboard/state.json` directly); `updateColumnDragDropModes` needs `this._columnDragDropModesForScope(scope, filteredColumns)`, which is already scope-aware and already called in the factory-form push. The four toggle-state messages read plain fields.

2. **Tag every entry with its surface.** Follow the existing convention in that return array — tag as built, never by post-processing the assembled array (the comment at `:1352` explains why: conditionally spread entries would ship untagged, i.e. to every panel).

3. **Render scope-dependent entries as factories where the extension does.** `updateColumnDragDropModes` is scope-dependent (`_columnDragDropModesForScope`). `pushFullState` already demonstrates the pattern for `updateBoard`/`cliTriggersState` (`bootstrap.ts:615-663`) — a scope-dependent entry must be broadcast as a factory so `wsHub` renders it per connection, not flattened once.

4. **Have `refreshWithData` consume the same builder for these eight** rather than keeping a parallel literal cluster at `:2470-2520`. If that refactor proves too invasive for one change, leave `refreshWithData` alone and add a contract test asserting the two sets are equal — but prefer the single builder: two clusters is how this bug was born.

5. **Do not touch `bootstrap.ts`'s push logic** beyond what step 3 requires. The standalone-specific overrides already there (`dispatchAnalyzeAvailable: ptyReady`, `terminalCreateAvailable: false`) are honest host facts and stay.

## Complexity Audit

### Routine

- Adding entries to an array that already returns six of them.
- `_getAgentNames`, `_getVisibleAgents`, `_columnDragDropModesForScope` all exist and are host-agnostic.

### Complex / Risky

- **The extension will now receive these messages twice** — once from `refreshWithData`, once from `getFullStateMessages` (used for the browser WS resync and the Agent Control panel snapshot, `:1523`, `:9471`). Every one of the eight handlers is idempotent (assign + re-render), so this is wasteful rather than wrong; step 4 removes the duplication. Verify no handler accumulates (`lastVisibleAgents` merges with spread, `lastAgentNames` replaces — both safe).
- **`updateAgentNames` has a deliberate `setTimeout(..., 0)` in its handler** (`kanban.html:10971-10974`) so a pending `updateColumns` is processed first and custom-agent columns exist before roles resolve. Emitting it in the same array as `updateColumns` keeps that ordering assumption satisfied, but the WS fan-out must not reorder the array. Confirm `wsHub` preserves order for a single broadcast batch.
- **`_getAgentNames` cost.** It calls `getStartupCommands` + `getCustomAgents` per invocation. `getFullStateMessages` is called on every `ready`, `refresh`, and coalesced push — measure before assuming it is free, and reuse the `customAgents` already fetched at `:1351` rather than fetching twice.
- **`liveSyncStates` may carry extension-only meaning.** Check what it reflects before emitting it headlessly; if it describes a watcher standalone genuinely does not run, emit an honest value rather than a copied `true`. A flag that fakes capability is worse than an absent one (the `terminalCreateAvailable: false` comment in `bootstrap.ts` is the precedent).
- **Scope correctness.** `undefined` scope must resolve to the singleton fallback, an explicitly-null scope to no project tier. The accessors own that precedence — pass `scope` raw, do not normalise it at the call site.

## Edge-Case & Dependency Audit

**Migration.** None. No persisted state changes. All eight settings already exist in released versions and are already written by their toggle verbs — this plan only makes standalone *read them back*. A user who set a column to `prompt` mode in VS Code and then opened the browser board has been getting CLI behaviour; after this they get what they configured. That is the fix, and it changes behaviour on existing installs — call it out in the release note.

**The forward-drag path after this fix.** Unblocking the gate routes forward drops to `triggerAction` (single) or `triggerBatchAction` (batch). In standalone `triggerAction` is PTY-gated (`bootstrap.ts:1459-1467`) and additionally gated on `kanban.cliTriggersEnabled` (`:2080`). So this plan alone converts a silent no-op into an honest error on a host without node-pty or with CLI triggers off — necessary, not sufficient. The companion UI plan makes those states recoverable from the browser.

**Both hosts.** The extension's board must be verified unchanged: same messages, same order, no double-render flicker on a column with many cards.

**Ordering.** Ships first and independently. The UI plan assumes `updateColumnDragDropModes` is live — without it, unhiding the mode selector would expose a control whose state never reads back.

## Verification Plan

1. **Reproduce first.** Against `npx switchboard`, open the browser board, drag a card forward into a coded column. Record: card animates, snaps back, no toast, no DB change (`GET /kanban/board` shows the original column). In the browser console, `document.body` state check: the board has received no `updateAgentNames`.
2. **After the change**, the same drag persists — the card stays after a reload and `GET /kanban/board` reports the new column.
3. **Message-set assertion.** A contract test that calls `getFullStateMessages` against a fixture workspace and asserts all fourteen types are present, listing them explicitly. This is the durable deliverable.
4. **Per-message read-back, in the browser:** set a column to `prompt` in VS Code, reload the browser board, assert the column-header toggle renders `prompt` and a drop copies a prompt instead of dispatching. Repeat for `visibleAgents` (hide a role, assert the column agent line reads "No agent assigned" rather than blank) and for each of the four toggle states.
5. **Extension host unchanged:** open the VS Code board, confirm all eight still arrive, once-effective, and that no column re-renders twice per refresh.
6. `npm run compile` clean; `tsc` clean; `npm run standalone-parity:check`, `host-seam-parity:check`, and the headless contract suites green.
7. **Manual, both hosts:** drag forward, drag backward, drag into STAGING, drag out of COMPLETED. All four behave identically in the editor and the browser.

## Dependencies

- Pairs with **the standalone drag-drop UI plan** (unhides the controls this plan makes functional) and **the reachability-aware parity gate** (stops the class recurring). This one ships first.
- `check-standalone-push-parity.js` counts `updateAgentNames` as deliverable today because it is a provider `postMessage` type; that false green is the gate plan's subject, not this one's.
