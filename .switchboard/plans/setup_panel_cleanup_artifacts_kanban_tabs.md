# Simplify Setup Panel: Remove Kanban & Artifacts Tabs, Relocate Settings

## Goal
Remove two redundant tabs from `setup.html` (Kanban, Artifacts Panel) and relocate their settings to more natural homes: per-source "Show in Artifacts Panel" toggles in the ClickUp/Linear/Notion tabs, and a "Cache Mode" control in the `planning.html` docs tab — while fixing `PlanningPanelProvider` so it actually honours the `planning.enabledSources` config it currently ignores.

## Metadata
**Tags:** frontend, backend, UI, UX
**Complexity:** 7

## User Review Required
The following decisions need a human call before/while implementing — they change behaviour or carry data-consistency risk:

1. **Where does the sync-mode backend live?** The plan moves the Cache Mode UI from `setup.html` (served by `SetupPanelProvider`) to `planning.html` (served by `PlanningPanelProvider`). The sync-mode message handlers + helpers **already exist and work** in `SetupPanelProvider.ts` (handlers at lines 747-797; helpers `_getPlanningPanelSyncMode`/`_setPlanningPanelSyncMode`/`_getPlanningPanelSelectedContainers`/`_setPlanningPanelSelectedContainers`/`_fetchAvailableSyncContainers`/`_triggerPlanningPanelSync` at lines 1312-1404). Confirm the intent: **port** this logic into `PlanningPanelProvider` (which already owns `triggerSync()` at line 6015 and `_resolveSyncConfig()` at line 187), and decide whether to **delete the now-orphaned handlers from `SetupPanelProvider`** or leave them as harmless dead code. Recommendation: port into `PlanningPanelProvider`, leave `SetupPanelProvider`'s versions in place for this change (low risk) and file a follow-up to remove them.
2. **Workspace-root source of truth.** `SetupPanelProvider` resolves the root via the Kanban provider (`_getCurrentWorkspaceRoot()`), and the existing `switchboard.triggerPlanningPanelSync` command (extension.ts:828) also uses `kanbanProvider.getCurrentWorkspaceRoot()`. The plan proposes `PlanningPanelProvider` use `this._getWorkspaceRoot() || this._getWorkspaceRoots()[0]`. In a **multi-root workspace these can resolve to different roots**, so sync mode could be written to one workspace DB while periodic sync targets another. Confirm the canonical root and use it consistently for read, write, and trigger.
3. **Per-source toggle save semantics.** Confirm the new per-source toggles send the **complete** `planning.enabledSources` object (all four sources) on each change, not just the toggled one — see the Security/Side-Effects audit for why a partial post silently disables the others.

## Root Cause Analysis

The setup panel has grown organically and now contains tabs that duplicate entry points or cluster unrelated settings. Three specific problems:

1. **Kanban tab is a dead-end.** It contains only an "OPEN KANBAN VIEW" button. The same action is available from the status bar and `implementation.html`'s quick-actions menu. It wastes horizontal tab space and confuses the setup flow.

2. **Artifacts Panel tab mixes two unrelated concerns.** "Enabled Sources" (which online docs appear in the Artifacts panel) and "Document Caching" (how docs are cached locally) have nothing to do with each other. Worse, the "Enabled Sources" checkboxes are largely redundant: the Artifacts panel already infers available sources from whether an API key exists for each integration. The checkboxes persist to `planning.enabledSources` in VS Code workspace settings, but **PlanningPanelProvider currently ignores that config** — `_sendOnlineDocsReady` (PlanningPanelProvider.ts:4897) sets every available source to `enabledSources[s] = true` in the `onlineDocsReady` message (lines 4912-4917).

3. **Document Caching belongs where documents are viewed.** Users shouldn't leave the docs context to change caching behavior. A control in the docs tab's controls strip (`#controls-strip-docs`, planning.html:3071) is discoverable and contextual.

## Complexity Audit

