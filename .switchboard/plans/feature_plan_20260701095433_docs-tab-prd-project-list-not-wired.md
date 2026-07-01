# Fix Broken Project List in Docs Tab — "Save as PRD" Never Sees Real Projects

## Goal

The Docs tab's **Save as PRD** button (`btn-set-prd` in `planning.html`) is always clickable, with no `disabled` state reflecting whether the active workspace actually has projects — unlike `btn-edit`/`btn-save`/`btn-cancel`/`btn-sync-to-online` in the same controls strip, which all toggle `.disabled` based on context. Naively "fixing" that by disabling the button whenever its current project-list lookup is empty would be wrong: tracing the data feed shows that lookup is **permanently empty in the Docs tab, regardless of whether the workspace truly has projects**. This plan fixes the underlying data wiring first, then adds the disabled-state affordance on top of correct data.

### Problem Analysis & Root Cause

The `btnSetPrd` click handler (`planning.js:6788-6901`) reads `_kanbanAllWorkspaceProjects[activeWorkspace]` (`planning.js:6801`) to decide whether to show "No projects found in this workspace. Create one in the Projects tab first." or open the project-picker modal. Tracing where that variable gets its data:

1. `_kanbanAllWorkspaceProjects` (declared `let _kanbanAllWorkspaceProjects = {};` at `planning.js:5603`) is written in exactly one place: `handleKanbanPlansReady` (`planning.js:6363`), invoked by the `'kanbanPlansReady'` message handler (`planning.js:3903-3905`).
2. `'kanbanPlansReady'` is only ever sent in response to a `{ type: 'fetchKanbanPlans' }` request. In `planning.js`, that request is sent only from `switchToTab('kanban')` (`planning.js:1320`) and a few kanban-action refresh callbacks (`planning.js:3922, 3928, 3986`) — all scoped to a "Kanban" tab/list-pane that **does not exist in `planning.html`'s actual UI**. `planning.html`'s tab bar only has `docs` / `html` / `tickets` / `research` / `notebook` (confirmed via grep — no `data-tab="kanban"` button, no `#kanban-content` div anywhere in the file). The real Kanban board lives in the separate Project panel (`project.html`, loaded by `project.js`, with its own `KANBAN PLANS` tab and `#kanban-content` div — confirmed at `project.html:1415` and `:1424`). So in ordinary Docs-tab usage, `fetchKanbanPlans` is **never sent at all**.
3. Even if it were sent, `PlanningPanelProvider.ts`'s handler for `case 'fetchKanbanPlans'` (lines 3036-3106) hardcodes its response to `this._projectPanel?.webview.postMessage(...)` (success path: line 3091; error path: line 3102) — i.e. it always replies to the **Project panel's** webview, never to `this._panel` (the Planning panel hosting `planning.html`/Docs tab), regardless of which panel's webview sent the request.

Point 3 is the same bug class a prior review already fixed for this button's *other* dependencies. `PlanningPanelProvider.ts:1070-1081` defines `_postToBothPanels()` specifically because "The Docs-tab 'Set as Requirements / Set as Constitution' actions run in the planning panel (`this._panel`) but reuse handlers that were originally wired to the project panel... Replying to only one panel left the planning-panel listeners dead." That helper is already used for every other message this button depends on — `getProjectPrd`→`projectPrdContent`, `readConstitutionFile`→`constitutionFileRead`, `saveProjectPrd`→`projectPrdSaved`, `saveConstitutionFile`→`fileSaved`, `getProjectContextEnabled`→`projectContextEnabled` (all via `_postToBothPanels`, e.g. `PlanningPanelProvider.ts:3574-3754`). **`fetchKanbanPlans` / `kanbanPlansReady` was missed.**

Net effect: `_kanbanAllWorkspaceProjects` in the Docs tab's `planning.js` instance is permanently `{}`. `projects.length === 0` (`planning.js:6802`) is always true, independent of ground truth.

**Verified against this repo's own data:** this workspace's `.switchboard/kanban.db` `projects` table is currently empty, so the "No projects found" message the button shows today happens to be factually correct *right now* — but the wiring bug means it would show the exact same false "No projects found" after adding real projects too, because nothing correctly repopulates the Docs tab's copy of the list. Disabling the button purely off the current (broken) variable would make it permanently disabled in every workspace, hiding a broken feature instead of fixing it.

The fix has three parts, in dependency order:
1. **Provider routing fix** — `case 'fetchKanbanPlans'` must use `_postToBothPanels` like its siblings, so the Planning panel's webview actually receives `kanbanPlansReady`.
2. **Missing fetch trigger** — the Docs tab must proactively send `fetchKanbanPlans` itself; it currently never does in any reachable code path.
3. **UX** — once real data is flowing, disable `btn-set-prd` (with an explanatory title) when the active workspace's project list is empty, mirroring the existing `btn-edit`-style disabled-toggle pattern.

