# Fix Broken Project List in Docs Tab — "Save as PRD" Never Sees Real Projects

## Goal

The Docs tab's **Save as PRD** button (`btn-set-prd` in `planning.html`) is always clickable, with no `disabled` state reflecting whether the active workspace actually has projects — unlike `btn-edit`/`btn-save`/`btn-cancel`/`btn-sync-to-online` in the same controls strip, which all toggle `.disabled` based on context. Naively "fixing" that by disabling the button whenever its current project-list lookup is empty would be wrong: tracing the data feed shows that lookup is **permanently empty in the Docs tab, regardless of whether the workspace truly has projects**. This plan fixes the underlying data wiring first, then adds the disabled-state affordance on top of correct data.

### Problem Analysis & Root Cause

The `btnSetPrd` click handler (`planning.js:6855-6909+`) reads `_kanbanAllWorkspaceProjects[activeWorkspace]` (`planning.js:6868`) to decide whether to show "No projects found in this workspace. Create one in the Projects tab first." or open the project-picker modal. Tracing where that variable gets its data:

1. `_kanbanAllWorkspaceProjects` (declared `let _kanbanAllWorkspaceProjects = {};` at `planning.js:5670`) is written in exactly one place: `handleKanbanPlansReady` (`planning.js:6430`), invoked by the `'kanbanPlansReady'` message handler (`planning.js:3940-3942`).
2. `'kanbanPlansReady'` is only ever sent in response to a `{ type: 'fetchKanbanPlans' }` request. In `planning.js`, that request is sent from `switchToTab('kanban')` (`planning.js:1351-1353`) and a few kanban-action refresh callbacks (`planning.js:3959, 3965, 4023`) — all scoped to a "Kanban" tab/list-pane that **does not exist in `planning.html`'s actual UI**. `planning.html`'s tab bar only has `docs` / `html` / `tickets` / `research` / `notebook` (confirmed via grep — no `data-tab="kanban"` button, no `#kanban-content` div anywhere in the file). The real Kanban board lives in the separate Project panel (`project.html`, loaded by `project.js`, with its own `KANBAN PLANS` tab and `#kanban-content` div). So the `fetchKanbanPlans` send at `planning.js:1352` is **unreachable from the Docs tab**: it is gated behind `if (tabName === 'kanban')`, and no UI element in `planning.html` ever calls `switchToTab('kanban')`. The refresh callbacks at 3959/3965/4023 likewise only fire if the provider posts their triggering messages to the Planning panel — which it does not (see point 3). Net: in ordinary Docs-tab usage, `fetchKanbanPlans` is **never sent from the Planning panel's webview**.
3. Even if it were sent, `PlanningPanelProvider.ts`'s handler for `case 'fetchKanbanPlans'` (lines 3062-3131) hardcodes its response to `this._projectPanel?.webview.postMessage(...)` (success path: line 3117; error path: line 3128) — i.e. it always replies to the **Project panel's** webview, never to `this._panel` (the Planning panel hosting `planning.html`/Docs tab), regardless of which panel's webview sent the request.

Point 3 is the same bug class a prior review already fixed for this button's *other* dependencies. `PlanningPanelProvider.ts:1080-1083` defines `_postToBothPanels()` specifically because "The Docs-tab 'Set as Requirements / Set as Constitution' actions run in the planning panel (`this._panel`) but reuse handlers that were originally wired to the project panel... Replying to only one panel left the planning-panel listeners dead." That helper is already used for every other message this button depends on — `getProjectPrd`→`projectPrdContent`, `readConstitutionFile`→`constitutionFileRead`, `saveProjectPrd`→`projectPrdSaved`, `saveConstitutionFile`→`fileSaved`, `getProjectContextEnabled`→`projectContextEnabled` (all via `_postToBothPanels`). **`fetchKanbanPlans` / `kanbanPlansReady` was missed.**

Net effect: `_kanbanAllWorkspaceProjects` in the Docs tab's `planning.js` instance is permanently `{}`. `projects.length === 0` (`planning.js:6869`) is always true, independent of ground truth.

**Verified against this repo's own data:** this workspace's `.switchboard/kanban.db` `projects` table is currently empty, so the "No projects found" message the button shows today happens to be factually correct *right now* — but the wiring bug means it would show the exact same false "No projects found" after adding real projects too, because nothing correctly repopulates the Docs tab's copy of the list. Disabling the button purely off the current (broken) variable would make it permanently disabled in every workspace, hiding a broken feature instead of fixing it.

