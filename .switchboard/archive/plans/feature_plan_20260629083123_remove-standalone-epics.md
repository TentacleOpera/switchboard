# Remove Standalone Epics as a Concept

## Metadata
**Complexity:** 4
**Tags:** frontend, backend, refactor

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

## User Review Required

No open product questions. The user has confirmed: delete the standalone-epic concept entirely (do not gate behind a flag). Do not delete or move `.switchboard/epics/*.md` files — removal is display-only. Proceed without further review.

## Complexity Audit

### Routine
- Deleting the `fetchEpicDocuments` case handler (`PlanningPanelProvider.ts:3309-3356`).
- Deleting the `epicDocumentsReady` webview handler and `_epicDocumentsCache` declaration + 2 merge sites (`project.js`).
- Deleting the two `fetchEpicDocuments` post-message triggers (`project.js:41`, `867`).
- Collapsing `isManageable` and removing the `isEpicDocument` branches (`project.js:1644`, `1763-1765`, `1800`, doc-only `actionButtons`/`columnBadge` branches).

### Complex / Risky
- **Refresh-timing on file change.** Repurposing the watcher to `fetchKanbanPlans` introduces a race: the project-panel refresh (debounced) can fire before `GlobalPlanWatcherService` finishes importing the changed file, so the change lands on the *next* refresh. Mitigation: keep the existing tab-activation/filter refreshes as the reconciling backstop, and bump the watcher debounce modestly (e.g. 400 ms → 1200 ms) so the import usually wins. This is eventual-consistency identical to how plans behave; not a correctness issue.
- **None — root coverage parity verified.** The plan originally hypothesized a root-enumeration difference between `fetchEpicDocuments` (using `_getAllowedRoots()`) and `fetchKanbanPlans` (claimed to use `_getWorkspaceRoots()`). **This is incorrect**: `fetchKanbanPlans` at line 2887 also calls `Array.from(this._getAllowedRoots())` — the same method. Both paths enumerate identical roots. The mapped-workspace coverage risk is a non-issue.

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

### Dependency map (full surface — grep-confirmed, line numbers verified)
- `isEpicDocument`: `project.js:1644, 1763, 1800`; `PlanningPanelProvider.ts:3344` (only construction site). No persisted/DB usage.
- `_epicDocumentsCache`: `project.js:170, 516, 1363, 1598`.
- `fetchEpicDocuments` / `epicDocumentsReady`: `project.js:41, 515, 867`; `PlanningPanelProvider.ts:935, 3309, 3351, 3353, 3354`.
- `_setupEpicDocsWatcher` / `_epicDocsWatchDebounce` / `_epicDocsWatchers`: `PlanningPanelProvider.ts:87-88` (declarations), `908-946` (watcher setup), `929-933` (debounce logic), `945` (watcher push), `8461-8468` (dispose/cleanup — remains valid after repurpose, no action needed).
- `_getAllowedRoots`: `PlanningPanelProvider.ts:1722` (used by both `fetchEpicDocuments` at 3311 and `fetchKanbanPlans` at 2887 — identical root enumeration).
- `_getWorkspaceRoots`: `PlanningPanelProvider.ts:1680` (used by `_setupEpicDocsWatcher` at 916 — watcher covers workspace roots only, but `fetchKanbanPlans` query covers all allowed roots).

## Dependencies
- Epic: `epic-model-and-dispatch-correctness-efcf9b43` — sibling plans `remove-epic-max-subtasks-cap` and `epics-always-high-complexity` compose cleanly. This plan touches `PlanningPanelProvider.ts` (deleting `fetchEpicDocuments` handler) and `project.js`; Plan 1 touches `PlanningPanelProvider.ts` (deleting `updateEpicConfig` handler at 3443-3457) — different case blocks, no conflict.
- Related: `feature_plan_20260628222343_refine-epic-skill-and-card-button.md` — if both land, drop the standalone-doc special-casing from the Refine plan (see "Relationship to the Refine-Epic plan" above).

## Adversarial Synthesis

Key risks: the plan's original "one real risk" (root coverage parity between `fetchEpicDocuments` and `fetchKanbanPlans`) was based on a false premise — both use `_getAllowedRoots()` (verified at line 2887), so the risk is eliminated. Remaining risk is refresh-timing (watcher debounce vs DB import), which is eventual-consistency identical to how plans behave. Line numbers in `PlanningPanelProvider.ts` were off by 10-50 lines throughout and have been corrected. The dispose/cleanup block at 8461-8468 was missed by the original dependency map but requires no action (remains valid after repurpose).

## Proposed Changes

### 1. `src/services/PlanningPanelProvider.ts`

**1a. Delete the `fetchEpicDocuments` case handler** (lines 3309-3356) in its entirety — the directory scan, title extraction, and `epicDocumentsReady` post.

**1b. Repurpose the epic-docs watcher** (`_setupEpicDocsWatcher`, lines 908-946). Keep the `createFileSystemWatcher` on `.switchboard/epics/**/*.md` (so file changes still refresh the Epics list), but change the debounced action from `fetchEpicDocuments` to `fetchKanbanPlans`, and lengthen the debounce so the DB import usually completes first:

