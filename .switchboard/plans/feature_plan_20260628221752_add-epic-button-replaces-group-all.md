# Replace "Group All Plans Into Epic" Button with "Add Epic" (Blank Epic Creation)

## Goal

### Problem
The CREATED kanban column has a "Group all plans into epic" button (the `groupAllIntoEpic` column-icon action). Its current behavior is confusing and overly coupled: it auto-selects every non-epic, non-assigned card in the column, then opens the epic-create modal pre-populated with those cards as subtasks. The user has no way to create a blank epic from the column header — they are forced into a "group everything" workflow.

The user wants this button relabeled to "Add Epic" and its behavior changed to simply add a **blank epic with no subtasks** into the CREATED column, opening the same epic-create modal (so the user can set title and description). The user can then use the existing per-card "add to epic" buttons to attach subtasks one at a time.

### Background Context
- The button is rendered in the column header area (`epicGroupBtn`, kanban.html lines 4600–4604) with `data-action="groupAllIntoEpic"`.
- The click handler (kanban.html lines 4830–4857) auto-selects all eligible cards, then calls `openEpicCreateModal({ singlePlanPromote: ... })`.
- The modal submit handler (kanban.html lines 9616–9642) reads `selectedCards` and dispatches either `promoteToEpic` (1 card) or `createEpic` (2+ cards).
- The backend `createEpicFromPlanIds` method (KanbanProvider.ts lines 8601–8719) currently **rejects empty subtask lists** (`subtaskPlanIds.length === 0` → error). This guard must be relaxed to allow blank epic creation.
- The epic's kanban column is currently derived from the subtasks' columns. With zero subtasks, the epic must default to `CREATED`.

### Root Cause
There is no "create blank epic" code path. The column button is hardwired to the group-all workflow, and the backend method has a hard guard against zero subtasks. Both must be modified to support the blank-epic creation flow.

## Metadata
- **Tags:** ui, ux, backend, feature
- **Complexity:** 5/10

## User Review Required
- [ ] Confirm whether the `LocalApiServer` API endpoint (`POST /kanban/epic/create`) should now accept empty `planIds` arrays, or whether the API path should retain the zero-subtask guard while only the webview path is relaxed.

## Complexity Audit

### Routine
- Changing the button label and tooltip in the column header template.
- Changing the click handler to clear the selection and open the modal in "blank epic" mode.
- Adding a `blankEpic` branch to `openEpicCreateModal` (early return before the existing selected-plan flow).

### Complex / Risky
- Relaxing `createEpicFromPlanIds` to accept zero subtasks. The method currently derives the epic's `kanbanColumn`, `project`, and `projectId` from subtasks — with zero subtasks, all three must fall back to safe defaults (`CREATED`, `''`, `null`).
- The modal submit handler branches on `subtaskPlanIds.length`: 1 → `promoteToEpic`, else → `createEpic`. A zero-length array falls into the `else` branch and sends `createEpic` with `subtaskPlanIds: []`, which is correct — but only if the backend accepts it.
- **Stale ID silent failure:** If a caller passes `subtaskPlanIds` with invalid/stale IDs, removing the `subtasks.length === 0` guard means the epic is created with zero subtasks instead of returning an error. The user thinks they're grouping plans, but none get linked. A warning should be emitted when `subtaskPlanIds.length > 0 && subtasks.length === 0`.
- **API behavior change:** `createEpicFromPlanIds` is called from `LocalApiServer` via `TaskViewerProvider` (line 955). Relaxing the guard means the `POST /kanban/epic/create` endpoint now accepts empty `planIds` arrays — a behavior change for API consumers.

## Edge-Case & Dependency Audit