The fix has three parts, in dependency order:
1. **Provider routing fix** — `case 'fetchKanbanPlans'` must use `_postToBothPanels` like its siblings, so the Planning panel's webview actually receives `kanbanPlansReady`.
2. **Missing fetch trigger** — the Docs tab must proactively send `fetchKanbanPlans` itself; the existing send at `planning.js:1352` is scoped to a `kanban` tab that `planning.html` never renders, so it is unreachable from the Docs tab.
3. **UX** — once real data is flowing, disable `btn-set-prd` (with an explanatory title) when the active workspace's project list is empty, mirroring the existing `btn-edit`-style disabled-toggle pattern (`planning.js:3040-3053`).

`btn-set-constitution` is unaffected by any of this — it doesn't depend on a project list (constitution is per-workspace, no picker) — so no disabled-state change is proposed for it here.

## Metadata

- **Tags:** `bugfix`, `ui`, `frontend`
- **Complexity:** 4/10
- **Files touched:** `src/services/PlanningPanelProvider.ts`, `src/webview/planning.js`, `src/webview/planning.html` (3 files)
- **Shipped-state impact:** Pure bug fix to existing message routing and button state — no message-type changes, no DB schema changes, no stored-state format changes. Nothing to migrate.
- **Cross-plan note:** `feature_plan_20260701084412_fix-prd-constitution-button-styling.md` (styling/wording fix) also edits `planning.html` line 3461 (the same `<button id="btn-set-prd">` tag). Whichever plan lands second should rebase its markup change onto the other's.

## User Review Required

- Confirm the disabled-by-default markup choice is acceptable: in a workspace **with** projects, `btn-set-prd` will briefly render disabled on each Docs-tab activation until the local-sqlite `fetchKanbanPlans` round-trip resolves (near-instant, but a momentary disabled flash is unavoidable). The alternative (enabled-by-default) reintroduces the false-affordance flash in empty workspaces. Reviewer should pick which flash is preferable; this plan defaults to disabled-by-default to match `btn-edit`/`btn-sync-to-online`.
- Confirm the `getActiveDocsWorkspace()` helper is scoped to the PRD path only (line 6861). The same inline expression also appears at `planning.js:4381` and `:6976` (the `btnSetConstitution` handler); this plan deliberately does **not** refactor those two, to avoid scope creep — constitution does not consume the project list. If the reviewer prefers a repo-wide factor-out, flag it as a separate cleanup task.

## Complexity Audit

### Routine
- Provider routing fix: one-line-per-callsite change applying an already-proven pattern (`_postToBothPanels`, defined `PlanningPanelProvider.ts:1080-1083`, already used for 5+ sibling message pairs) to a case that was simply missed. Success path `:3117`, error path `:3128`.
- Fetch trigger: mirrors the existing `html`-tab pattern of unconditionally re-sending its data request on every tab activation (`planning.js:1357-1360`). Adds one `vscode.postMessage` line to the `docs` branch of `switchToTab` (`planning.js:1354-1356`). No new caching/dedup logic — `fetchKanbanPlans` only queries local `kanban.db` per allowed root (no network calls; confirmed: loops `_getAllowedRoots()`, uses `KanbanDatabase.forWorkspace` + `db.getProjects`) and is already called repeatedly elsewhere without a "fetch once" guard.
- Disabled-state toggle: mirrors the existing `btn-edit` pattern (`planning.js:3040-3053`, `btnEdit.disabled = !isImported`) of toggling `.disabled` based on context. No new message types, no new architecture.

### Complex / Risky
- None architecturally. The only moderate aspect is ensuring the new `updatePrdButtonState()` is invoked at every point where the project list or active workspace can change (post-fetch and on `docs-workspace-filter` change), so the disabled state never desyncs from ground truth. This is well-scoped and reuses existing listener sites.

## Edge-Case & Dependency Audit

