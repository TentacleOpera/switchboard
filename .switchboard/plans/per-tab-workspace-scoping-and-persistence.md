# Per-Tab Workspace Scoping + Persistent Navigation Across All Panel Tabs

## Metadata
- **Tags:** frontend, backend, refactor, feature
- **Complexity:** 8

## User Review Required
- None — all scope decisions were pre-approved on 2026-06-12 (default root behavior, Online Docs filter default, and globalState persistence strategy).
- Re-review only if implementation reveals a need for new confirmation dialogs or user-facing breaking changes (project rule: no confirmation dialogs).

## Goal
Every tab in the Planning panel and Design panel gets its own independent workspace dropdown (the kanban pattern), and every tab's workspace selection — plus the Tickets tab's full ClickUp/Linear navigation (space → folder → list, Linear project, search/filter values) — persists across panel close/reopen and VS Code restarts via `globalState` keyed by workspace root.

**Core principle (user requirement, stated explicitly):** the user multitasks across repos constantly — e.g. kanban on `switchboard` while browsing tickets for `viaapp`. No tab may share a workspace root with another tab, and nothing may assume one "active" workspace per panel.

## Background & Problem Analysis

Audit of all 9 tabs (2026-06-12):

| Panel | Tab | Status | Detail |
|---|---|---|---|
| Planning | Kanban | ✅ correct | Own dropdown `kanban-workspace-filter` (`planning.js:3432`), client-side filter via `kanbanFilters.workspaceRoot` |
| Planning | Local Docs | ✅ correct | Own dropdown `local-workspace-filter` (`planning.js:217`), filters by `metadata.root` |
| Planning | Tickets | ❌ global | Every fetch sends shared `currentWorkspaceRoot` (`planning.js:5778, 5835, 5844`); set by `integrationProviderPreference` message (`planning.js:3137`). No dropdown. Navigation saved only to `vscode.setState` (`planning.js:5891`) which dies with the panel — this is the original bug: ClickUp Sprint-116 navigation lost on every panel reopen |
| Planning | Online Docs | ❌ merged | All roots' docs merged in one list (`planning.js:1509`), no filter |
| Planning | Research | ❌ implicit global | Import message sends no `workspaceRoot` (`planning.js:398`); backend falls back to active/first root. Destination-folder list is silently driven by the **Local Docs** tab's filter (`planning.js:1489`) — cross-tab coupling bug |
| Planning | NotebookLM | ❌ implicit global | Bundle/import messages carry no root; backend falls back via `_getWorkspaceRoot() \|\| allRoots[0]` (`PlanningPanelProvider.ts:308`) |
| Design | HTML Previews | ✅ correct (not persisted) | `html-workspace-filter` (`design.html:3395`), `state.htmlWorkspaceRootFilter` (`design.js:28`) |
| Design | Design System | ✅ correct (not persisted) | `design-workspace-filter` (`design.html:3346`), `state.designWorkspaceRootFilter` (`design.js:29`) |
| Design | Stitch | ❌ no workspace concept | All ops hardcode `this._getWorkspaceRoot()` (`DesignPanelProvider.ts:1008, 1073, 1155`); all output to that single root's `.stitch/` |

Persistence today is `vscode.setState()` (webview state), which survives only panel hide — **not** panel close (panels are `createWebviewPanel`, `PlanningPanelProvider.ts:266`, no serializer) and not reload/restart. Even the "correct" tabs reset their workspace filter to All Workspaces on every reopen.

## Why globalState keyed by root (not workspaceState, not setState)
- `vscode.setState`: dies when the panel tab is closed → the reported bug.
- `workspaceState`: keyed to the VS Code window's workspace, so (a) one flat blob would leak ClickUp IDs across repos in a multi-root window, (b) the same repo opened standalone vs in a multi-root workspace gets different buckets.
- `context.globalState` with a per-root map `{ [resolvedRootPath]: tabState }`: state follows the repo regardless of window arrangement, each repo remembered independently, survives restarts. Matches how ClickUp/Linear integration config is already per-root in `.switchboard/`.

Dev-only project: delete the old `vscode.setState` tickets persistence outright, no migration.