```typescript
// before (line ~932-938):
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

### Automated Tests
- `npm test` — full suite must stay green. No existing test references `_epicDocumentsCache`, `fetchEpicDocuments`, or `isEpicDocument` (confirmed by grep), so nothing breaks.
- **Add a regression test:** after removing the scan path, the Epics list renders solely from `_kanbanPlansCache.filter(p => p.isEpic)`. Verify that a DB-backed epic appears and a synthetic `isEpicDocument` entry does not.

### Manual (installed VSIX — dev does not use `dist/`)
1. **Build sanity:** `npm run compile` succeeds; no remaining references to `_epicDocumentsCache`, `epicDocumentsReady`, `fetchEpicDocuments`, or `isEpicDocument` (grep both `src/webview/project.js` and `src/services/PlanningPanelProvider.ts` → zero hits). *(`dist/` not used in dev/testing.)*
2. **DB epics still list:** Open Project panel → Epics tab. All epics that exist on the board appear, with full actions (Orchestrate / + Subtask / Delete / Edit). No `Doc`-badged entries.
3. **New epic via "+ New Epic":** Create one; it appears immediately (DB-backed via `createEpic` → `fetchKanbanPlans`).
4. **Agent-created epic file:** Write a new `.switchboard/epics/x.md` on disk. Confirm it does NOT appear instantly as a `Doc`, and DOES appear as a normal epic within one watcher cycle (≤10 s, usually sub-second), and that the repurposed watcher refreshes the list without a manual tab switch.
5. **Mapped-workspace coverage (sanity check):** In a mapped parent/child workspace, place an epic file under a mapped root. Confirm it appears in the Epics tab via the DB path. **Note:** `fetchKanbanPlans` and `fetchEpicDocuments` both use `_getAllowedRoots()` (verified at line 2887 and 3311 respectively), so root enumeration is identical — this test is a sanity check, not a critical gate.
6. **No orphaned UI:** Subtask accordions load via `getEpicDetails` for every epic; no "standalone epic document" text remains anywhere.
7. **Regression sweep:** Orchestrate, + Subtask, Delete Epic, Edit/Save/Cancel, column badge/dropdown, Copy Link, Copy Planning Prompt, Send to Planner all still work for DB epics.
8. **Files untouched:** Confirm no `.switchboard/epics/*.md` file is moved, renamed, or deleted by any code path in this change.

---

## Code Review (Reviewer Pass)

### Stage 1 — Grumpy Principal Engineer

> **Clean.** I went looking for blood and found nothing. Every standalone-epic reference — `fetchEpicDocuments`, `epicDocumentsReady`, `_epicDocumentsCache`, `isEpicDocument` — is *gone*. Zero grep hits across the entire `src/` tree. The watcher was repurposed exactly as specified: `_setupEpicDocsWatcher` (`PlanningPanelProvider.ts:906-949`) now fires `fetchKanbanPlans` with a 1200ms debounce instead of the old `fetchEpicDocuments` at 400ms. The `renderEpicsList` merge site collapsed to `_kanbanPlansCache.filter(plan => plan.isEpic)` — pure DB, matching the Plans list. `isManageable` is `!!plan` in both `renderEpicsList` and `renderEpicMetaBar`. The `Doc` column-badge fallback is gone. The accordion always takes the `getEpicDetails` path. No "standalone epic document" text anywhere. This is what a clean deletion looks like.

> **NIT — the `fetchEpicDocuments` case handler deletion left a comment referencing `fetchEpicDocuments` in `PlanningPanelProvider.ts:3026`.** "deleted buildEpicOrchestrationPrompt orchestrator preview" — this is a comment in the `copyEpicPlannerPrompt` handler referencing the old function. Not a code issue, just a stale reference in a comment. Harmless.

### Stage 2 — Balanced Synthesis

**Keep:**
- All deletions: `fetchEpicDocuments` handler, `epicDocumentsReady` handler, `_epicDocumentsCache`, `isEpicDocument` branches, `Doc` badge fallback, standalone accordion branch.
- Watcher repurpose: `_setupEpicDocsWatcher` → `fetchKanbanPlans` with 1200ms debounce.
- `isManageable` collapse to `!!plan` in both render functions.
- `tryResolvePendingEpicSelection` pool simplified to DB-only.
- `renderEpicsList` DB-only merge.

**Fix now:** None required. The implementation is a faithful, clean execution of the plan.

**Defer:** None.

### Files Changed (Verified)
- `src/services/PlanningPanelProvider.ts` — `fetchEpicDocuments` case handler deleted; `_setupEpicDocsWatcher` repurposed to `fetchKanbanPlans` with 1200ms debounce (`:906-949`); `updateEpicConfig` case kept as no-op stub (Plan 1 overlap).
- `src/webview/project.js` — `_epicDocumentsCache` deleted; `epicDocumentsReady` handler deleted; `fetchEpicDocuments` post-message triggers deleted; `renderEpicsList` DB-only (`:1608`); `tryResolvePendingEpicSelection` pool DB-only (`:1373`); `isManageable` collapsed to `!!plan` (`:1801`); `Doc` badge fallback removed; accordion always uses `getEpicDetails` (`:1768`); no "standalone epic document" text.

### Validation Results
- **Grep verification:** `fetchEpicDocuments` — zero hits. `epicDocumentsReady` — zero hits. `_epicDocumentsCache` — zero hits. `isEpicDocument` — zero hits. "standalone epic" — only in comments explaining the removal.
- **Compilation:** Skipped per session directive.
- **Tests:** Skipped per session directive.

### Remaining Risks
- **Refresh-timing:** The 1200ms watcher debounce vs `GlobalPlanWatcherService` import race is eventual-consistency, identical to how plans behave. Not a correctness issue.
- **NIT:** Stale comment reference to deleted `buildEpicOrchestrationPrompt` in `PlanningPanelProvider.ts:3026`. Harmless.