1. **Empty CREATED column**: Clicking "Add Epic" with zero cards in the column should still work — it creates a blank epic regardless of column contents.
2. **Backlog view**: In backlog view, the CREATED column slot shows BACKLOG cards. The `groupAllIntoEpic` handler currently resolves `effectiveCol` for this. Since "Add Epic" no longer reads column cards, this complexity is eliminated — the button simply opens the modal with no pre-selection.
3. **Project filter**: If a project filter is active, the blank epic should inherit the filtered project so it appears on the board. The backend must accept a `project` / `projectId` hint from the webview message, or derive it from the active filter. **Clarification:** The current plan does not pass project info from the webview — the blank epic will have `project=''` and `projectId=null`, meaning it won't appear on project-filtered boards. This is a known limitation; the user can manually set the project after creation.
4. **Existing selected cards**: If the user has cards selected when they click "Add Epic", the selection should be cleared so those cards are not silently linked as subtasks.
5. **Modal validation**: The name field is already required (submit handler checks for empty name). Description is optional. No change needed.
6. **`createEpicFromPlanIds` callers**: The method is also called from `LocalApiServer` (agent/API path, via `TaskViewerProvider.ts` line 955). Relaxing the guard to allow zero subtasks must not break the agent path — agents that pass subtasks still work as before.
7. **Epic file generation**: `_regenerateEpicFile` is called after subtask linking. With zero subtasks, it should produce a valid epic file with just the header and goal — no subtask list. This is already the case since the subtask loop simply iterates zero times.
- **Race Conditions:** None — the blank epic flow is synchronous from the user's perspective (modal → submit → backend → board refresh).
- **Security:** None — no new input surfaces.
- **Side Effects:** The `groupAllIntoEpic` action name is removed entirely. Any external code referencing this action name will break. This is webview-internal only, so the risk is minimal.
- **Dependencies:** The `openEpicCreateModal` function is shared by the strip-button promote/group flow and the new blank-epic flow. The `blankEpic` branch must not affect the existing `singlePlanPromote` / multi-card flows.

## Dependencies
- None — standalone feature, though it shares `openEpicCreateModal` and `createEpicFromPlanIds` with existing flows.

## Adversarial Synthesis

Key risks: (1) Removing the `subtasks.length === 0` guard creates a silent-failure path for stale subtask IDs — mitigate by adding a warning when `subtaskPlanIds.length > 0 && subtasks.length === 0`. (2) The `openEpicCreateModal` rewrite must preserve the existing non-blank flow unchanged — the `blankEpic` branch is an early return before the existing logic. (3) The API behavior change (accepting empty `planIds`) is acceptable but should be documented. Mitigations: Add the stale-ID warning, keep the `blankEpic` branch as a clean early-return, and note the API change in the User Review Required section.

## Proposed Changes

### File: `src/webview/kanban.html`

**Change 1: Relabel the column button**

Location: lines 4600–4604

Current:
```javascript
const epicGroupBtn = isCreated
    ? `<button class="column-icon-btn" data-action="groupAllIntoEpic" data-column="${escapeAttr(def.id)}" data-tooltip="Group all plans in this column into an epic">
           <img src="${ICON_CODE_MAP}" alt="Group Into Epic">
       </button>`
    : '';
```

Proposed:
```javascript
const epicAddBtn = isCreated
    ? `<button class="column-icon-btn" data-action="addBlankEpic" data-column="${escapeAttr(def.id)}" data-tooltip="Add a blank epic to this column">
           <img src="${ICON_CODE_MAP}" alt="Add Epic">
       </button>`
    : '';
```

Update the reference in the button area template (line 4630): replace `${epicGroupBtn}` with `${epicAddBtn}`.

**Change 2: Replace the click handler**

Location: lines 4830–4857 (the `case 'groupAllIntoEpic'` block)

Replace the entire case with:
```javascript
case 'addBlankEpic': {
    // Clear any existing selection so no cards are silently linked as subtasks.
    selectedCards.clear();
    document.querySelectorAll('.kanban-card.selected').forEach(el => el.classList.remove('selected'));
    updateReassignButtonVisibility();
    updateEpicActionButton();
    // Open the epic-create modal in blank-epic mode (no pre-selected subtasks).
    openEpicCreateModal({ blankEpic: true });
    break;
}
```

