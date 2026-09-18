# Fix: Epic Subtasks Cannot Be Viewed in the Preview Panel (Epics Tab, project.html)

## Goal

In the **Epics tab** of `project.html`, when an epic's subtask accordion is expanded, the listed subtasks are display-only text labels with a "Remove" button. Clicking a subtask does nothing — it cannot be opened/viewed in the right-hand preview panel, even though every subtask is a plan file on disk that the existing preview infrastructure can render.

### Problem Analysis & Root Cause

The subtask list is rendered by `renderEpicSubtasks()` in `src/webview/project.js` (lines 1299–1323):

```js
subtasksDiv.innerHTML = subtasks.map(st => `
    <div class="epic-subtask-item">
        <span>• ${escapeHtml(st.topic)} (${escapeHtml(st.kanbanColumn)})</span>
        <button class="epic-remove-subtask-btn" data-subtask-session="${escapeHtml(st.sessionId || st.planId)}" data-workspace-root="${escapeHtml(epic.workspaceRoot)}">Remove</button>
    </div>
`).join('');
```

**Two root causes prevent preview:**

1. **No click handler on the subtask item.** The `<span>` showing the subtask topic has no `click` listener. Only the "Remove" button is wired up. There is no code path that requests a preview for the clicked subtask.

2. **The `kanbanPlanPreviewReady` handler won't accept the subtask's file.** Even if a click handler sent a `fetchKanbanPlanPreview` message for the subtask's `planFile`, the response handler (lines 309–318) gates on:
   ```js
   if (epicsPreviewContent && _epicSelectedPlan && _epicSelectedPlan.planFile === msg.filePath)
   ```
   `_epicSelectedPlan.planFile` is the **epic's** file, not the subtask's. The subtask's `planFile` will never match, so the rendered HTML is silently discarded.

The subtask records (`KanbanPlanRecord` from `db.getSubtasksByEpicId()`) **do** carry a `planFile` field (confirmed in `KanbanDatabase.ts` line 35), and the backend `getEpicDetails` handler (PlanningPanelProvider.ts line 2745–2746) passes the raw records through to the webview as `msg.subtasks`. So the data needed to fetch a preview is already available client-side — only the wiring is missing.

## Metadata

- **Tags:** `bug`, `ui`, `epics`, `project.html`, `frontend`
- **Complexity:** 4/10

## Complexity Audit

**Routine, but with a small state-management subtlety.** The preview fetch/response mechanism already exists (`fetchKanbanPlanPreview` → `kanbanPlanPreviewReady`). The work is: (a) add a click handler, (b) introduce a lightweight tracking variable so the response handler knows which file is currently being previewed in the Epics tab (epic OR subtask), and (c) update the meta-bar so the Edit/Save buttons operate on the currently-previewed file rather than assuming it's always the epic.

The main risk is the edit-mode flow: if a user clicks a subtask while the epic is in edit mode, the editor textarea would be showing the epic's content but the preview switches to the subtask. This must be handled by exiting edit mode (or disabling subtask clicks while editing), consistent with how clicking a different epic already calls `exitEditMode('epics')`.

## Edge-Case & Dependency Audit

- **Subtask with no `planFile`:** Some subtask records may have an empty `planFile` (e.g. ghost/tombstoned plans that slipped through). The click handler must guard: if `!st.planFile`, show a toast ("This subtask has no plan file") and skip the preview request.
- **Edit mode active:** If the epic is currently being edited (`state.editMode.epics === true`), clicking a subtask must first `exitEditMode('epics')` (discarding or saving per existing behaviour) before switching the preview target — mirroring how clicking a different epic card already calls `exitEditMode('epics')` (line 1224).
- **Preview target tracking:** A new module-level variable (e.g. `_epicPreviewFilePath`) must track the file currently shown in the Epics preview pane. It is set to the epic's `planFile` when an epic is selected (`selectEpic`), and to a subtask's `planFile` when a subtask is clicked. The `kanbanPlanPreviewReady` handler must check this variable instead of `_epicSelectedPlan.planFile`.
- **Meta-bar Edit/Save buttons:** `renderEpicMetaBar` wires Edit/Save to `_epicSelectedPlan.planFile` (line 1283). When a subtask is being previewed, editing should either be disabled or target the subtask's file. Simplest correct approach: when a subtask is previewed, hide the Edit button (subtasks are managed via the Kanban board, not edited from the Epics tab). Re-show it when the epic itself is re-selected.
- **Re-selecting the epic:** When the user clicks the epic card again (not a subtask), `_epicPreviewFilePath` resets to the epic's file and the epic preview loads normally.
- **Accordion toggle interference:** The subtask click handler must call `e.stopPropagation()` so it doesn't bubble into the accordion toggle or the epic-card select handler.
- **Remove button:** Must continue to work independently — its existing `e.stopPropagation()` (line 1315) already prevents preview-triggering side effects, but the new click handler must be attached to the `<span>` (or the item div excluding the button), not the whole row, to avoid conflicts.
- **No backend change required:** The backend already returns full `KanbanPlanRecord` objects (with `planFile`) as subtasks and already handles `fetchKanbanPlanPreview` for any file path.

