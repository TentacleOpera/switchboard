# Fix Restored Kanban Panel: No Workspace Selected and Stale Column List (Intern/AUTOCODE Missing)

## Goal

Make a kanban webview panel restored via `switchboard.persistPanels` (VS Code panel serializer) come up fully initialized after an IDE restart — workspace selected, full column set (including `INTERN CODED`), synthetic AUTOCODE column working, and column collapse functional — identical to a freshly opened panel.

### Problem statement

After an IDE restart with `switchboard.persistPanels` enabled, the restored kanban panel shows:
1. **No workspace selected** in the workspace dropdown (empty dropdown; board never loads until the user manually switches workspaces).
2. **`INTERN CODED` column missing** entirely.
3. **AUTOCODE column absent and collapse broken** — toggling "Collapse Coders" makes coder cards render nowhere.

Closing and reopening the panel fixes everything, confirming the bug is confined to the deserialize/restore path.

### Root cause analysis

**Primary cause — restore path initializes in the wrong order and gives up silently.**

`deserializeWebviewPanel` (`src/services/KanbanProvider.ts:1362-1430`) runs the fresh-open sequence in reverse:

- `open()` (`KanbanProvider.ts:1262-1360`) calls `_resolveWorkspaceRoot()` at line 1331 — whose side effect auto-selects and assigns `this._currentWorkspaceRoot` (lines 986-993) — **before** `_initKanbanService()` at line 1344.
- `deserializeWebviewPanel()` calls `_initKanbanService()` at line 1374 **before** resolving the root at line 1413. `_initKanbanService` (`KanbanProvider.ts:6621-6665`) bails out when `_currentWorkspaceRoot` is empty and **nulls the broadcaster** (line 6625). Nothing in the restore path re-invokes it after the root is resolved.

Additionally, VS Code invokes the serializer during window restore, which can race ahead of `vscode.workspace.workspaceFolders` and the `WorkspaceIdentityService` mapping index being populated (`hostSeams.ts:342-344`, `KanbanProvider.ts:910-935`). When `_resolveWorkspaceRoot()` returns `null`:

- `_getHtml` skips injecting the `data-initial-workspace-root` body attribute (`KanbanProvider.ts:10409-10414`), so the webview's `currentWorkspaceRoot` seed stays `''` (`kanban.html:4139-4143`).
- On the webview's `ready` message → `switchboard.fullSync` (`KanbanProvider.ts:6792-6796`), **both** refresh paths silently early-return on the unresolved root: `_refreshBoardImpl` (`KanbanProvider.ts:3147-3148`) and `_refreshRunSheetsImpl` (`src/services/TaskViewerProvider.ts:17112-17115`). Consequently neither `updateWorkspaceSelection` (`KanbanProvider.ts:1754-1769`, `3333-3344`) nor `updateColumns` (`KanbanProvider.ts:1745`, `3312`, `3497`) is ever posted.
- The webview never persists workspace selection in `vscode.getState()` (only `collapseCodersEnabled`, `currentAutomationMode`, `lastAntigravityBatchSize`), so it cannot self-recover. Only a manual `selectWorkspace` (`KanbanProvider.ts:7019-7057`) re-drives the board — matching the observed manual workaround.

> **Superseded (clarification of the primary mechanism):** The original analysis implies the blank board in the *common* (non-race) case is caused by the broadcaster being null and the `data-initial-workspace-root` attribute being skipped.
> **Reason:** `_getHtml` calls `_resolveWorkspaceRoot()` *internally* at line 10408, so in the non-race case the body attribute IS injected and `_currentWorkspaceRoot` IS set (via the auto-select side effect at line 991) by the time `deserializeWebviewPanel` reaches line 1413. More importantly, `postMessage` (`KanbanProvider.ts:1873-1883`) falls back to a direct `_panel.webview.postMessage` when `_broadcaster` is null — so a null broadcaster does not block the first paint. The real mechanism in the common case is that **no path explicitly calls `_refreshBoard(root)` after the root is resolved and the webview becomes ready**: the `ready` handler routes to `switchboard.fullSync` → `taskViewerProvider.fullSync()` (`TaskViewerProvider.ts:3629-3642`) → `_refreshRunSheets` (sidebar/run-sheets only), which never invokes `kanbanProvider._refreshBoard`; and `onDidChangeViewState` (`KanbanProvider.ts:1419-1423`) only fires on a visibility *change*, which is unreliable for a panel that is already visible when deserialize completes.
> **Replaced with:** The primary fix must (a) reorder + re-init the service (still correct, wires the broadcaster/service for extracted verbs and cross-panel fan-out), AND (b) **explicitly push the board on the webview `ready` message** by calling `_refreshBoard(root)` (or `_scheduleBoardRefresh`) once the root is resolved and the service is initialized — mirroring what `selectWorkspace` does at line 7054. The race-case early-returns remain real and are addressed by the deferred recovery below.