Also update the guard on line 4736 that checks `action !== 'groupAllIntoEpic'` — replace `'groupAllIntoEpic'` with `'addBlankEpic'`.

**Change 3: Update `openEpicCreateModal` to support blank-epic mode**

Location: lines 7462–7494

Add a `blankEpic` early-return branch at the top of the function, BEFORE the existing `selectedIds`/`selectedPlans` computation. The existing non-blank flow (everything after the early return) stays unchanged:

```javascript
function openEpicCreateModal(opts = {}) {
    const modal = document.getElementById('epic-create-modal');
    const planCount = document.getElementById('epic-create-plan-count');
    const planList = document.getElementById('epic-create-plan-list');
    const nameInput = document.getElementById('epic-create-name');
    const titleText = document.getElementById('epic-create-title');
    const descLabel = modal?.querySelector('label[for="epic-create-description"]');
    const descInput = document.getElementById('epic-create-description');
    const submitBtn = document.getElementById('epic-create-submit');
    if (nameInput) nameInput.style.borderColor = '';

    // --- NEW: blank-epic mode (early return, existing flow unchanged below) ---
    const isBlankEpic = opts.blankEpic === true;
    if (isBlankEpic) {
        if (planCount) planCount.style.display = 'none';
        if (planList) planList.style.display = 'none';
        if (nameInput) nameInput.value = '';
        if (titleText) titleText.textContent = 'Add Epic';
        if (descLabel) descLabel.style.display = '';
        if (descInput) descInput.style.display = '';
        if (submitBtn) submitBtn.textContent = 'Add Epic';
        if (modal) modal.classList.remove('hidden');
        return;
    }
    // --- END NEW ---

    // ... existing code for selected-plan flow unchanged ...
    const selectedIds = Array.from(selectedCards.keys());
    const selectedPlans = selectedIds.map(id => currentCards.find(c => (c.planId || c.sessionId) === id)).filter(Boolean);
    if (planCount) { planCount.textContent = `${selectedPlans.length} plan(s) selected`; planCount.style.display = ''; }
    if (planList) { planList.innerHTML = selectedPlans.map(p => `<li>${escapeHtml(p.topic)}</li>`).join(''); planList.style.display = ''; }
    // ... rest unchanged ...
}
```

**Change 4: Update the modal submit handler to handle zero selected cards**

Location: lines 9616–9642

The current logic:
```javascript
const subtaskPlanIds = Array.from(selectedCards.keys());
if (subtaskPlanIds.length === 1) {
    postKanbanMessage({ type: 'promoteToEpic', planId: subtaskPlanIds[0], name, workspaceRoot });
} else {
    postKanbanMessage({ type: 'createEpic', name, description: descInput ? descInput.value.trim() : '', subtaskPlanIds, workspaceRoot });
}
```

This already handles the zero-card case correctly: `subtaskPlanIds` will be `[]`, which falls into the `else` branch and sends `createEpic` with an empty array. No change needed here, **provided** the backend accepts an empty array (see backend change below).

### File: `src/services/KanbanProvider.ts`

**Change 5: Relax `createEpicFromPlanIds` to allow zero subtasks**

Location: lines 8607–8624

Current:
```typescript
const epicName = (name || '').replace(/[\r\n]+/g, ' ').trim();
const subtaskPlanIds = Array.isArray(planIds) ? planIds : [];
if (!epicName || subtaskPlanIds.length === 0) {
    return { success: false, error: 'Epic name and at least one subtask are required.' };
}
const db = this._getKanbanDb(workspaceRoot);
if (!db || !(await db.ensureReady())) {
    return { success: false, error: 'Kanban database not available.' };
}
const subtasks: any[] = [];
for (const pid of subtaskPlanIds) {
    const plan = await db.getPlanByPlanId(pid);
    if (plan) subtasks.push(plan);
}
if (subtasks.length === 0) {
    return { success: false, error: 'No valid subtasks found for epic creation.' };
}
```