## Proposed Changes

### File 1: `src/webview/project.js`

**1a. Add a module-level preview-target variable (near the other epic state declarations, ~line 207):**

```js
let _epicPreviewFilePath = null; // tracks which file is currently shown in the Epics preview pane (epic or subtask)
```

**1b. Set `_epicPreviewFilePath` in `selectEpic()` (line ~1246):**

```js
function selectEpic(plan) {
    _epicSelectedPlan = plan;
    _epicPreviewFilePath = plan.planFile || null;   // <-- ADD
    // ... rest unchanged ...
}
```

**1c. Update the `kanbanPlanPreviewReady` handler (lines 309–318) to check `_epicPreviewFilePath`:**

Replace the condition:
```js
if (epicsPreviewContent && _epicSelectedPlan && _epicSelectedPlan.planFile === msg.filePath) {
```
with:
```js
if (epicsPreviewContent && _epicPreviewFilePath && _epicPreviewFilePath === msg.filePath) {
```

The body remains the same (set `innerHTML`, store `editOriginalContent`, toggle edit button).

**1d. Add a click handler + cursor styling in `renderEpicSubtasks()` (lines 1306–1322):**

Modify the subtask item template to make the topic span clickable, and wire up the handler:

```js
subtasksDiv.innerHTML = subtasks.map(st => `
    <div class="epic-subtask-item">
        <span class="epic-subtask-link" data-plan-file="${escapeHtml(st.planFile || '')}" style="cursor: pointer; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">• ${escapeHtml(st.topic)} (${escapeHtml(st.kanbanColumn)})</span>
        <button class="epic-remove-subtask-btn" data-subtask-session="${escapeHtml(st.sessionId || st.planId)}" data-workspace-root="${escapeHtml(epic.workspaceRoot)}">Remove</button>
    </div>
`).join('');

// Wire subtask click → preview
subtasksDiv.querySelectorAll('.epic-subtask-link').forEach(link => {
    link.addEventListener('click', e => {
        e.stopPropagation();
        const planFile = link.dataset.planFile;
        if (!planFile) {
            showToast('This subtask has no plan file to preview.', 'error');
            return;
        }
        if (state.editMode.epics) exitEditMode('epics');
        _epicPreviewFilePath = planFile;
        if (epicsPreviewContent) epicsPreviewContent.innerHTML = '<div class="kanban-empty-state">Loading preview...</div>';
        vscode.postMessage({
            type: 'fetchKanbanPlanPreview',
            filePath: planFile,
            requestId: ++_kanbanPreviewRequestId
        });
        // Hide the Edit button while a subtask is previewed (subtasks are edited from the Kanban board)
        const btnEdit = document.getElementById('btn-edit-epics');
        if (btnEdit) btnEdit.style.display = 'none';
    });
});

// Wire remove buttons (existing code, unchanged)
subtasksDiv.querySelectorAll('.epic-remove-subtask-btn').forEach(btn => {
    btn.addEventListener('click', e => {
        e.stopPropagation();
        vscode.postMessage({
            type: 'removeSubtaskFromEpic',
            subtaskSessionId: btn.dataset.subtaskSession,
            workspaceRoot: btn.dataset.workspaceRoot
        });
    });
});
```

**1e. Re-show the Edit button when the epic card itself is re-selected:**

In `renderEpicMetaBar()` (line ~1269), the Edit button is always rendered. No change needed there — but when `selectEpic` is called (clicking the epic card), the meta bar is re-rendered via `renderEpicMetaBar(plan)`, which recreates the Edit button in its default visible state. This naturally restores Edit functionality when navigating back from a subtask preview to the epic.

### File 2: `src/webview/project.html` (optional CSS polish)

Add a hover style for the clickable subtask link so users discover it's interactive:

```css
.epic-subtask-link:hover {
    color: var(--accent-teal);
    text-decoration: underline;
}
```