**Secondary cause — stale hardcoded webview fallback column list.**

The webview's built-in `columnDefinitions` fallback (`src/webview/kanban.html:4074-4082`) predates the intern column: it has no `INTERN CODED` entry and its coder columns lack `kind: 'coded'`. The backend treats intern as an ordinary default column (`src/services/agentConfig.ts:135`), so intern is not conditional — the webview is simply stuck on the stale fallback when `updateColumns` never arrives. AUTOCODE is a webview-synthetic column built from definitions with `kind: 'coded'` (`kanban.html:5115-5135`); with no tagged definitions it never forms, yet `renderBoard` still suppresses the individual coder columns when collapse is on (`kanban.html:5933`, `CODED_IDS` at 4109) — so collapsed coder cards render nowhere.

**Tertiary inconsistency.** The restore path rebuilds `webview.options` with only `enableScripts` + `localResourceRoots` (`KanbanProvider.ts:1380-1383`), dropping the `retainContextWhenHidden: true` that fresh open sets (`KanbanProvider.ts:1293`).

## Metadata

**Complexity:** 6
**Tags:** bugfix, ui, frontend, reliability

## User Review Required

None.

## Uncertain Assumptions

The user ran web research (per the `advise_research` skill). Both assumptions below were **confirmed** by authoritative sources, so the plan stands as written:

1. **`WebviewPanel.onDidChangeViewState` does NOT fire on the deserialize-time show transition.** Confirmed by a VS Code maintainer (mjbvz) in microsoft/vscode issue #145648 ("WebviewPanel onDidChangeViewState not triggering consistently on initial webview load"): the event fires only on subsequent visibility/column changes, not for the state transition that happens *during* `deserializeWebviewPanel` itself. Restored panels can start `active: true` without an accompanying event. This validates the plan's load-bearing rationale: the explicit `_refreshBoard` on the webview `ready` message is **mandatory**, not a belt-and-braces extra — `onDidChangeViewState` cannot be relied on for the initial restore push. The official webview-sample extension posts initial state from `deserializeWebviewPanel` after setting `webview.html`, and the documented community pattern is a `ready`/mount handshake, not a view-state event.
2. **`retainContextWhenHidden` is a creation-only `WebviewPanelOptions` property.** Confirmed via the `vscode.d.ts` type declarations and the official custom-editor guide: it lives on `WebviewPanelOptions` (the fourth argument to `createWebviewPanel`), NOT on `WebviewOptions` (`panel.webview.options`). `WebviewOptions` is the smaller mutable surface (`enableScripts`, `localResourceRoots`, `enableCommandUris`, `enableForms`, `portMapping`) and can be freely reassigned inside `deserializeWebviewPanel` (the official sample does exactly this to refresh `localResourceRoots` after an extension update). There is no documented setter for `retainContextWhenHidden` on an existing panel. This validates step 4's demotion to a documented code-comment constraint rather than a real fix.

## Complexity Audit