### Routine
- **Removing the Kanban tab from `setup.html`** — pure deletion of one tab button (line 472), one content panel (`#kanban-fields`, line 569), one `case 'kanban'` hydration branch, and the `btn-open-kanban` click listener (line 3036). The `case 'openKanban'` handler in `SetupPanelProvider.ts` (line 469) stays.
- **Removing the Artifacts Panel tab markup** — deletion of the tab button (line 479) and the `#artifacts-panel-fields` panel (lines 977-1055).
- **Removing the `planningSources` broadcast from `TaskViewerProvider.postSetupPanelState`** (lines 3865-3873) — localized deletion.
- **Adding per-source toggle markup** to the three integration tabs (`#clickup-fields` line 638, `#linear-fields` line 792, `#notion-fields` line 947) reusing the existing `.startup-row` checkbox pattern (see lines 986-1001).

### Complex / Risky
- **Porting the sync-mode backend into `PlanningPanelProvider`.** New message cases (`getPlanningPanelSyncMode`, `setPlanningPanelSyncMode`, `fetchAvailableSyncContainers`, and the **missing-from-original-plan** `setPlanningPanelSelectedContainers`) must reuse the panel's existing `_resolveSyncConfig()`/`triggerSync()` and write to `KanbanDatabase.forWorkspace(root)`. Risk: cross-provider duplication, cache staleness, and workspace-root divergence (see audits below).
- **Fixing `_sendOnlineDocsReady` to honour `planning.enabledSources`.** Behaviour change for every Artifacts-panel open. Must default missing config to `true` for backward compatibility, and must read the config at the correct (folder) scope to match how `SetupPanelProvider` writes it.
- **The new per-source toggle save path.** The existing `savePlanningSources` handler rewrites the entire `enabledSources` object from message fields; a partial post is a silent data-loss bug (see Security/Side Effects).

## Edge-Case & Dependency Audit

### Race Conditions
- **Rapid tab switching in `setup.html`.** Per-source toggles request `getPlanningSources` on tab activation; rapid switching can fire overlapping hydration requests. Use the debounce already present in setup.html's hydration pattern. Last response wins; payload is idempotent so no corruption, only a possible flash of stale checkbox state.
- **`_resolvedConfigCache` staleness.** `_resolveSyncConfig()` (PlanningPanelProvider.ts:199) returns a cached object. `triggerSync()`'s `sync-selected` branch (line 6032) reads `config.selectedContainers` from that cache. After `setPlanningPanelSyncMode`/`setPlanningPanelSelectedContainers` write new values to the DB, the cache **must be invalidated** (`this._resolvedConfigCache = null`) before calling `triggerSync`, or the sync runs against stale containers.
- **Sync mode changed before panel fully initialised.** `getPlanningPanelSyncMode` fires on docs-tab activation/panel open; the dropdown must tolerate the `planningPanelSyncModeReady` reply arriving after the user has already interacted. Guard the handler against a not-yet-rendered dropdown.

### Security
- **No new attack surface** — all data is local config (VS Code settings + Kanban DB). Sources are gated by existing API-key presence checks in `ResearchImportService`.
- **Silent disable via partial save (data-integrity, not classic security).** `SetupPanelProvider.savePlanningSources` (line 691) builds the full object `{clickup, linear, notion, 'local-folder'}` from `message.* === true`. Any source **absent** from the message is written as `false`. The new per-source toggle therefore must NOT post only the changed source; it must post the complete current state of all four. Mitigation: on toggle change, read the last hydrated `enabledSources`, apply the single change, post the whole object.

### Side Effects
- **`_sendOnlineDocsReady` behaviour change.** Previously every available source was shown; after the fix, a source with `enabledSources[x] === false` disappears from the Artifacts panel. This is the intended effect but is user-visible immediately on next panel open/refresh. Default-to-`true`-when-missing preserves current behaviour for users who never touched the setting.
- **Config scope mismatch.** `SetupPanelProvider` writes `planning.enabledSources` **folder-scoped** (`_getWorkspaceFolderUri(...)`, `ConfigurationTarget.WorkspaceFolder`, line 699-705). `_sendOnlineDocsReady` must read with the matching folder URI (`vscode.workspace.getConfiguration('switchboard', folderUri)`), not the workspace-merged read the original plan implied, or a folder-scoped `false` may not be observed correctly in a multi-folder workspace.
- **Orphaned handlers in `SetupPanelProvider`.** Once the Artifacts Panel tab is gone, the sync-mode handlers there have no caller. `getPlanningSources`/`savePlanningSources` remain in use (per-source toggles). Decide per User Review #1.