## Resolved Decisions (user-approved 2026-06-12)
- **Tickets default root on first open:** when no persisted selection exists, default the tickets workspace dropdown to the first root that has a ClickUp/Linear integration configured; fall back to `allRoots[0]` if none do.
- **Online Docs filter default:** "All Workspaces" (matches kanban).

## Phases

### Phase 1 — Shared infrastructure
1. **`workspaceItems` broadcast:** Planning provider already builds `_buildKanbanWorkspaceItems()` (`PlanningPanelProvider.ts:908`). Extract/reuse so the same `{ workspaceRoot, label }[]` list is sent once on webview init (and on `onDidChangeWorkspaceFolders`) for ALL tabs, both panels. DesignPanelProvider already tags files with `_root` — add the same items broadcast.
2. **Per-root persisted panel state service:** small helper on each provider:
   - `getPanelTabState(root: string, tabKey: string): any` / `setPanelTabState(root, tabKey, value)` backed by `context.globalState` under keys like `switchboard.panelState.<panel>.<tabKey>` storing `{ [resolvedRoot]: state }`.
   - Resolve roots with `path.resolve()` before keying (consistent with `PlanningPanelProvider.ts:927`).
   - Webview ↔ provider messages: `persistTabState { tabKey, workspaceRoot, state }` and initial `restoredTabState { byTab }` pushed with the init payload.
3. **Webview helper:** one `populateWorkspaceDropdown(elementId, items, selected)` already exists in planning.js (`planning.js:1468` call site) — reuse; port equivalent to design.js if not present.

### Phase 2 — Tickets tab (the original bug; highest value)
1. **Add dropdown** `tickets-workspace-filter` to the tickets toolbar in `planning.html` (next to the existing refresh/view-mode controls).
2. **New tab-local variable** `ticketsWorkspaceRoot` in planning.js. Remove all tickets-path reads of `currentWorkspaceRoot` (`loadLinearProject` 5778, `loadClickUpSpaces` 5835, `loadClickUpTaskDetails`, `clickupLoadProject` 5798, import/refine/askAgent 5844/5854/5881, local tickets requests) → send `ticketsWorkspaceRoot`.
3. **Per-root navigation state:** extend `saveTicketsState()`/`restoreTicketsState()` (`planning.js:5891/5910`) to:
   - persist via `persistTabState` (provider → globalState), keyed by `ticketsWorkspaceRoot`, NOT `vscode.setState` (delete that path);
   - save on **every** mutation: space/folder/list dropdown change, Linear project pick, search/filter input (debounced), view-mode toggle — not just on internal-tab switch (current holes at `planning.js:365, 5070`);
   - persist `ticketsWorkspaceRoot` itself (panel-level, not per-root).
4. **Workspace switch behavior:** on dropdown change → save outgoing root's nav state, reset in-memory ClickUp/Linear state, restore incoming root's state, and if it has a saved `clickUpSelectedSpaceId`/`linearProjectPickerValue`, kick the existing restore chain (`_restoringClickUpHierarchy`, `planning.js:5923-5933`).
5. **Provider:** tickets handlers already accept `msg.workspaceRoot` — verify each resolves the per-root sync service (they do, via factories) and that none silently fall back to `_getWorkspaceRoot()` when `msg.workspaceRoot` is set.
6. **`integrationProviderPreference` (`planning.js:3137`):** stop letting it overwrite the tickets root; it should only set the provider default for the *current tickets root* (provider must compute it per-root on demand — see Edge Cases).