`btn-set-constitution` is unaffected by any of this — it doesn't depend on a project list (constitution is per-workspace, no picker) — so no disabled-state change is proposed for it here.

## Metadata

- **Tags:** `bug`, `cross-panel-messaging`, `planning-webview`, `docs-tab`, `kanban-projects`
- **Complexity:** 4/10
- **Files touched:** `src/services/PlanningPanelProvider.ts`, `src/webview/planning.js`, `src/webview/planning.html` (3 files)
- **Shipped-state impact:** Pure bug fix to existing message routing and button state — no message-type changes, no DB schema changes, no stored-state format changes. Nothing to migrate.
- **Cross-plan note:** `feature_plan_20260701084412_fix-prd-constitution-button-styling.md` (styling/wording fix) also edits `planning.html` lines 3458-3459 (the same two `<button>` tags). Whichever plan lands second should rebase its markup change onto the other's.

## Complexity Audit

**Routine-to-moderate.** The provider fix (item 1) is a one-line-per-callsite change applying an already-proven pattern (`_postToBothPanels`, already used for 5+ sibling message pairs in this exact file) to a case that was simply missed. The fetch trigger (item 2) mirrors the existing `html`-tab pattern of unconditionally re-sending its data request on every tab activation (`planning.js:1325-1328`) — no new caching/dedup logic needed since `fetchKanbanPlans` only queries the local `kanban.db` per allowed root (no network calls), and is already called repeatedly elsewhere (after every plan delete/move/copy) without a "fetch once" guard. The disabled-state toggle (item 3) mirrors the existing `btn-edit` pattern (`planning.js:3007-3022`) of toggling `.disabled` based on context. No new message types, no new architecture.

## Edge-Case & Dependency Audit

- **`_postToBothPanels` when one panel is closed:** Already null-safe (`this._projectPanel?.webview?.postMessage(msg)` / `this._panel?.webview?.postMessage(msg)`) — posting to a closed/undefined panel is a no-op. Confirmed safe for the common case where only the Planning panel (not the Project panel) is open.
- **Shared `_latestRequestIds` guard key:** `case 'fetchKanbanPlans'` uses a single shared guard key (`'kanban-plans'`, not panel-scoped — confirmed via grep, unlike some other cases that key by `sourceId`). If both panels send `fetchKanbanPlans` near-simultaneously, the slower request's response is dropped by the staleness check (`if (requestId !== this._latestRequestIds.get(guardKey)) break;`). This is **not a correctness problem** once routing is fixed: the surviving response's payload (`allWorkspaceProjects`, `plans`, `columns`) is a full aggregate over every allowed root regardless of which panel triggered the fetch, and `_postToBothPanels` broadcasts that one response to both panels anyway. Worst case is one redundant DB query being discarded, not stale/wrong data being shown. No change needed here.
- **Why a single fetch-on-Docs-activation is enough:** `fetchKanbanPlans`'s handler loops over `Array.from(this._getAllowedRoots())` — i.e. it fetches projects for *every* allowed workspace root in one shot, not just the currently-selected one. So a single fetch when the Docs tab becomes active already covers every workspace the project-picker could need later in the session; no need to also re-fetch on every `docs-workspace-filter` change.
- **"All Workspaces" aggregate filter:** The click handler resolves the active workspace as `state.docsWorkspaceRootFilter || window._workspaceItems[0]?.workspaceRoot || ''` (falls back to the first workspace when the aggregate "All Workspaces" option is selected). This plan factors that exact expression into a shared `getActiveDocsWorkspace()` helper (used by both click handlers and the new disabled-state updater) so all three stay in sync, but does **not** change the fallback behavior itself — a pre-existing minor gap (no explicit handling of the aggregate view) noted in a past review is left as-is; out of scope here.
- **Default markup state:** `btn-set-prd` currently has no `disabled` attribute in markup, so before the first `fetchKanbanPlans` round-trip resolves it would otherwise read as enabled. Shipping it `disabled` by default in markup (like `btn-edit`/`btn-sync-to-online` already do) and letting the post-fetch update enable it avoids a flash of false affordance. The round trip is local-sqlite-backed (no network), so it should resolve near-instantly after Docs-tab activation.
- **No JS/CSS conflict with the sibling styling plan:** That plan only changes `class`/`style`/`title`/visible text on the same two `<button>` tags; this plan adds a `disabled` attribute and dynamic `.disabled` toggling via `id`-based lookups. The changes are compatible but touch the same two source lines — see the cross-plan note in Metadata.