- **`_postToBothPanels` when one panel is closed:** Already null-safe (`this._projectPanel?.webview?.postMessage(msg)` / `this._panel?.webview?.postMessage(msg)`) — posting to a closed/undefined panel is a no-op. Confirmed safe for the common case where only the Planning panel (not the Project panel) is open.
- **Shared `_latestRequestIds` guard key:** `case 'fetchKanbanPlans'` uses a single shared guard key (`'kanban-plans'`, not panel-scoped — confirmed via grep, unlike some other cases that key by `sourceId`). If both panels send `fetchKanbanPlans` near-simultaneously, the slower request's response is dropped by the staleness check (`if (requestId !== this._latestRequestIds.get(guardKey)) break;` at `PlanningPanelProvider.ts:3114` and `:3127`). This is **not a correctness problem** once routing is fixed: the surviving response's payload (`allWorkspaceProjects`, `plans`, `columns`) is a full aggregate over every allowed root regardless of which panel triggered the fetch, and `_postToBothPanels` broadcasts that one response to both panels anyway. Worst case is one redundant DB query being discarded, not stale/wrong data being shown. No change needed here.
- **Why a single fetch-on-Docs-activation is enough:** `fetchKanbanPlans`'s handler loops over `Array.from(this._getAllowedRoots())` — i.e. it fetches projects for *every* allowed workspace root in one shot, not just the currently-selected one. So a single fetch when the Docs tab becomes active already covers every workspace the project-picker could need later in the session; no need to also re-fetch on every `docs-workspace-filter` change.
- **"All Workspaces" aggregate filter:** The click handler resolves the active workspace as `state.docsWorkspaceRootFilter || window._workspaceItems[0]?.workspaceRoot || ''` (falls back to the first workspace when the aggregate "All Workspaces" option is selected). This plan factors that exact expression into a shared `getActiveDocsWorkspace()` helper (used by the PRD click handler at `planning.js:6861` and the new disabled-state updater) so both stay in sync, but does **not** change the fallback behavior itself — a pre-existing minor gap (no explicit handling of the aggregate view) noted in a past review is left as-is; out of scope here.
- **Default markup state — both directions of the flash:** `btn-set-prd` currently has no `disabled` attribute in markup (`planning.html:3461`), so before the first `fetchKanbanPlans` round-trip resolves it reads as enabled — a flash of false affordance in empty workspaces. Shipping it `disabled` by default (like `btn-edit`/`btn-sync-to-online` already do) and letting the post-fetch update enable it avoids that. Trade-off: in a workspace **with** projects, the button briefly renders disabled on each Docs-tab activation until the local-sqlite round-trip resolves. That round trip is local-sqlite-backed (no network), so it resolves near-instantly; the momentary disabled flash is the lesser evil versus a false-enabled flash in empty workspaces. See **User Review Required**.
- **No JS/CSS conflict with the sibling styling plan:** That plan only changes `class`/`style`/`title`/visible text on the same `<button>` tag; this plan adds a `disabled` attribute and dynamic `.disabled` toggling via `id`-based lookups. The changes are compatible but touch the same source line (`planning.html:3461`) — see the cross-plan note in Metadata.

## Dependencies

- None. This is a self-contained bug fix with no prerequisite plans or sessions.

## Adversarial Synthesis

Key risks: (1) stale line-number citations throughout the original plan would mislead the implementer — corrected here against current source; (2) the `getActiveDocsWorkspace()` helper must be scoped to the PRD path only to avoid drift with two other untouched call sites (`planning.js:4381`, `:6976`); (3) verification wording must distinguish the separate Project panel's Kanban tab from the Planning panel, which has no Kanban tab. Mitigations: all line numbers re-verified against source; helper deliberately narrowed; verification step 5 rewritten to name the Project panel explicitly. Complexity remains 4 — routine provider + trigger changes with one moderate, well-scoped UX toggle extending an existing pattern.

## Proposed Changes

### 1. Provider routing fix — `src/services/PlanningPanelProvider.ts` (`case 'fetchKanbanPlans'`, success path line 3117 and error path line 3128)

```ts
// Before (success path, line 3117):
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
// Before (error path, line 3128):
this._projectPanel?.webview.postMessage({ type: 'kanbanPlansReady', plans: [], columns: [], requestId, error: String(err) });

// After:
this._postToBothPanels({ type: 'kanbanPlansReady', plans: [], columns: [], requestId, error: String(err) });
```

### 2. Fetch trigger on Docs-tab activation — `src/webview/planning.js` (`switchToTab`, lines 1354-1356)

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

Add a small shared helper near the `btnSetPrd`/`btnSetConstitution` wiring (~line 6839, right after the `const btnSetPrd = ...` / `const btnSetConstitution = ...` declarations) and use it in the PRD click handler (replacing the inline `state.docsWorkspaceRootFilter || (window._workspaceItems && window._workspaceItems[0]?.workspaceRoot) || ''` expression at line 6861). **Scope note:** do NOT refactor the same expression at `planning.js:4381` or `:6976` — those are out of scope (see User Review Required).

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
- Right after `_kanbanAllWorkspaceProjects = msg.allWorkspaceProjects || {};` in `handleKanbanPlansReady` (`planning.js:6430`).
- At the end of the `docs-workspace-filter` `change` listener (`planning.js:1172-1177`), since switching workspaces changes which project list applies.

