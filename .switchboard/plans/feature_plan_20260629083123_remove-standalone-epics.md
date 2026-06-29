# Remove Standalone Epics as a Concept

## Metadata
**Complexity:** 4
**Tags:** frontend, backend, cleanup, refactor, epic, tech-debt

## Goal

Remove "standalone epic documents" entirely. The Epics tab in the Project panel must show **only DB-backed epics** (rows in the kanban `plans` table with `is_epic=1`) — exactly like the Plans tab shows only DB-backed plans. The filesystem-scan path (`fetchEpicDocuments` → `epicDocumentsReady` → `_epicDocumentsCache`) and the `isEpicDocument` flag are deleted. The `.switchboard/epics/*.md` files on disk are **not** touched — they continue to be auto-imported into the DB by `GlobalPlanWatcherService` and then appear as normal epics, identical to how plan files become plan cards.

### Problem Analysis

The Epics tab currently merges two sources (`project.js:1596-1599`):
```javascript
let filtered = [
    ..._kanbanPlansCache.filter(plan => plan.isEpic),   // DB-backed epics
    ..._epicDocumentsCache                               // filesystem scan of .switchboard/epics/
];
```

The second source — **standalone epic documents** — is a direct directory scan (`PlanningPanelProvider.fetchEpicDocuments`, line 3296) that surfaces `.switchboard/epics/*.md` files **whether or not they exist in the kanban DB**, tagging each with a synthetic `planId: "epic-doc:<path>"` and `isEpicDocument: true`.

This is inconsistent with every other plan surface:

1. **Plans are DB-only.** The Plans list renders solely from `_kanbanPlansCache` (`project.js:1174`). When an agent writes `.switchboard/plans/foo.md`, it appears on the board / in the Project panel **only after** `GlobalPlanWatcherService` imports it into the DB. There is no parallel "scan the plans folder and show un-imported files" path.

2. **Epic files already get imported exactly like plan files.** `GlobalPlanWatcherService` watches BOTH `.switchboard/plans` and `.switchboard/epics` via a real-time `createFileSystemWatcher` (debounced, `GlobalPlanWatcherService.ts:370`) PLUS a 10-second periodic safety scan (`_scanIntervalMs = 10000`, line 29; `_scanForNewFiles`, line 191). Any `.md` dropped in `.switchboard/epics/` is inserted and force-flagged `is_epic=1` (lines 592-601). So a standalone epic is **never permanent** — it becomes a DB epic within one debounce/scan cycle.

3. **The only thing the scan adds is showing epic files in the gap between file-creation and DB-import** — the precise inconsistency this plan removes.

4. **Standalone epics are dead-ended.** They render with no actionable buttons (the action set is gated by `isManageable = !plan.isEpicDocument`, `project.js:1644` & `1800`), their subtask accordion just says "No subtasks (standalone epic document)" (`project.js:1763-1765`), and **they never reach any prompt** — every epic prompt path (`buildEpicOrchestrationPrompt`, board step-mode dispatch, planner/orchestrator prompts) resolves the epic via `db.getPlanByPlanId` / `getSubtasksByEpicId`, which a synthetic `epic-doc:<path>` id cannot satisfy.

### Root Cause

Epics were originally conceived as **documents you injected into prompts** — hence a UI that surfaces epic markdown directly from disk, independent of the board. That role was **superseded entirely by the project PRD feature** (PRD content is injected into prompts via `buildPrdReferenceBlock`, reaching all roles through the shared dispatch prefix). Epics evolved into a board-level *grouping* primitive (an epic + its subtasks, orchestrated as one unit). The filesystem-scan display was left stranded — vestigial UI for a workflow that no longer exists. No prompt path consumes standalone epic content anymore; the PRD path does.

## Decision (no open product questions)