## Proposed Changes

### 1. Provider routing fix — `src/services/PlanningPanelProvider.ts` (`case 'fetchKanbanPlans'`, lines ~3091 and ~3102)

```ts
// Before (success path, line 3091):
this._projectPanel?.webview.postMessage({
    type: 'kanbanPlansReady',
    plans: allPlans,
    workspaceItems,
    allWorkspaceProjects,
    columns: mergedColumns,
    kanbanWorkspaceRoot: this._kanbanProvider?.getCurrentWorkspaceRoot() || null,
    requestId
});

// After:
this._postToBothPanels({
    type: 'kanbanPlansReady',
    plans: allPlans,
    workspaceItems,
    allWorkspaceProjects,
    columns: mergedColumns,
    kanbanWorkspaceRoot: this._kanbanProvider?.getCurrentWorkspaceRoot() || null,
    requestId
});
```

```ts
// Before (error path, line 3102):
this._projectPanel?.webview.postMessage({ type: 'kanbanPlansReady', plans: [], columns: [], requestId, error: String(err) });

// After:
this._postToBothPanels({ type: 'kanbanPlansReady', plans: [], columns: [], requestId, error: String(err) });
```

### 2. Fetch trigger on Docs-tab activation — `src/webview/planning.js` (`switchToTab`, lines ~1322-1324)

```js
// Before:
if (tabName === 'docs') {
    vscode.postMessage({ type: 'getPlanningPanelSyncMode' });
}

// After:
if (tabName === 'docs') {
    vscode.postMessage({ type: 'getPlanningPanelSyncMode' });
    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
}
```

### 3. Disabled-state wiring — `src/webview/planning.js`

Add a small shared helper near the `btnSetPrd`/`btnSetConstitution` wiring (~line 6772) and use it in the two existing click handlers (replacing their inline `state.docsWorkspaceRootFilter || (window._workspaceItems && window._workspaceItems[0]?.workspaceRoot) || ''` expressions at lines 6794 and 6909):

```js
function getActiveDocsWorkspace() {
    return state.docsWorkspaceRootFilter || (window._workspaceItems && window._workspaceItems[0]?.workspaceRoot) || '';
}

function updatePrdButtonState() {
    if (!btnSetPrd) return;
    const activeWorkspace = getActiveDocsWorkspace();
    const projects = _kanbanAllWorkspaceProjects[activeWorkspace] || [];
    btnSetPrd.disabled = projects.length === 0;
    btnSetPrd.title = btnSetPrd.disabled
        ? 'No projects in this workspace yet — create one in the Projects tab first.'
        : "Copy the open document into a project's PRD. You'll choose the project; if it already has a PRD you can keep, append, or replace it.";
}
```

Call `updatePrdButtonState()`:
- Right after `_kanbanAllWorkspaceProjects = msg.allWorkspaceProjects || {};` in `handleKanbanPlansReady` (`planning.js:6363`).
- At the end of the `docs-workspace-filter` `change` listener (`planning.js:1140-1145`), since switching workspaces changes which project list applies.

### 4. Default-disabled markup — `src/webview/planning.html` (line 3458)

Add `disabled` to `btn-set-prd`'s markup so it starts disabled until the first successful fetch enables it (consistent with `btn-edit`/`btn-sync-to-online`):

```html
<button id="btn-set-prd" class="strip-btn ..." disabled ...>...</button>
```

(Exact class/style/title attributes depend on which option the sibling styling plan lands with — just add `disabled` to whatever that plan produces.)

## Verification Plan

1. Confirm today's baseline: in a workspace with zero rows in `kanban.db`'s `projects` table, `btn-set-prd` starts disabled (not just erroring on click).
2. Use the Projects tab to create a project in that workspace. Reactivate the Docs tab (or switch away and back) and confirm `btn-set-prd` becomes enabled, with the tooltip reverting to the normal copy-action description.
3. Click `btn-set-prd` while enabled and confirm the project-picker modal lists the real project name(s) — not an immediate "No projects found" status message.
4. Switch `docs-workspace-filter` to a different workspace with zero projects; confirm `btn-set-prd` immediately becomes disabled again with the explanatory tooltip.
5. Open the Project panel's Kanban tab alongside the Planning panel's Docs tab; trigger a plan move/delete/copy in the Kanban tab and confirm its own list still refreshes correctly (no regression from broadcasting `kanbanPlansReady` to both panels).
6. Confirm `btn-set-constitution` behavior is completely unchanged (no disabled-state logic added there).
7. Restart the extension/reload the panel once; confirm `btn-set-prd` starts disabled in markup and flips to enabled shortly after Docs-tab activation, with no visible "looks clickable but isn't" flash.