### Routine
- Reordering two calls in `deserializeWebviewPanel` to mirror `open()`'s sequence.
- Re-invoking `_initKanbanService()` after root resolution (existing method, no new logic).
- Adding the `INTERN CODED` entry and `kind: 'coded'` to the webview fallback `columnDefinitions` array (data-only edit).
- Guarding the `renderBoard` collapse suppression with a `col-CODED_AUTO` DOM-existence check.
- Adding `currentWorkspaceRoot` to existing `vscode.getState()/setState()` call sites via a small `saveWebviewState()` helper.
- Demoting `retainContextWhenHidden` to a documented code-comment constraint.

### Complex / Risky
- Deferred re-initialization for the startup race: registering a one-shot `onDidChangeWorkspaceFolders` listener + bounded retry, with correct disposal in `onDidDispose` and a guard against leaking listeners on a genuinely root-less window.
- Explicitly driving `_refreshBoard(root)` from the `ready` handler without double-pushing on fresh open or racing the `onDidChangeViewState` path (debounce/idempotency).
- Treating the webview-persisted `currentWorkspaceRoot` as untrusted input and ensuring the validation path (`setCurrentWorkspaceRoot`) is the one actually invoked, not `_resolveWorkspaceRoot`.
- Coordinating a `_pendingRootRecovery` flag across `KanbanProvider` and the `_refreshRunSheetsImpl` skip site in `TaskViewerProvider` without coupling the two providers tightly.

## Edge-Case & Dependency Audit

**Race Conditions**
- Serializer can run before `vscode.workspace.workspaceFolders` and the `WorkspaceIdentityService` mapping index are populated → `_resolveWorkspaceRoot()` returns `null`. Mitigation: `onDidChangeWorkspaceFolders` one-shot + bounded retry polling `_resolveWorkspaceRoot()`.
- `ready` may arrive before the backend recovery resolves the root, or after. The ready handler must re-attempt resolve and, if still null, rely on the armed recovery; if resolved, push the board immediately.
- Two board-push triggers (`ready`-push and `onDidChangeViewState`) may both fire → use the existing `_scheduleBoardRefresh` 100ms debounce (`KanbanProvider.ts:3593-3600`) to coalesce; do not bypass it.
- Bounded retry timer firing after panel dispose: `_refreshBoard` already guards on `!this._panel` (`KanbanProvider.ts:3128`) — rely on it and clear the timer in `onDidDispose`.

**Security**
- Webview-persisted `currentWorkspaceRoot` is untrusted (any extension can write webview state). It MUST be validated via `setCurrentWorkspaceRoot` (`KanbanProvider.ts:1081-1087`), which checks `_getAllowedRoots()` + `_getWorkspaceRoots()` and rejects unknown roots. If the persisted root is no longer allowed, ignore it silently (no UI message, per project convention).

**Side Effects**
- Re-ordering `deserializeWebviewPanel` must not change the `onDidDispose` snapshot-reset behavior (lines 1391-1411) — keep that block intact.
- Adding `currentWorkspaceRoot` to webview state is additive; existing `getState()` keys (`collapseCodersEnabled`, `currentAutomationMode`, `lastAntigravityBatchSize`) must continue to be read. Merge, do not replace, the state object.
- The fallback column-list change affects only the pre-`updateColumns` window; once `updateColumns` arrives the backend list wins (existing behavior).

**Dependencies & Conflicts**
- Do NOT entangle with the uncommitted `_handleMessage` refactor in `KanbanProvider.ts`.
- Do NOT change `switchboard.persistPanels` default or serializer registration (`src/extension.ts:3143-3150`).
- Do NOT change `DEFAULT_KANBAN_COLUMNS` composition or `_filterDynamicColumns` behavior.
- `WorkspaceIdentityService` exposes no async populate event; the index is built at activation (`extension.ts:226-227`) and rebuilt on the `switchboard.mappingsChanged` *command* (not an event). Recovery must not assume a populate signal exists.

## Dependencies

- None (no prerequisite sessions).

## Adversarial Synthesis