(Add after the `.epic-subtask-item` rule, ~line 594.)

## Verification Plan

1. **Build:** `npm run compile` — confirm no errors.
2. **Manual test (via installed VSIX):**
   - Open Switchboard Project → Epics tab.
   - Select an epic that has at least one subtask, expand its accordion.
   - **Click the subtask topic text** → confirm the right-hand preview panel loads the subtask's plan content (rendered markdown).
   - Confirm the "Remove" button still works independently and does not trigger a preview.
   - Confirm that while a subtask is previewed, the Edit button is hidden.
   - **Click the epic card again** → confirm the epic's own preview loads and the Edit button reappears.
   - **Edit-mode guard:** Enter edit mode on the epic, then click a subtask → confirm edit mode exits and the subtask preview loads (no stale editor content).
   - **No planFile:** If a subtask with an empty `planFile` exists, clicking it shows a toast error instead of a blank preview.
3. **Regression:** Confirm the Kanban tab preview still works (it uses a separate `_kanbanSelectedPlan` check, untouched).

---

## Review Pass — 2026-06-24

### Stage 1: Grumpy Adversarial Findings

| # | Severity | Finding | Location |
|:--|:---------|:--------|:---------|
| 1 | NIT | Redundant Edit-button display toggle: `exitEditMode('epics')` re-shows Edit button (line 1680), then subtask click handler immediately hides it (line 1348). Two DOM writes for one visual outcome. | `project.js:1338` + `project.js:1348` |
| 2 | NIT | `kanbanPlanPreviewReady` handler sets `disabled = false` on the Edit button even when a subtask is being previewed (button is `display:none` so unreachable, but semantically sloppy). | `project.js:331` |
| 3 | NIT | CSS hover rule `.epic-subtask-link:hover` placed after `.epic-remove-subtask-btn` (line 602) instead of directly after `.epic-subtask-item` (line 594) as the plan specified. No cascade/specificity impact. | `project.html:602` |

### Stage 2: Balanced Synthesis

- **No CRITICAL or MAJOR findings.** All three NITs are cosmetic with zero functional impact.
- **All deferred** — fixing would add branching complexity for no user-visible benefit.
- All six plan requirements (1a–1e + CSS) implemented correctly.
- All seven edge cases from the plan handled correctly.

### Code Fixes Applied

**None.** No CRITICAL/MAJOR findings to fix.

### Files Changed (Implementation)

- `src/webview/project.js` — lines 167, 324, 1263, 1322–1350 (variable, handler, selectEpic, subtask click wiring)
- `src/webview/project.html` — lines 602–605 (`.epic-subtask-link:hover` CSS)

### Validation Results

| Check | Result |
|:------|:-------|
| `node --check src/webview/project.js` | ✅ SYNTAX OK |
| Compilation (`npm run compile`) | ⏭️ Skipped per review instructions |
| Automated tests | ⏭️ Skipped per review instructions |
| Plan req 1a: `_epicPreviewFilePath` variable | ✅ `project.js:167` |
| Plan req 1b: Set in `selectEpic()` | ✅ `project.js:1263` |
| Plan req 1c: `kanbanPlanPreviewReady` uses `_epicPreviewFilePath` | ✅ `project.js:324` |
| Plan req 1d: Click handler + cursor styling | ✅ `project.js:1322–1350` |
| Plan req 1e: Edit button re-shown on epic re-select | ✅ Via `renderEpicMetaBar` in `selectEpic` (`project.js:1265`) |
| CSS hover style (File 2) | ✅ `project.html:602–605` |
| Edge case: empty `planFile` guard | ✅ `project.js:1334–1337` |
| Edge case: edit-mode guard | ✅ `project.js:1338` |
| Edge case: `stopPropagation` | ✅ `project.js:1332` |
| Edge case: Remove button independence | ✅ `project.js:1352–1360` |
| Edge case: Edit button hidden during subtask preview | ✅ `project.js:1347–1348` |
| Regression: Kanban tab handler untouched | ✅ `project.js:310` uses `_kanbanSelectedPlan.planFile` |

### Remaining Risks

1. **Manual testing not performed in this review** — the verification plan's manual test steps (clicking subtasks in a live VSIX) must be run by the user to confirm end-to-end behavior.
2. **`state.editOriginalContent.epics` is set to subtask content during subtask preview** — harmless because the Edit button is hidden (can't enter edit mode), and clicking back to the epic overwrites it. Noted for awareness, not a defect.
3. **No backend changes** — confirmed none needed; backend already passes `planFile` in subtask records.