### 4. Default-disabled markup — `src/webview/planning.html` (line 3461)

Add `disabled` to `btn-set-prd`'s markup so it starts disabled until the first successful fetch enables it (consistent with `btn-edit`/`btn-sync-to-online`):

```html
<button id="btn-set-prd" class="strip-btn" style="background: var(--accent-teal-dim); border-color: var(--accent-teal);" disabled title="Set the open document as Project Requirements (PRD)">Set as Requirements (PRD)</button>
```

(Exact class/style/title attributes depend on which option the sibling styling plan lands with — just add `disabled` to whatever that plan produces.)

## Verification Plan

### Automated Tests

No automated tests are run as part of this plan (per session directive — the test suite is run separately by the user). The verification below is manual, via the installed VSIX.

### Manual Verification

1. Confirm today's baseline: in a workspace with zero rows in `kanban.db`'s `projects` table, `btn-set-prd` starts disabled (not just erroring on click).
2. Use the Projects tab to create a project in that workspace. Reactivate the Docs tab (or switch away and back) and confirm `btn-set-prd` becomes enabled, with the tooltip reverting to the normal copy-action description.
3. Click `btn-set-prd` while enabled and confirm the project-picker modal lists the real project name(s) — not an immediate "No projects found" status message.
4. Switch `docs-workspace-filter` to a different workspace with zero projects; confirm `btn-set-prd` immediately becomes disabled again with the explanatory tooltip.
5. Open the **separate Project panel** (`project.html`, which has the real `KANBAN PLANS` tab and `#kanban-content`) alongside the Planning panel's Docs tab; trigger a plan move/delete/copy in the Project panel's Kanban tab and confirm its own list still refreshes correctly (no regression from broadcasting `kanbanPlansReady` to both panels). Note: the Planning panel (`planning.html`) has no Kanban tab — do not look for one there.
6. Confirm `btn-set-constitution` behavior is completely unchanged (no disabled-state logic added there).
7. Restart the extension/reload the panel once; confirm `btn-set-prd` starts disabled in markup and flips to enabled shortly after Docs-tab activation. In a populated workspace, acknowledge the brief disabled flash before enablement; in an empty workspace, confirm it stays disabled with no false-enabled flash.

---

**Recommendation:** Complexity 4 → **Send to Coder**.

## Review Findings

**Reviewer pass:** All four plan requirements verified in source — provider routing fix (`PlanningPanelProvider.ts:3117,3128` using `_postToBothPanels`), Docs-tab fetch trigger (`planning.js:1357`), disabled-state wiring (`planning.js:6845-6857` helpers + calls at `:6433` and `:1177`), and default-disabled markup (`planning.html:3470`). Regression analysis traced all callers/consumers of `_postToBothPanels`, `handleKanbanPlansReady`, and the scoped `kanbanPlansReady` sends at `PlanningPanelProvider.ts:3304/3417/3434/3460` (those use `postMessageToProjectWebview` — Project-panel-only, no conflict). All kanban UI functions called from `handleKanbanPlansReady` (`renderKanbanPlans`, `populateKanbanFilters`, `updateKanbanColumnFilter`) are null-safe for the Planning panel's element-less context. No CRITICAL or MAJOR findings; no code fixes applied. Three NITs noted: (1) `updatePrdButtonState()` at `planning.js:6849` references `const btnSetPrd` at `:6842` but is called from earlier lines `:1177`/`:6433` — safe only because JS message delivery is async (TDZ would throw if a synchronous call were ever added during init); (2) error path in `handleKanbanPlansReady` (`:6404-6414`) returns before `updatePrdButtonState()` — button retains last-known state on fetch error, which is acceptable but undocumented; (3) file-watcher at `PlanningPanelProvider.ts:965-980` sends two redundant `_handleMessage({type:'fetchKanbanPlans'})` calls now that `_postToBothPanels` broadcasts from one — pre-existing inefficiency, not introduced here. Remaining risk: the shared `'kanban-plans'` guard key drops one response when both panels fetch near-simultaneously, but `_postToBothPanels` ensures both panels receive the surviving response — no data loss.