Key risks: (1) the common-case blank board is caused by no explicit `_refreshBoard` on restore — not by the null broadcaster — so the fix MUST add a ready-driven board push or the goal is unmet; (2) the webview-persisted workspace root is untrusted and must be validated via `setCurrentWorkspaceRoot` (not `_resolveWorkspaceRoot` as originally stated); (3) `retainContextWhenHidden` is creation-only and cannot be applied at deserialize, so step 4 is a documented constraint, not a fix. Mitigations: explicit `_refreshBoard` on `ready` via the existing `_scheduleBoardRefresh` debounce; reuse `setCurrentWorkspaceRoot`'s existing allowed-roots validation; rely on steps 1-3 + ready-push for context retention and document the `retainContextWhenHidden` limitation in a code comment.

## Proposed Changes

### `src/services/KanbanProvider.ts`

**Context:** The deserialize path diverges from `open()` in initialization order and never explicitly pushes the board after the root resolves.

**Logic:**
1. **Reorder `deserializeWebviewPanel` (`1362-1430`) to match `open()`.** Call `this._resolveWorkspaceRoot()` (letting its auto-select side effect assign `_currentWorkspaceRoot`) **before** `this._initKanbanService()`, mirroring `open()`'s line 1331 → 1344 ordering. Keep the `onDidDispose` snapshot-reset block (1391-1411) intact.
2. **Re-invoke `_initKanbanService()` defensively** if resolution succeeds after a prior bail, so the broadcaster/service are wired.
3. **Explicitly push the board on `ready` (the load-bearing fix).** In the `ready` handler (`6792-6817`), after ensuring the root is resolved and `_initKanbanService` has run, call `this._scheduleBoardRefresh(this._currentWorkspaceRoot)` (or `this._refreshBoard(root)`) when `_currentWorkspaceRoot` is set — mirroring `selectWorkspace` at line 7054. This must run for BOTH the just-resolved case and the already-set case. Route through `_scheduleBoardRefresh` to coalesce with any `onDidChangeViewState` fire and avoid a double push. If the root is still unresolved at `ready`, arm the recovery (see step 4) and skip the push.
4. **Deferred re-initialization for the race.** When `_resolveWorkspaceRoot()` returns `null` at restore time, register a one-shot `vscode.workspace.onDidChangeWorkspaceFolders` listener + a bounded retry (a few attempts over the first seconds) that re-runs `resolve → _initKanbanService() → _scheduleBoardRefresh(root)`, then disposes the listener. Do NOT assume a `WorkspaceIdentityService` async populate signal exists — poll `_resolveWorkspaceRoot()`. Dispose all recovery listeners/timers in the panel's `onDidDispose` (rely on the existing `!this._panel` guard at `_refreshBoard:3128` as the backstop).
5. **Arm recovery at the skip site.** Set a `_pendingRootRecovery` flag when `_refreshBoardImpl` (`3145-3148`) skips for lack of a root, consumed by the recovery listener/ready-retry.
6. **`retainContextWhenHidden` parity — documented constraint.** `retainContextWhenHidden` is a `WebviewPanelOptions` creation-time property and cannot be applied via `webview.options` at deserialize time (the serializer hands over an already-created panel). Add a code comment at the options rebuild (`1380-1383`) documenting this constraint and noting that context retention on restored panels relies on steps 1-3 + the ready-push. Do NOT add the property to `webview.options` (it is not a valid `WebviewOptions` field).

**Implementation:** Edits confined to `deserializeWebviewPanel` (`1362-1430`), the `ready` handler (`6792-6817`), `_refreshBoardImpl` skip site (`3145-3148`), and a new `_pendingRootRecovery` field + recovery listener wiring disposed in `onDidDispose`.

**Edge Cases:** Bounded retry must not leak listeners on a genuinely root-less window; double-push coalesced via `_scheduleBoardRefresh`; timer cleared on dispose.

### `src/services/TaskViewerProvider.ts`

**Context:** `_refreshRunSheetsImpl` silently early-returns on an unresolved root; the skip must become recoverable.

**Logic:** At the `_refreshRunSheetsImpl` skip site (`17111-17115`), keep the early return (a null root must not fabricate state) but signal the kanban provider to arm recovery — set the kanban provider's `_pendingRootRecovery` flag (minimal cross-provider touch: a public setter or a method on `KanbanProvider` that `TaskViewerProvider` already holds a reference to). Do not couple the two providers further than this single flag touch.