- **Delete the standalone-epic concept**, do not gate or hide it behind a flag. The Epics list becomes `_kanbanPlansCache.filter(p => p.isEpic)` — pure DB, matching the Plans list.
- **Do not delete or move any `.switchboard/epics/*.md` files.** Removal is display-only. The watcher imports them; this is data-safe (see Migration).
- **Preserve file-change auto-refresh** by *repurposing* the existing epic-docs FS watcher (`_setupEpicDocsWatcher`) to trigger `fetchKanbanPlans` instead of `fetchEpicDocuments`, rather than deleting it. This keeps "edit an epic file → Epics list updates" working, now sourced from the DB after import. (See Edge-Case audit for the import-timing note.)
- **Simplify, don't preserve, the `isEpicDocument` branches.** With no standalone docs, every epic is manageable: `isManageable` collapses to a plain null-check, the doc-only `actionButtons` branch and the `Doc` column-badge fallback are removed, and the accordion's `isEpicDocument` branch is removed.

### Relationship to the Refine-Epic plan
This supersedes the "apply Refine to standalone epics" decision in `feature_plan_20260628222343_refine-epic-skill-and-card-button.md`. Once standalone epics no longer exist, that plan's Refine button (in `renderEpicMetaBar`) naturally applies to all epics — which are now exclusively DB-backed. The two compose cleanly: this plan's collapse of the `isManageable` gate is consistent with Refine rendering for every (DB-backed) epic. If both proceed, drop the standalone-doc special-casing from the Refine plan.

## Migration / Release Safety

- **No user data is affected.** This change removes a *display path*, not files. Every `.switchboard/epics/*.md` remains on disk and is imported into the DB by `GlobalPlanWatcherService` (which shipped and watches the epics dir unconditionally), then shown as a normal epic. A user who had a standalone epic showing will, after this change, see that same epic once it is imported (sub-second to ≤10 s) — the identical contract as plan files.
- **No DB migration, no file archival, no settings change.** There is no persisted "standalone epic" state to migrate — `isEpicDocument` is computed at scan time and never written anywhere.
- The watcher imports **any** `.md` in the epics dir (topic derived from `# H1`/`description:`/filename), so there is no class of epic file that would become permanently invisible.

## Complexity Audit

### Routine
- Deleting the `fetchEpicDocuments` case handler (`PlanningPanelProvider.ts:3296-3343`).
- Deleting the `epicDocumentsReady` webview handler and `_epicDocumentsCache` declaration + 2 merge sites (`project.js`).
- Deleting the two `fetchEpicDocuments` post-message triggers (`project.js:41`, `867`).
- Collapsing `isManageable` and removing the `isEpicDocument` branches (`project.js:1644`, `1763-1765`, `1800`, doc-only `actionButtons`/`columnBadge` branches).

### Complex / Risky
- **Root coverage parity (the one real risk).** `fetchEpicDocuments` enumerates `_getAllowedRoots()` (workspace folders **plus** mapped parent/child folders, `PlanningPanelProvider.ts:1709`), whereas `fetchKanbanPlans` enumerates `_getWorkspaceRoots()` (open workspace folders only, line 1667). These differ in **mapped-workspace** setups. The DB query should still cover the same logical epics because `GlobalPlanWatcherService` imports from all mapped folders into the shared (parent) kanban DB, and `KanbanDatabase.forWorkspace(childRoot)` resolves to that same shared DB — so an epic file under any allowed root is represented in a DB that `fetchKanbanPlans` reads. **This must be verified in a mapped-workspace test** (Verification step 5) before shipping; it is the only path that could otherwise hide an epic.
- **Refresh-timing on file change.** Repurposing the watcher to `fetchKanbanPlans` introduces a race: the project-panel refresh (400 ms debounce) can fire before `GlobalPlanWatcherService` finishes importing the changed file, so the change lands on the *next* refresh. Mitigation: keep the existing tab-activation/filter refreshes as the reconciling backstop, and bump the watcher debounce modestly (e.g. 400 ms → 1200 ms) so the import usually wins. This is eventual-consistency identical to how plans behave; not a correctness issue.

## Edge-Case & Dependency Audit