Proposed:
```typescript
const epicName = (name || '').replace(/[\r\n]+/g, ' ').trim();
const subtaskPlanIds = Array.isArray(planIds) ? planIds : [];
if (!epicName) {
    return { success: false, error: 'Epic name is required.' };
}
const db = this._getKanbanDb(workspaceRoot);
if (!db || !(await db.ensureReady())) {
    return { success: false, error: 'Kanban database not available.' };
}
const subtasks: any[] = [];
for (const pid of subtaskPlanIds) {
    const plan = await db.getPlanByPlanId(pid);
    if (plan) subtasks.push(plan);
}
// Zero subtasks is now valid — creates a blank epic. The "No valid subtasks"
// guard is removed; callers that pass invalid IDs simply get an epic with
// fewer linked subtasks than requested.
// WARNING: if the caller expected subtasks but none resolved (stale IDs),
// emit a warning so the silent failure is visible.
if (subtaskPlanIds.length > 0 && subtasks.length === 0) {
    console.warn(`[KanbanProvider] createEpicFromPlanIds: ${subtaskPlanIds.length} subtask IDs provided but 0 resolved to valid plans. Creating blank epic anyway.`);
}
```

**Change 6: Default column and project when there are zero subtasks**

Location: lines 8625–8642

Current (derives column/project from subtasks):
```typescript
const epicProject = subtasks.find(st => st.project)?.project || '';
const epicProjectId = subtasks.find(st => st.projectId != null)?.projectId ?? null;
// ... ordinalMap setup ...
const resolvedColumn = subtasks
     .map((st: any) => this._normalizeLegacyKanbanColumn(st.kanbanColumn))
     .filter((col: string | null): col is string => !!col)
     .sort((a: string, b: string) => (ordinalMap.get(a) ?? Infinity) - (ordinalMap.get(b) ?? Infinity))[0] || this._normalizeLegacyKanbanColumn(subtasks[0].kanbanColumn) || 'CREATED';
const effectiveColumn = resolvedColumn === 'BACKLOG' ? 'CREATED' : resolvedColumn;
```

Proposed (add zero-subtask fallback):
```typescript
const epicProject = subtasks.find(st => st.project)?.project || '';
const epicProjectId = subtasks.find(st => st.projectId != null)?.projectId ?? null;
// ... ordinalMap setup ...
let resolvedColumn: string;
if (subtasks.length === 0) {
    // Blank epic: no subtasks to derive from — default to CREATED.
    resolvedColumn = 'CREATED';
} else {
    resolvedColumn = subtasks
         .map((st: any) => this._normalizeLegacyKanbanColumn(st.kanbanColumn))
         .filter((col: string | null): col is string => !!col)
         .sort((a: string, b: string) => (ordinalMap.get(a) ?? Infinity) - (ordinalMap.get(b) ?? Infinity))[0] || this._normalizeLegacyKanbanColumn(subtasks[0].kanbanColumn) || 'CREATED';
}
const effectiveColumn = resolvedColumn === 'BACKLOG' ? 'CREATED' : resolvedColumn;
```

The subtask linking loop (line 8705–8709) already iterates zero times when `subtasks` is empty, so no change is needed there. `_regenerateEpicFile` will produce a valid epic file with no subtask section.

## Verification Plan

### Automated Tests
- No automated tests required (skip per session directive). The test suite will be run separately by the user.