### Dependencies & Conflicts
- **`switchboard.triggerPlanningPanelSync` command** (extension.ts:828) depends on `kanbanProvider.getCurrentWorkspaceRoot()`. Keep its behaviour intact; if `PlanningPanelProvider` calls its own `triggerSync()` directly, ensure the root passed matches the root written to.
- **`KanbanDatabase.forWorkspace(root)`** is the single backing store for `planning.syncMode` and `planning.selectedContainers` — no migration; existing values keep working.
- **`planning.js`** currently has **zero** sync-mode handling (grep confirmed), so all of Requirement 6 is net-new — no conflict with existing handlers, but the new message-type names must match exactly what the ported backend posts.
- **Message-type naming.** The existing serialized contract uses `planningPanelSyncModeReady` (carrying both `mode` and `selectedContainers`) and `availableSyncContainersReady`. Reuse those exact names/shapes in `planning.js` rather than the original plan's `planningPanelSyncMode` to avoid divergence.

## Dependencies
- `sess_XXXXXXXXXXXXX — Artifacts Panel source-filtering / ResearchImportService availability` (capture the real session id if one exists; otherwise none)
- None known beyond the in-repo coupling listed in **Dependencies & Conflicts**.

## Adversarial Synthesis
**Risk Summary:** Key risks are (1) the per-source toggle silently disabling other sources because `savePlanningSources` overwrites the entire `enabledSources` object — mitigated by always posting the full state; (2) `_resolvedConfigCache` staleness causing `sync-selected` to run against old containers — mitigated by invalidating the cache after every DB write; and (3) workspace-root divergence between where sync mode is written and where periodic sync runs in multi-root workspaces — mitigated by choosing one canonical root for read/write/trigger. Secondary risk: reading `planning.enabledSources` at the wrong config scope so folder-scoped `false` values are missed — mitigated by reading with the folder URI.

## Proposed Changes

### `src/webview/setup.html`
- **Context:** Hosts the tab strip (lines 472-479) and per-tab content panels; served by `SetupPanelProvider`.
- **Logic:** Remove the Kanban and Artifacts Panel tabs entirely; add per-source toggles to the three integration tabs.
- **Implementation:**
  - Delete `<button ... data-tab="kanban">` (line 472) and `<button ... data-tab="artifacts-panel">` (line 479).
  - Delete `#kanban-fields` panel (line 569) including the `btn-open-kanban` button (line 573).
  - Delete `#artifacts-panel-fields` panel (lines 977-1055).
  - Delete related JS: the `case 'kanban'` hydration branch; `btn-open-kanban` listener (line 3036); `btn-save-planning-sources` listener (line 3289) + `savePlanningSources` post (line 3296); `planning-sources-status` updates (line 4392); `planning-sync-mode` radio listeners (lines 3675-3693); `planning-sync-selected-containers` toggling; `planning-containers-list` population (line 4473); the `getPlanningPanelSyncMode`/`fetchAvailableSyncContainers` hydration calls (lines 1666, 3693, 4556); and the `planningSources`/`planningPanelSyncModeReady`/`availableSyncContainersReady` message cases (lines 4392, 4473, 4532).
  - In `#clickup-fields`, `#linear-fields`, `#notion-fields`: add a `.startup-row` checkbox labeled **"Show docs in Artifacts Panel"** (reuse the markup pattern from old lines 986-1001). Hydrate from `getPlanningSources` (`planningSources` message) on tab activation. On change, post `savePlanningSources` with **the complete `{clickup, linear, notion, localFolder}` object** (current hydrated state + this change), never a single field.
- **Edge Cases:** Debounce hydration on rapid tab switching; ensure the toggle reflects the `planningSources` reply even if it arrives after activation.