| Case | Handling |
| :--- | :--- |
| **Agent writes a new `.switchboard/epics/*.md`** | Imported by `GlobalPlanWatcherService` → appears as a DB epic. Repurposed watcher triggers `fetchKanbanPlans` so the Epics list refreshes. Same contract as a new plan file. |
| **"+ New Epic" button** | Already creates a **DB-backed** epic: `createEpic` handler writes a `plans` row (`isEpic:1`) + file, then calls `fetchKanbanPlans` (`PlanningPanelProvider.ts:3345-3423`). Independent of the scan — unaffected. |
| **Mapped / multi-root workspaces** | The risk above — must confirm the shared-DB resolution surfaces every allowed-root epic via `fetchKanbanPlans`. Verification step 5. |
| **Orphan epic file (DB row deleted, file remains)** | The watcher re-imports it (re-deriving plan_id from the trailing UUID in the filename), so it reappears as a DB epic rather than a standalone doc. Consistent with plans. |
| **Epic file in a workspace whose board was never opened** | The watcher runs for all mapped folders, and `fetchKanbanPlans` queries all workspace-root DBs — so the epic still imports and shows. (Pre-change, the scan showed it slightly sooner; post-change it shows on import, like plans.) |
| **`tryResolvePendingEpicSelection` pool** | `project.js:1363` merges `_epicDocumentsCache`; simplify to `_kanbanPlansCache.filter(p => p.isEpic)`. Pending selections now resolve only against DB epics — correct, since a selectable epic must be DB-backed to have actions. |
| **Empty epics dir / no epics** | Empty-state message unchanged ("No epics found. Use '+ New Epic' to create one."). |
| **Other panel (`planning.js`)** | Has its own `kanbanPlansReady` handler but no `_epicDocumentsCache` / `isEpicDocument` usage (grep-confirmed). Untouched. |

### Dependency map (full surface — grep-confirmed)
- `isEpicDocument`: `project.js:1644, 1763, 1800`; `PlanningPanelProvider.ts:3331` (only construction site). No persisted/DB usage.
- `_epicDocumentsCache`: `project.js:170, 516, 1363, 1598`.
- `fetchEpicDocuments` / `epicDocumentsReady`: `project.js:41, 515, 867`; `PlanningPanelProvider.ts:922, 3296, 3338, 3341`.
- `_setupEpicDocsWatcher` / `_epicDocsWatchDebounce`: `PlanningPanelProvider.ts:88, 522, 539, 642, 658, 895-926`.

## Proposed Changes

### 1. `src/services/PlanningPanelProvider.ts`

**1a. Delete the `fetchEpicDocuments` case handler** (lines 3296-3343) in its entirety — the directory scan, title extraction, and `epicDocumentsReady` post.

**1b. Repurpose the epic-docs watcher** (`_setupEpicDocsWatcher`, lines 895-926). Keep the `createFileSystemWatcher` on `.switchboard/epics/**/*.md` (so file changes still refresh the Epics list), but change the debounced action from `fetchEpicDocuments` to `fetchKanbanPlans`, and lengthen the debounce so the DB import usually completes first:

```typescript
// before (line ~919-925):
this._epicDocsWatchDebounce = setTimeout(() => {
    this._epicDocsWatchDebounce = undefined;
    if (!this._projectPanel) { return; }
    this._handleMessage({ type: 'fetchEpicDocuments' }, true).catch(err => {
        console.error('[PlanningPanel] Error auto-refreshing epic documents:', err);
    });
}, 400);

// after:
this._epicDocsWatchDebounce = setTimeout(() => {
    this._epicDocsWatchDebounce = undefined;
    if (!this._projectPanel) { return; }
    // Epic files are imported into the kanban DB by GlobalPlanWatcherService; refresh the
    // DB-backed plans so the Epics list (DB-only) reflects the change. Longer debounce gives
    // the import time to land before we re-read.
    this._handleMessage({ type: 'fetchKanbanPlans', requestId: Date.now() }, true).catch(err => {
        console.error('[PlanningPanel] Error auto-refreshing epics after file change:', err);
    });
}, 1200);
```

(If preferred, the watcher could be deleted entirely for strict parity with the Plans tab, which has no such watcher — but repurposing avoids a refresh-on-edit regression for epics. Recommended: repurpose.)

### 2. `src/webview/project.js`