### Manual Verification
1. Open the Switchboard kanban board in VS Code.
2. Locate the CREATED column header — verify the button tooltip reads "Add a blank epic to this column" (not "Group all plans...").
3. Click the "Add Epic" button with no cards selected → verify the modal opens with title "Add Epic", empty name field, visible description field, and no plan-count/plan-list visible.
4. Enter a name and optional description, click "Add Epic" → verify a new epic card appears in the CREATED column with the given name and no subtasks.
5. Select an existing non-epic card and use the per-card "add to epic" button → verify the card is linked as a subtask of the new blank epic.
6. Click "Add Epic" while some cards are selected → verify the selection is cleared and the modal opens in blank-epic mode (selected cards are NOT linked as subtasks).
7. Verify the existing "PROMOTE TO EPIC" / "CREATE EPIC" strip button still works for 1-card and multi-card selection flows (regression check).
8. Test in backlog view: click "Add Epic" on the CREATED column slot → verify a blank epic is created in CREATED (not BACKLOG).

---

**Recommendation:** Complexity 5/10 → Send to Coder.

## Code Review Results (2026-06-29)

### Files Changed
- `src/webview/kanban.html` — column button template (lines 4623–4627): relabeled to `addBlankEpic` action, "Add Epic" alt, "Add a blank epic to this column" tooltip; variable renamed `epicGroupBtn` → `epicAddBtn`; reference updated at line 4653.
- `src/webview/kanban.html` — click handler (lines 4853–4862): replaced `groupAllIntoEpic` case with `addBlankEpic` case that clears selection and opens modal in blank-epic mode; guard at line 4759 updated.
- `src/webview/kanban.html` — `openEpicCreateModal()` (lines 7403–7416): added `blankEpic` early-return branch before existing flow.
- `src/services/KanbanProvider.ts` — `createEpicFromPlanIds()` (lines 8438–8460): removed `subtaskPlanIds.length === 0` guard; added stale-ID warning when `subtaskPlanIds.length > 0 && subtasks.length === 0`.
- `src/services/KanbanProvider.ts` — `createEpicFromPlanIds()` (lines 8474–8484): added zero-subtask fallback for `resolvedColumn = 'CREATED'`.

### Findings
| Severity | Finding | File:Line | Status |
|:---|:---|:---|:---|
| NIT | Stale-ID warning says "Creating blank epic anyway" — slightly misleading for unintentional stale IDs | KanbanProvider.ts:8459 | Deferred — diagnostic-only, behavior correct |
| MAJOR | Blank epic gets `project=''` / `projectId=null` — won't appear on project-filtered boards | KanbanProvider.ts:8465-8466 | **FIXED** — now falls back to active project filter |

### Fixes Applied
**MAJOR fix — blank epic project inheritance.** `createEpicFromPlanIds` now falls back to the board's active project filter (read from the DB `kanban.activeProjectFilter` config key, the same source the file watcher uses) when subtasks don't provide a project. Also resolves `project_id` from the project name via a new `getProjectIdByName` method on `KanbanDatabase`, since `upsertPlan` does not resolve `project_id` from `project` name (unlike `insertFileDerivedPlan`). The `workspaceId` resolution was moved earlier in the function to be available for the project-id lookup.

Files changed:
- `src/services/KanbanDatabase.ts` (lines 2370-2390): added `getProjectIdByName(workspaceId, projectName)` method.
- `src/services/KanbanProvider.ts` (lines 8448-8484): moved `workspaceId` resolution earlier; added active-project-filter fallback and `project_id` resolution for blank epics.

### Validation
- No compilation step run (per session directive).
- No tests run (per session directive).
- Code verification: all 6 changes confirmed against plan requirements. Zero-subtask guard removed. Stale-ID warning present. Column default handles `subtasks.length === 0`. Modal blank-epic mode is clean early return. Click handler clears selection before opening modal.

### Remaining Risks
- API behavior change: `POST /kanban/epic/create` now accepts empty `planIds` arrays. This is intentional per the plan but should be noted in API documentation.
- Blank epic project inheritance depends on `kanban.activeProjectFilter` being persisted in the DB config — if the board has never refreshed (e.g. fresh install with no board open), the config key may be empty and the epic gets `project=''`. This is the same dependency the file watcher has, so it's not a new risk.