### `src/services/SetupPanelProvider.ts`
- **Context:** Message router for `setup.html`. Owns `openKanban`, `savePlanningSources`, `getPlanningSources`, and the (soon-orphaned) sync-mode handlers + helpers.
- **Logic:** Keep the handlers the new toggles still use; leave the sync-mode handlers as-is for this change (per User Review #1).
- **Implementation:**
  - **Keep** `case 'openKanban'` (line 469), `case 'savePlanningSources'` (line 691), `case 'getPlanningSources'` (line 799).
  - **Verify** `savePlanningSources` (line 691) is only ever called with the full source object now that the per-source toggles post complete state (see Security audit). No code change required, but this is the contract the new UI must honour.
  - Do **not** delete `_getPlanningPanelSyncMode`/`_setPlanningPanelSyncMode`/`_fetchAvailableSyncContainers`/`_get/_setPlanningPanelSelectedContainers`/`_triggerPlanningPanelSync` in this change; mark for a follow-up cleanup once `planning.html` is verified.
- **Edge Cases:** None beyond the save-contract note.

### `src/services/PlanningPanelProvider.ts`
- **Context:** Serves `planning.html`. Already owns `_resolveSyncConfig()` (line 187), `triggerSync()` (line 6015), `_sendOnlineDocsReady()` (line 4897), `_getWorkspaceRoot`/`_getWorkspaceRoots`, and `ResearchImportService` adapters.
- **Logic:** Add sync-mode message handling (ported from `SetupPanelProvider`) and fix `enabledSources` to honour config.
- **Implementation:**
  - Add message cases:
    - `getPlanningPanelSyncMode` — resolve canonical root; read `planning.syncMode` (`'no-sync'` default) and `planning.selectedContainers` from `KanbanDatabase.forWorkspace(root)`; post `planningPanelSyncModeReady` with `{ mode, selectedContainers }` (matching the existing contract).
    - `setPlanningPanelSyncMode` — write `planning.syncMode` to the DB; **invalidate `this._resolvedConfigCache`**; then `await this.triggerSync(root, mode)`.
    - `fetchAvailableSyncContainers` — call `adapter.listContainers()` per available source (mirroring `_fetchAvailableSyncContainers`, SetupPanelProvider.ts:1348); post `availableSyncContainersReady` with `{ containers, selectedContainers }`.
    - **`setPlanningPanelSelectedContainers`** (missing from the original plan) — write `planning.selectedContainers` (JSON) to the DB; invalidate the cache; `await this.triggerSync(root, 'sync-selected')`. Required for the picker to persist.
  - Use ONE canonical workspace root for read/write/trigger (resolve per User Review #2; prefer the root `_resolveSyncConfig` already discovered as `sourceRoot`, falling back to `_getWorkspaceRoot() || _getWorkspaceRoots()[0]`). Disable the dropdown when no root is available.
  - **Fix `_sendOnlineDocsReady` (lines 4912-4917):** replace the unconditional `enabledSources[s] = true` with a read of `planning.enabledSources` at the matching folder scope (`vscode.workspace.getConfiguration('switchboard', folderUri).get('planning.enabledSources')`), defaulting any missing source to `true`. Only override to `false` when the config explicitly says so.
- **Edge Cases:** Cache invalidation after every DB write; no-root → disabled control; folder-scope read; tolerate `planning.enabledSources` being `undefined` or partially populated.

### `src/webview/planning.html`
- **Context:** Docs-tab controls strip at `#controls-strip-docs` (line 3071), next to `#docs-workspace-filter` (line 3072).
- **Logic:** Add a Cache Mode control and an inline selected-containers picker.
- **Implementation:**
  - Add a **Cache Mode** `<select>` (options: `no-sync` → "No Sync (Manual Only)", `auto-sync-all` → "Auto Sync All", `sync-selected` → "Sync Selected Containers") styled like `.workspace-filter-select`, placed near `#docs-workspace-filter`.
  - On change → post `setPlanningPanelSyncMode { mode }`. When `sync-selected` is chosen, post `fetchAvailableSyncContainers` and reveal an inline container picker; checkbox changes post `setPlanningPanelSelectedContainers { containers: [...] }` (reuse the `${sourceId}:${id}` value shape from setup.html line 4508).
  - On docs-tab activation / panel open → post `getPlanningPanelSyncMode`.
- **Edge Cases:** Disabled state + tooltip when no workspace root; container picker hidden unless mode is `sync-selected`.

### `src/webview/planning.js`
- **Context:** No existing sync-mode handling (confirmed). All net-new.
- **Logic:** Persist sync mode in panel state and handle the backend replies.
- **Implementation:**
  - Add `syncMode` (and `selectedContainers`) to the persisted state object.
  - Add message handlers: `planningPanelSyncModeReady` → set dropdown value, store mode, toggle picker visibility; `availableSyncContainersReady` → populate the container picker (reuse setup.html population logic, lines 4473-4530).
  - Initialise by posting `getPlanningPanelSyncMode` on panel load / docs-tab show.
- **Edge Cases:** Reply may arrive after the dropdown renders — guard for the element existing; restore state on reload.

### `src/services/TaskViewerProvider.ts`
- **Context:** `postSetupPanelState` (line 3833) currently broadcasts `planningSources` (lines 3865-3873) to `setup.html`.
- **Logic:** Remove that broadcast — setup.html no longer has the Artifacts Panel tab; per-source toggles pull state on demand via `getPlanningSources`.
- **Implementation:** Delete the `enabledSources` read (3865) and the `planningSources` post (3872-3873). Leave the rest of `postSetupPanelState` intact.
- **Edge Cases:** Confirm no other webview consumes the `planningSources` broadcast from this method (the per-source toggles use the request/response `getPlanningSources` path in `SetupPanelProvider`, not this broadcast).

## Verification Plan

> Note for this session: compilation (`tsc`/build) and the automated test suite are **not** run here — the user runs them separately. The items below define what must pass.

### Automated Tests
- Unit-test `PlanningPanelProvider._sendOnlineDocsReady`: (a) missing `planning.enabledSources` → all available sources `true`; (b) `{clickup:false}` → clickup `false`, others `true`; (c) folder-scoped config is read with the folder URI.
- Unit-test the new `setPlanningPanelSyncMode` path: writing a mode invalidates `_resolvedConfigCache` and calls `triggerSync` with the same root that was written.
- Unit-test `setPlanningPanelSelectedContainers`: persists JSON to `KanbanDatabase`, invalidates cache, triggers `sync-selected`.
- Regression-guard the per-source toggle contract: posting a single-source change still results in a full `enabledSources` object (no other source flipped to `false`).

### Manual Validation
1. Open Setup panel. Confirm Kanban tab and Artifacts Panel tab are absent.
2. ClickUp tab → toggle "Show docs in Artifacts Panel" off, save. Open Planning panel → docs tab. Confirm ClickUp docs no longer appear; confirm Linear/Notion docs **still** appear (regression guard for the overwrite bug).
3. Re-enable ClickUp in Setup. Confirm ClickUp docs reappear.
4. Planning panel docs tab → Cache Mode → "Auto Sync All". Verify periodic sync begins (extension host logs).
5. Select "Sync Selected Containers". Verify picker appears populated with ClickUp lists / Linear projects / Notion databases; select some, confirm they persist and sync runs against exactly those.
6. Select "No Sync". Verify sync stops and only manually viewed docs are cached.
7. Reload VS Code. Verify last cache mode, selected containers, and source toggles persist.
8. Multi-root workspace: switch the Kanban active workspace, change Cache Mode, confirm it writes to and syncs the intended root (User Review #2).

## Files Changed
- `src/webview/setup.html` — remove Kanban & Artifacts Panel tabs and related JS; add per-source toggles to ClickUp/Linear/Notion tabs.
- `src/webview/planning.html` — add Cache Mode control + container picker to docs tab controls strip.
- `src/webview/planning.js` — add sync mode state, dropdown handlers, and message handling.
- `src/services/PlanningPanelProvider.ts` — add `getPlanningPanelSyncMode`/`setPlanningPanelSyncMode`/`fetchAvailableSyncContainers`/`setPlanningPanelSelectedContainers` cases; invalidate `_resolvedConfigCache` on writes; fix `_sendOnlineDocsReady` to honour `planning.enabledSources`.
- `src/services/SetupPanelProvider.ts` — keep `openKanban`/`savePlanningSources`/`getPlanningSources`; orphaned sync-mode handlers left for follow-up cleanup.
- `src/services/TaskViewerProvider.ts` — remove `planningSources` broadcast from `postSetupPanelState`.

---

**Recommendation: Send to Lead Coder.** (Complexity 7 — cross-provider message-contract duplication, DB-config cache invalidation, workspace-root consistency, and a silent config-overwrite trap make this more than a routine cleanup.)