**2a. Remove the two scan triggers** (lines 41 and 867): delete `vscode.postMessage({ type: 'fetchEpicDocuments' });`. Where line 867 sits inside a refresh block that already (or should) post `fetchKanbanPlans`, ensure a `fetchKanbanPlans` remains so the Epics tab still refreshes there.

**2b. Remove the cache and its handler:**
- Delete `let _epicDocumentsCache = [];` (line 170).
- Delete the `case 'epicDocumentsReady':` handler (lines 515-519). (The `renderEpicsList()` + `tryResolvePendingEpicSelection()` it called are already invoked by the `kanbanPlansReady` handler at lines 407 & 414 — no refresh is lost.)

**2c. Simplify the two merge sites to DB-only:**
```javascript
// line 1363 (tryResolvePendingEpicSelection):
const pool = _kanbanPlansCache.filter(p => p.isEpic);

// lines 1596-1599 (renderEpicsList):
let filtered = _kanbanPlansCache.filter(plan => plan.isEpic);
```

**2d. Collapse `isEpicDocument` branches in `renderEpicsList` (card rendering):**
- Line 1644: `const isManageable = plan && !plan.isEpicDocument;` → `const isManageable = !!plan;` (every epic is now DB-backed/manageable). Since `isManageable` is now always true for a rendered epic, the conditional around `actionButtons` collapses to the manageable branch; **delete the doc-only `else` branch** (lines 1652-1656) that rendered just the column badge.
- Line 1642: remove the `Doc` column-badge fallback (`<span class="kanban-column-badge" style="opacity:0.6;">Doc</span>`); DB epics always carry a `column`.
- Lines 1763-1765: remove the `if (plan.isEpicDocument) { ... 'No subtasks (standalone epic document).' }` branch in the accordion `toggle` handler — always take the `getEpicDetails` path.

**2e. Collapse `isManageable` in `renderEpicMetaBar` (line 1800):** `const isManageable = plan && !plan.isEpicDocument;` → `const isManageable = !!plan;`. (Orchestrate / + Subtask / Delete now show for every selected epic — all DB-backed.)

> Note: if the Refine-Epic plan lands first, its `renderEpicMetaBar` edit already touches this block — reconcile so `isManageable` is the plain null-check and Refine renders unconditionally.

## Verification Plan

1. **Build sanity:** `npm run compile` succeeds; no remaining references to `_epicDocumentsCache`, `epicDocumentsReady`, `fetchEpicDocuments`, or `isEpicDocument` (grep both `src/webview/project.js` and `src/services/PlanningPanelProvider.ts` → zero hits). *(`dist/` not used in dev/testing.)*
2. **DB epics still list:** Open Project panel → Epics tab. All epics that exist on the board appear, with full actions (Orchestrate / + Subtask / Delete / Edit). No `Doc`-badged entries.
3. **New epic via "+ New Epic":** Create one; it appears immediately (DB-backed via `createEpic` → `fetchKanbanPlans`).
4. **Agent-created epic file:** Write a new `.switchboard/epics/x.md` on disk. Confirm it does NOT appear instantly as a `Doc`, and DOES appear as a normal epic within one watcher cycle (≤10 s, usually sub-second), and that the repurposed watcher refreshes the list without a manual tab switch.
5. **Mapped-workspace coverage (critical):** In a mapped parent/child workspace, place an epic file under a mapped root that is *not* the primary open folder. Confirm it still appears in the Epics tab via the DB path (proves `fetchKanbanPlans`'s `_getWorkspaceRoots()`/shared-DB resolution covers what `_getAllowedRoots()` scanned). If it does not appear, the watcher repurpose is insufficient and `fetchKanbanPlans` root enumeration must be widened — do not ship until this passes.
6. **No orphaned UI:** Subtask accordions load via `getEpicDetails` for every epic; no "standalone epic document" text remains anywhere.
7. **Regression sweep:** Orchestrate, + Subtask, Delete Epic, Edit/Save/Cancel, column badge/dropdown, Copy Link, Copy Planning Prompt, Send to Planner all still work for DB epics.
8. **Files untouched:** Confirm no `.switchboard/epics/*.md` file is moved, renamed, or deleted by any code path in this change.