### Phase 3 — Stitch tab (Design panel)
1. Add `stitch-workspace-filter` dropdown to the Stitch title bar in `design.html`.
2. Tab-local `stitchWorkspaceRoot` in design.js; include it in every stitch message (`stitchOpenManifest`, `stitchSyncProject`, `stitchDownloadAsset`, generate, fetch).
3. `DesignPanelProvider`: thread `msg.workspaceRoot` through to `_getStitchOutputDir(workspaceRoot)` (`DesignPanelProvider.ts:432`) and the handlers at 1008/1073/1155 instead of `this._getWorkspaceRoot()`.
4. Persist `stitchWorkspaceRoot` + per-root `selectedStitchProjectId` via the Phase-1 service. (`stitchModelId`/`stitchCreativeRange`/`stitchAspects` can stay panel-global — they're user prefs, not repo state — but move them off `vscode.setState` to globalState so they survive reopen too.)
5. Project list must reload when the workspace dropdown changes (projects live under the selected root's `.stitch/`).

### Phase 4 — Research + NotebookLM tabs
1. **Research:** add `research-workspace-filter` dropdown; tab-local `researchWorkspaceRoot`.
   - Destination-folder select populates from `localFolderPathsByRoot[researchWorkspaceRoot]` — sever the coupling to the Local Docs tab filter at `planning.js:1489`.
   - `importResearchDoc` message (`planning.js:398`) sends `workspaceRoot: researchWorkspaceRoot`; provider `_handleImportResearchDoc` (`PlanningPanelProvider.ts:4552`) already takes it — remove the fallback-to-active-root behavior for this path.
   - Persist selection per Phase-1 service.
2. **NotebookLM:** add `notebook-workspace-filter` dropdown; tab-local `notebookWorkspaceRoot`; send it in `airlock_openNotebookLM` and `importNotebookLMPlans`; provider handlers (`PlanningPanelProvider.ts:1392, 1406`) use it instead of the `_getWorkspaceRoot() || allRoots[0]` fallback. The `switchboard.importNotebookLMPlans` command needs to accept a root argument.

### Phase 5 — Online Docs tab
1. Add `online-workspace-filter` dropdown ("All Workspaces" default) to the online docs toolbar.
2. Data is already delivered per-root (`msg.roots`, `planning.js:1509`) — filter the rendered sections client-side by selected root, mirroring Local Docs.
3. Persist selection.

### Phase 6 — Persistence sweep for already-correct tabs
1. Persist `kanbanFilters.workspaceRoot`, `state.localWorkspaceRootFilter`, `state.htmlWorkspaceRootFilter`, `state.designWorkspaceRootFilter` via the Phase-1 service (panel-level values); restore on init and re-apply filters after first data load.
2. Remove now-redundant `vscode.setState` usage where globalState supersedes it (keep setState only for ephemera not worth surviving reopen, e.g. scroll positions — judgement call per value).

## Proposed Changes

### `src/webview/planning.html`
- **Context:** Tickets toolbar lacks workspace filter; all fetches default to shared global root.
- **Logic:** Insert `<select id="tickets-workspace-filter" class="workspace-filter-select">` in `#controls-strip-tickets` (line ~3153), next to refresh button.
- **Implementation:** Copy `local-workspace-filter` pattern (line 2937). Populate from shared `workspaceItems` broadcast. On change, update `ticketsWorkspaceRoot`.
- **Edge Cases:** If no workspace folders open, panel already errors early; empty dropdown is harmless.

### `src/webview/planning.js`
- **Context:** `currentWorkspaceRoot` (line 55) is used by **three distinct code paths**: tickets, local docs, and kanban epic/subtask ops. A global rename would break all of them.
- **Complete non-tickets usages (must NOT be touched or must be redirected to their own tab-local root):**
  - **Local Docs / Folder modal** — `removeLocalFolder` (line 932), `removeLocalFolder` inside modal (line 989), `handleLocalFolderPathUpdated` fallback (line 1885), `localFoldersListed` fallback (line 2623), `addLocalFolder` from modal (line 4549). These correctly fall back to `currentWorkspaceRoot` only when `state.localWorkspaceRootFilter` is empty. They should continue to do so; Local Docs already has its own filter (`state.localWorkspaceRootFilter`).
  - **Kanban epic/subtask ops** — `getEpicDetails` (line 3826), `addSubtaskToEpic` (line 3838), `deleteEpic` (line 3847), `removeSubtaskFromEpic` (line 3860). These use `currentWorkspaceRoot` but **should** use `kanbanFilters.workspaceRoot` (the Kanban tab already owns a workspace filter). This is an existing cross-tab coupling bug: if tickets tab switched `currentWorkspaceRoot` to repo B while Kanban is filtered to repo A, clicking an epic fetches details from repo B.
- **Logic:** Introduce `let ticketsWorkspaceRoot = '';` near line 55. Migrate **only** tickets POST messages to carry it. Keep `currentWorkspaceRoot` untouched for local-folder fallback paths. Redirect Kanban epic ops to `kanbanFilters.workspaceRoot`.
- **Tickets migration checklist (exact line numbers from grep):**
  1. Declare `ticketsWorkspaceRoot` (~line 55).
  2. Add dropdown listener near line 217.
  3. `integrationProviderPreference` (line 3137): stop assigning `currentWorkspaceRoot` for tickets; set `ticketsWorkspaceRoot` instead.
  4. ClickUp hierarchy: `clickupLoadFolders` (3047), `clickupLoadLists` (3072).
  5. Load functions: `loadLinearProject` (5778), `loadLinearTaskDetails` (5781), `clickupLoadProject` (5798), `loadMoreClickUpTasks` (5809), `loadClickUpSpaces` (5835), `requestLocalTickets` (5017).
  6. Ticket actions: `importAllTickets` (4585), `editTicket` (4602), `pushTicket` (4649, 4667), `deleteTicketConfirmed` (4678), `changeTicketStatus` (4690), `postTicketComment` (4722), `downloadAttachment` (4786), `sendTicketToAgent` (5881).
  7. Folder modal: `removeTicketsFolder` (987), `addTicketsFolder` (4547).
  8. Replace `saveTicketsState()` (5891) and `restoreTicketsState()` (5910) to post `persistTabState` to provider instead of `vscode.setState`.
  9. Persist `ticketsWorkspaceRoot` itself as a panel-level value.
  10. On workspace switch: save outgoing state → reset ClickUp/Linear vars → restore incoming state → kick restore chain if needed (lines 5923-5933).
- **Kanban fix (same file, separate concern):**
  - Epic/subtask ops (lines 3826, 3838, 3847, 3860): change `workspaceRoot: currentWorkspaceRoot` → `workspaceRoot: kanbanFilters.workspaceRoot || currentWorkspaceRoot` so they respect the Kanban tab's own filter.
- **Edge Cases:**
  - Stale response discard: add `if (msg.workspaceRoot !== ticketsWorkspaceRoot) return;` in every tickets response handler before mutating DOM or state.
  - Do not delete `currentWorkspaceRoot`; it is still the local-folder fallback.
  - Verify `grep -n "currentWorkspaceRoot" planning.js` returns **only** non-tickets hits (local-folder fallbacks + kanban epic ops) before marking Phase 2 done.

### `src/services/PlanningPanelProvider.ts`
- **Context:** Provider messages default to `this._getWorkspaceRoot() || allRoots[0]` (line 1000), breaking per-root tickets scoping.
- **Logic:** Thread `msg.workspaceRoot` through all tickets handlers. Send `workspaceItems` + `restoredTabState` before first tab render.
- **Implementation:**
  1. `_handleMessage` (line 992): when `msg.workspaceRoot` is present, use it directly instead of global fallback (line 1000). Resolve with `path.resolve()` before use (consistent with line 905).
  2. `_buildKanbanWorkspaceItems()` (line 908): reuse for init broadcast.
  3. Add `getPanelTabState(root, tabKey)` / `setPanelTabState(root, tabKey, value)` helpers backed by `this._context.globalState` under `switchboard.panelState.planning.<tabKey>` storing `{ [resolvedRoot]: state }`.
  4. On webview init (panel creation, line ~266), post `restoredTabState { byTab }` after `workspaceItems`.
  5. `_handleImportResearchDoc` (line 4552): remove fallback to active root when `msg.workspaceRoot` is provided.
  6. `importNotebookLMPlans` handler (line 1392): pass `msg.workspaceRoot` into `switchboard.importNotebookLMPlans` command; update command registration to accept optional root argument.
- **Edge Cases:**
  - If persisted root not in current `workspaceFolders`, fall back to default and leave stale globalState entry untouched.
  - Root resolution must use `path.resolve()` before keying globalState (line 905).

### `src/webview/design.html`
- **Context:** Stitch tab has no workspace filter; all output lands in active root's `.stitch/`.
- **Logic:** Add `stitch-workspace-filter` dropdown in `#controls-strip-stitch` (line ~3466), mirroring `design-workspace-filter` (line 3346).
- **Implementation:** Insert `<select id="stitch-workspace-filter" class="workspace-filter-select">` before project-select. Populate from shared `workspaceItems`. On change, reload Stitch project list from selected root's `.stitch/`.
- **Edge Cases:** If selected root has no `.stitch/` directory, show empty project list rather than error.

### `src/webview/design.js`
- **Context:** No workspace-scoped Stitch state; `stitchModelId`/`stitchCreativeRange`/`stitchAspects` are panel-global.
- **Logic:** Add `stitchWorkspaceRoot` variable. Include it in every Stitch message. Move model/creative/aspect off `vscode.setState` to globalState so they survive reopen.
- **Implementation:**
  1. Declare `stitchWorkspaceRoot` near line 28 (next to `htmlWorkspaceRootFilter`).
  2. Add dropdown listener near line 1695 (next to `design-workspace-filter` listener).
  3. Update all `vscode.postMessage({ type: 'stitch...' })` to include `workspaceRoot: stitchWorkspaceRoot`.
  4. Persist `stitchWorkspaceRoot` and `selectedStitchProjectId` per-root via `persistTabState`; persist model/creative/aspect panel-globally.
- **Edge Cases:** Rapid workspace switch during screen generation must drop stale results. Tag stitch response messages with `workspaceRoot` and guard the handler.

### `src/services/DesignPanelProvider.ts`
- **Context:** Stitch handlers hardcode `this._getWorkspaceRoot()` (lines 1008, 1073, 1155).
- **Logic:** Accept `msg.workspaceRoot`, resolve it, and pass to `_getStitchOutputDir(workspaceRoot)` (line 432).
- **Implementation:**
  1. `stitchOpenManifest` (line 1006): `const workspaceRoot = msg.workspaceRoot || this._getWorkspaceRoot();` then `_getStitchOutputDir(workspaceRoot)`.
  2. `stitchSyncProject` (line 1071): same pattern.
  3. `stitchDownloadAsset` (line 1153): same pattern.
  4. Add `getPanelTabState`/`setPanelTabState` helpers using `this._context.globalState` under `switchboard.panelState.design.<tabKey>`.
  5. Broadcast `workspaceItems` on init and `onDidChangeWorkspaceFolders` (already has `_buildKanbanWorkspaceItems()` at line 225).
- **Edge Cases:** `msg.workspaceRoot` may be undefined from older webviews; fallback to `this._getWorkspaceRoot()` preserves backward compat.

### `src/webview/planning.js` — Online Docs, Research, NotebookLM
- **Context:** These tabs lack workspace filters and implicitly use global or coupled roots.
- **Logic:** Add `online-workspace-filter`, `research-workspace-filter`, `notebook-workspace-filter`. Filter Online Docs client-side from existing `msg.roots` data. Sever Research destination-folder coupling to Local Docs filter.
- **Implementation:**
  1. **Online Docs:** Add dropdown in `#controls-strip-online` (line ~2987). Default to "All Workspaces". Filter rendered nodes with `msg.nodes.filter(n => n.metadata?.root === onlineWorkspaceRoot)` mirroring Local Docs (line 1469). Persist via `persistTabState`.
  2. **Research:** Add dropdown near Research card. Set `researchWorkspaceRoot`. Change `populateResearchFolderSelect` to read `localFolderPathsByRoot[researchWorkspaceRoot]` (line 1489 currently reads from `state.localWorkspaceRootFilter`). Update `importResearchDoc` message (line 398) to include `workspaceRoot: researchWorkspaceRoot`.
  3. **NotebookLM:** Add dropdown near NotebookLM card. Set `notebookWorkspaceRoot`. Update `airlock_openNotebookLM` and `importNotebookLMPlans` messages to carry it.
- **Edge Cases:** Research folder modal shared with Local Docs (`folderModalScope`) must still work; use `getCurrentFolderPaths(state.localFolderPathsByRoot, researchWorkspaceRoot)` when modal opened from Research tab.

## Complexity Audit

### Routine
- Adding dropdowns + change listeners (copy kanban pattern verbatim)
- Threading `workspaceRoot` through existing messages (most provider handlers already accept it)
- globalState get/set helper

### Complex / Risky
- **Tickets restore chain re-entry on workspace switch** — `_restoringClickUpHierarchy` flag interacts with `ticketsLoadedOnce`/`ticketsInitialized` guards (`planning.js:348-366`); switching roots mid-restore must cancel the in-flight chain (stale responses for the old root must be dropped — tag requests with the root and discard mismatches).
- **`integrationProviderPreference` redesign** — currently a single global push that sets both provider and root; needs to become per-root provider resolution without breaking implementation.html / TaskViewerProvider consumers of the same config.
- **Stitch output-dir threading** — several call paths reach `_getStitchOutputDir`; miss one and designs write to the wrong repo.
- **Restore ordering** — webview must receive `workspaceItems` + restored state before tabs first render; init handshake ordering matters.

## Edge-Case & Dependency Audit
- **Persisted root no longer open in the window:** dropdown items come from live `workspaceFolders`; if the persisted root isn't among them, fall back to default and leave the stale globalState entry alone (harmless, repo may return).
- **Persisted ClickUp list deleted upstream:** restore chain already tolerates missing IDs (`planning.js:3077-3087` clears `_restoringClickUpHierarchy` on miss) — verify each level fails soft.
- **Root with no integration configured selected in tickets dropdown:** show the existing "configure in Setup" empty state, don't error.
- **Race: rapid workspace-dropdown flipping while fetches in flight:** include `workspaceRoot` in every response message; webview drops responses whose root ≠ current tab selection.
- **globalState growth:** bounded (a few small objects per repo) — no cleanup needed (dev-only).
- **NO confirmation dialogs anywhere** (hard project rule).

## Dependencies
- None — self-contained refactoring of existing panel infrastructure. No external session dependencies.

## Adversarial Synthesis
Key risks: half-migrated tickets tab where missed call sites still send `currentWorkspaceRoot` while others send `ticketsWorkspaceRoot`, producing cross-repo data corruption; and init handshake regressing the "don't refetch on every tab visit" guard (`planning.js:349-351`). Mitigations: rename tickets usages in one surgical pass (verify with `grep` that only non-tickets hits remain), preserve `ticketsInitialized`/`ticketsLoadedOnce` semantics, and tag every response with `workspaceRoot` so the webview drops stale mismatches before touching DOM.

## Verification Plan

### Automated Tests (to be run separately)
- **globalState helper unit test:** Mock `vscode.ExtensionContext.globalState`. Verify `getPanelTabState`/`setPanelTabState` correctly serializes and deserializes per-root maps under `switchboard.panelState.<panel>.<tabKey>`.
- **Tickets response-guard test:** Simulate provider message with mismatched `workspaceRoot`; assert webview handler returns early without mutating DOM.
- **Regression test:** `src/test/kanban-linear-project-tab-regression.test.js` must still pass after Phases 1-2.
- **Init-order test:** Verify `workspaceItems` and `restoredTabState` arrive before first `kanbanPlansReady`/`localDocsReady`/`designDocsReady`/`htmlDocsReady`.
- **Stitch path-guard test:** Verify `_getStitchOutputDir` receives the resolved `msg.workspaceRoot`, not a hardcoded active root, for all three stitch handlers.

### Manual Verification
- `npm run compile` after each phase (webviews served from `dist/webview/`).
- Manual multi-root test (switchboard + viaapp open): kanban filtered to repo A while tickets browses repo B's ClickUp; close panel, reopen → tickets lands on the same list without navigation; reload VS Code → same; flip tickets workspace dropdown back and forth → each repo's spot restored; Stitch generates into the selected repo's `.stitch/`, not the first root's.
- Regression: existing kanban/local-docs/html/design filters still work; `src/test/kanban-linear-project-tab-regression.test.js` still passes.

## Recommendation
**Send to Lead Coder** — Complexity 8, multi-provider coordination, new architectural patterns (per-root globalState, request tagging), and breaking-change risk to tickets restore chain.