**Implementation:** ~1-3 line change at the skip site.

**Edge Cases:** Avoid introducing a circular dependency; reuse the existing `_kanbanProvider` reference.

### `src/webview/kanban.html`

**Context:** The fallback `columnDefinitions` is stale, the collapse suppression can render cards into nowhere, and the webview cannot self-recover its workspace selection.

**Logic:**
1. **Fallback column list (`4074-4082`).** Add `{ id: 'INTERN CODED', label: 'Intern', role: 'intern', kind: 'coded' }` and add `kind: 'coded'` to the `LEAD CODED` and `CODER CODED` entries so the synthetic AUTOCODE column (`5115-5135`) can form before `updateColumns` arrives.

   > **Superseded:** "Keep the fallback aligned with `DEFAULT_KANBAN_COLUMNS` (`src/services/agentConfig.ts:129-140`) — copy ids/labels/roles/kinds exactly."
   > **Reason:** The webview fallback is a deliberately simplified schema (no `order`, no `source`, no `dragDropMode`; it carries `autobanEnabled` directly). `DEFAULT_KANBAN_COLUMNS` additionally contains `RESEARCHER` (`131`) and `TICKET UPDATER` (`138`) that the fallback intentionally omits. Blindly "copying exactly" would either break the webview's shape or pull in columns the render path does not expect from the fallback.
   > **Replaced with:** Copy only what the bug requires — the `INTERN CODED` entry and `kind: 'coded'` on the two coder entries — keeping the fallback's existing simplified shape. Do not add `RESEARCHER`/`TICKET UPDATER`/`order`/`source`/`dragDropMode` to the fallback unless a separate need is demonstrated.

2. **`renderBoard` collapse guard (`5912-5933`).** Only skip the individual coder columns (`CODED_IDS` check at `5933`) when the `col-CODED_AUTO` container actually exists in the DOM. If AUTOCODE was not created, render the individual coder columns normally even when `collapseCodersEnabled` is true — degrading to "collapse temporarily off" instead of "cards vanish."
3. **Persist workspace selection (self-recovery seed).** Centralize the existing `vscode.getState()/setState()` call sites (`~7463`, `8317`, `8535`, `9600`; read at `4100`) into a small `saveWebviewState()` helper and include `currentWorkspaceRoot` in the payload. On load, read `currentWorkspaceRoot` back as a fallback seed when `data-initial-workspace-root` is absent, and post it to the backend via the existing `selectWorkspace` message so the backend validates it.

   > **Superseded:** "selectWorkspace/refresh paths already validate against allowed roots via `_resolveWorkspaceRoot(msg.workspaceRoot)` — reuse that validation."
   > **Reason:** `selectWorkspace` (`KanbanProvider.ts:7019-7057`) does not call `_resolveWorkspaceRoot` for validation; it calls `setCurrentWorkspaceRoot(msg.workspaceRoot)` (`7022`), which performs the allowed-roots validation in `setCurrentWorkspaceRoot` (`1081-1087`) via `_getAllowedRoots()` + `_getWorkspaceRoots()`. Naming the wrong method would mislead an implementer into thinking validation lives in `_resolveWorkspaceRoot`.
   > **Replaced with:** The persisted root is validated by routing it through the existing `selectWorkspace` message (which invokes `setCurrentWorkspaceRoot`); if the persisted root is no longer an allowed root, `setCurrentWorkspaceRoot` rejects it and the seed is ignored. Do not bypass `selectWorkspace` with a direct `_resolveWorkspaceRoot` call.

**Implementation:** Edits to the fallback array, the `renderBoard` collapse branch, and the state read/write sites.

**Edge Cases:** State merge (not replace); persisted root treated as untrusted; no UI message on rejected seed.

## Files to Modify

- `src/services/KanbanProvider.ts` — deserialize reorder, re-init, ready-driven board push, recovery hooks, `_pendingRootRecovery` flag, `retainContextWhenHidden` constraint comment, disposal.
- `src/services/TaskViewerProvider.ts` — arm recovery flag at the `_refreshRunSheetsImpl` skip site (minimal touch).
- `src/webview/kanban.html` — fallback column list (INTERN CODED + `kind:'coded'`), `renderBoard` collapse guard, workspace state persistence via `saveWebviewState()`.

## Out of Scope

- Any change to the `switchboard.persistPanels` setting default or serializer registration in `src/extension.ts:3143-3150` (registration itself works; the provider-side handling is what's broken).
- Column model changes, `DEFAULT_KANBAN_COLUMNS` composition, or `_filterDynamicColumns` behavior.
- The broader `_handleMessage` refactor currently uncommitted in `KanbanProvider.ts` — this plan layers on top; do not entangle with it.
- Extracting a shared `_postPanelSetup(root)` helper to eliminate the `open()`/`deserialize` divergence class (recommended as a follow-up after this fix ships, to avoid touching the working fresh-open path in the same change).

## Verification Plan

Testing is done via installed VSIX (do not verify against `dist/` in-repo). No automated tests or compilation steps are part of this verification plan.

### Automated Tests

None — verification is manual via the installed VSIX (per project convention for webview-panel restore behavior, which cannot be exercised headlessly).

### Manual Verification

1. **Restored-panel happy path (the load-bearing check):** enable `switchboard.persistPanels`, open the kanban, restart the IDE. On restore, without touching the dropdown: workspace is selected, board populates, `INTERN CODED` column present, AUTOCODE column present when "Collapse Coders" is on, toggle works both directions. This confirms the explicit `_refreshBoard` on `ready` actually pushes the board in the non-race case.
2. **Race simulation:** with a multi-root/mapped-workspace setup (where identity mappings populate late), restart and confirm the recovery hook fires — board self-heals within the retry window instead of staying blank.
3. **Fresh-open regression:** close and reopen the panel (non-restore path) — behavior unchanged (no double-push, no extra board flash).
4. **Fallback degradation:** temporarily block `updateColumns` (dev tools) on a fresh webview and confirm the fallback list now shows intern and a functioning AUTOCODE/collapse (step 5/6 defense).
5. **State persistence:** switch workspaces, restart, confirm the restored panel reselects the last workspace even if `data-initial-workspace-root` injection is skipped; confirm `collapseCodersEnabled` persistence still works (state merge, not replace). Confirm a persisted root that is no longer an allowed root is silently ignored (no board load, no error UI).
6. **No confirm dialogs introduced; no new user-facing warning messages for the transient unresolved-root state.**
7. **Listener leak check:** restore in a genuinely root-less window (no workspace folders) and confirm the bounded retry expires and disposes its listeners within the expected window.

## Recommendation

Complexity 6 (Mixed) — **Send to Coder**.

## Completion Summary

Implemented the restored kanban panel fixes:

- `src/services/KanbanProvider.ts`: Reordered `deserializeWebviewPanel` so workspace root resolves before `_initKanbanService()`; added `_startRootRecovery()` / `_stopRootRecovery()` / `_tryRecoverRoot()` plus a public `setPendingRootRecovery()` for cross-provider signaling; wired recovery disposal in `dispose()` and both `onDidDispose` blocks; added an explicit board push on the `ready` message via `_scheduleBoardRefresh()`; documented `retainContextWhenHidden` as a creation-time property in a code comment; armed recovery at the `_refreshBoardImpl` root-null skip.
- `src/services/TaskViewerProvider.ts`: At the `_refreshRunSheetsImpl` root-null skip, calls `this._kanbanProvider?.setPendingRootRecovery(true)` so the kanban provider can recover.
- `src/webview/kanban.html`: Added `INTERN CODED` and `kind: 'coded'` to the fallback `columnDefinitions`; guarded `renderBoard` coder-column suppression on the existence of `col-CODED_AUTO`; centralized state persistence in `saveWebviewState()` and persisted `currentWorkspaceRoot`; seeded `currentWorkspaceRoot` from webview state when `data-initial-workspace-root` is absent and re-sent it via `selectWorkspace` for backend validation.

Manual VSIX verification was not run; the verification plan explicitly skips compilation and automated tests.
