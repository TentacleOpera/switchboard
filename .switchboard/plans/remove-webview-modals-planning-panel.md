# Remove Webview Modals from Planning Panel

## Goal

Remove all `alert()` and `confirm()` calls from the Planning Panel webview (`planning.js`) because VS Code webviews are sandboxed without `allow-modals`, causing these calls to silently fail and lock up the UI state machine.

### Core Problem & Root Cause

- `confirm()` is used to gate tab switches, file tree clicks, edit cancellation, and save conflict resolution.
- `alert()` is used for success/error feedback and form validation.
- In a sandboxed webview, `confirm()` always returns `false`, so every gated action aborts.
- `alert()` is ignored entirely, so the user never sees feedback.
- The Cancel button handlers (lines 4561, 4595, 4629) call `exitEditMode(tab, false)`, which hits the internal `confirm()` gate at line 4459 — this is the primary lockup path.

## Metadata

- **Tags:** frontend, ui, bugfix, refactor
- **Complexity:** 4

## User Review Required

- Auto-discard behavior on Cancel button: clicking Cancel with unsaved changes will now always discard (no confirmation). Is this acceptable?
- Auto-overwrite on save conflict: when the file was modified externally, the panel will overwrite without asking. Is this acceptable?
- Form validation for empty ticket title: should use inline message near the input field. Confirm placement preference.

## Complexity Audit

### Routine
- Delete `if (!confirm(...)) { return; }` guard blocks (7 instances at lines 262, 268, 274, 1027, 1084, 4025, 4459)
- Replace `alert()` with `console.error()` / `console.log()` / `console.warn()` for error/stub messages (10 instances)
- Remove redundant success `alert()`s (4 instances at lines 3520, 3540, 3558, 3566)
- Final grep verification pass

### Complex / Risky
- Save conflict handler rewrite (lines 3402–3433): auto-overwrite strategy with status text feedback
- Form validation replacement (line 4939): needs inline validation message, not just `console.warn()`
- Import/refine success feedback (lines 3558, 3560, 3566, 3568): need visible status text replacement, not just removal

## Edge-Case & Dependency Audit

- **Race Conditions**: None. All modal calls are synchronous in the current code. Removing them makes the flow unconditional — no race window opens.
- **Security**: No security implications. `confirm()`/`alert()` are not security controls.
- **Side Effects**: `exitEditMode` currently returns `false` when confirm is denied (line 4460). After fix, it never returns `false`. Caller at line 3817 (`if (!exitEditMode('kanban', true)) return;`) has a dead-code branch. Harmless but should be documented.
- **Dependencies & Conflicts**: No other files depend on these modal calls. `PlanningPanelProvider.ts` sends IPC messages but does not use `alert()`/`confirm()`. No conflicts expected.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) Form validation at line 4939 becomes invisible if replaced with `console.warn()` — must use inline validation message instead. (2) Import/refine success feedback (lines 3558, 3566) has no visible replacement — must add status text. (3) Save conflict auto-overwrite should show persistent status text, not a fleeting flash. Mitigations: inline validation for form, status text for import/refine success, persistent conflict status until next action.

## Audit of All Modal Calls

### `confirm()` — 8 instances

All of these silently abort their surrounding operation when suppressed.

| # | Location | Context | Current Behavior | Desired Behavior |
|---|----------|---------|------------------|------------------|
| 1 | `planning.js:262` | Tab switch away from Local Docs while dirty | Prompts to discard; if `false`, aborts switch | Auto-discard and switch |
| 2 | `planning.js:268` | Tab switch away from Kanban Plans while dirty | Prompts to discard; if `false`, aborts switch | Auto-discard and switch |
| 3 | `planning.js:274` | Tab switch away from Design System while dirty | Prompts to discard; if `false`, aborts switch | Auto-discard and switch |
| 4 | `planning.js:1027` | Click design-folder file tree node while dirty | Prompts to discard; if `false`, aborts load | Auto-discard and load |
| 5 | `planning.js:1084` | Click local-folder file tree node while dirty | Prompts to discard; if `false`, aborts load | Auto-discard and load |
| 6 | `planning.js:3403` | Save conflict: "Overwrite or reload?" | Prompts to overwrite; if `false`, reloads from disk | Auto-overwrite with status text |
| 7 | `planning.js:4025` | Select a different Kanban plan while dirty | Prompts to discard; if `false`, aborts selection | Auto-discard and select |
| 8 | `planning.js:4459` | `exitEditMode(tab, false)` called while dirty | Prompts to discard; if `false`, returns false (locks up) | Auto-discard and exit edit mode |

### `alert()` — 14 instances

| # | Location | Context | Desired Replacement |
|---|----------|---------|---------------------|
| 1 | `planning.js:2970` | Generic backend error message | `console.error()` |
| 2 | `planning.js:3429` | Conflict "Cancel" branch: "Reloaded from disk." | Remove entirely (branch will be deleted) |
| 3 | `planning.js:3432` | Save error message | Status text + `console.error()` |
| 4 | `planning.js:3520` | ClickUp ticket created successfully | Remove (modal already closes, UI is sufficient) |
| 5 | `planning.js:3529` | ClickUp ticket creation failed | `console.error()` + status text in tickets strip |
| 6 | `planning.js:3540` | Linear ticket created successfully | Remove (modal already closes, UI is sufficient) |
| 7 | `planning.js:3549` | Linear ticket creation failed | `console.error()` + status text in tickets strip |
| 8 | `planning.js:3558` | Task imported successfully | Status text in tickets strip (brief "Imported ✓") |
| 9 | `planning.js:3560` | Task import failed | `console.error()` + status text in tickets strip |
| 10 | `planning.js:3566` | Task refined successfully | Status text in tickets strip (brief "Refined ✓") |
| 11 | `planning.js:3568` | Task refine failed | `console.error()` + status text in tickets strip |
| 12 | `planning.js:4335` | Failed to set active context | `console.error()` |
| 13 | `planning.js:4882` | "Ask Agent" not yet implemented | `console.log()` |
| 14 | `planning.js:4939` | Create ticket form validation (empty title) | Inline validation message near title input |

## Implementation Plan

### Step 1: Remove all dirty-check `confirm()` gates

For each of instances #1–5 and #7 above, delete the `if (!confirm(...)) { return; }` guard and keep the `exitEditMode(..., true)` call that follows it. The panel should unconditionally discard unsaved changes when the user switches tabs, clicks a new file, or selects a different plan.

**Example transformation (tab switch dirty check — line 262):**

```js
// BEFORE (lines 261-266)
if (state.dirtyFlags.local && tabName !== 'local') {
    if (!confirm('You have unsaved changes in Local Docs. Discard them?')) {
        return;
    }
    exitEditMode('local', true);
}

// AFTER
if (state.dirtyFlags.local && tabName !== 'local') {
    exitEditMode('local', true);
}
```

Apply same pattern at lines 268, 274, 1027, 1084, 4025.

### Step 2: Remove `confirm()` from `exitEditMode()` (line 4459)

```js
// BEFORE (lines 4457-4462)
function exitEditMode(tab, discard) {
    if (!discard && state.dirtyFlags[tab]) {
        if (!confirm('You have unsaved changes. Discard them?')) {
            return false;
        }
    }
    // ... rest of function

// AFTER
function exitEditMode(tab, discard) {
    // No confirmation needed; proceed with exit
    // ... rest of function unchanged
```

**Note on semantic change**: Cancel buttons (lines 4561, 4595, 4629) call `exitEditMode(tab, false)`. After this change, Cancel will always exit edit mode and discard dirty changes. This is the intended fix — the current behavior is a lockup.

**Note on dead code**: Line 3817 (`if (!exitEditMode('kanban', true)) return;`) — after this change, `exitEditMode` never returns `false`, so the `return` branch becomes unreachable. This is harmless but can be cleaned up optionally.

### Step 3: Rewrite the save-conflict handler (lines 3402–3433)

Replace the `confirm()`/`alert()` conflict flow with auto-overwrite + persistent status text.

**Transformation:**

```js
// BEFORE (lines 3402-3433)
} else if (conflict) {
    const overwrite = confirm('Save Conflict! The file has been modified on disk by another process. Overwrite disk changes with your edits? (Click Cancel to reload from disk instead)');
    if (overwrite) {
        const filePath = (tab === 'local' || tab === 'design') ? state.activeDocFilePath : (_kanbanSelectedPlan ? _kanbanSelectedPlan.planFile : null);
        vscode.postMessage({
            type: 'saveFileContent',
            filePath,
            content: textarea.value,
            originalContent: diskContent,
            tab
        });
    } else {
        if (tab === 'local') {
            state.activeDocContent = diskContent;
            textarea.value = diskContent;
            state.editOriginalContent.local = diskContent;
            state.dirtyFlags.local = false;
        } else if (tab === 'design') {
            state.activeDocContent = diskContent;
            textarea.value = diskContent;
            state.editOriginalContent.design = diskContent;
            state.dirtyFlags.design = false;
        } else {
            state.editOriginalContent.kanban = diskContent;
            textarea.value = diskContent;
            state.dirtyFlags.kanban = false;
        }
        alert('Reloaded from disk.');
    }
} else {
    alert('Error saving file: ' + (error || 'Unknown error'));
}

// AFTER
} else if (conflict) {
    const filePath = (tab === 'local' || tab === 'design') ? state.activeDocFilePath : (_kanbanSelectedPlan ? _kanbanSelectedPlan.planFile : null);
    vscode.postMessage({
        type: 'saveFileContent',
        filePath,
        content: textarea.value,
        originalContent: diskContent,
        tab
    });
    const statusEl = document.getElementById(tab === 'local' ? 'status' : (tab === 'design' ? 'status-design' : null));
    if (statusEl) {
        statusEl.textContent = 'Conflict detected, overwriting...';
        statusEl.style.color = 'var(--vscode-editorWarning-foreground, #cca700)';
    }
} else {
    console.error('Error saving file:', error || 'Unknown error');
    const statusEl = document.getElementById(tab === 'local' ? 'status' : (tab === 'design' ? 'status-design' : null));
    if (statusEl) {
        statusEl.textContent = 'Error saving: ' + (error || 'Unknown');
        statusEl.style.color = 'var(--vscode-errorForeground, #ff6b6b)';
    }
}
```

**Key change**: The entire `else` branch (reload-from-disk + alert) is removed. Auto-overwrite is the default. Status text persists until the next action overwrites it.

### Step 4: Replace all `alert()` calls

Replace every `alert()` per the audit table above. The exact mapping is:

- **Error messages** → `console.error()` + optional status text
- **Success messages (ticket created)** → Remove entirely (modal close + list refresh is sufficient)
- **Success messages (import/refine)** → Status text in tickets strip (brief "Imported ✓" / "Refined ✓", auto-clear after 2s)
- **Validation messages** → Inline validation message near the form field
- **Stub/not-implemented** → `console.log()`

**Form validation detail (line 4939):**

```js
// BEFORE
if (!title) {
    alert('Please enter a ticket title.');
    return;
}

// AFTER
if (!title) {
    const titleInput = document.getElementById('create-ticket-title');
    if (titleInput) {
        titleInput.style.borderColor = 'var(--vscode-errorForeground, #ff6b6b)';
        titleInput.placeholder = 'Title is required';
        setTimeout(() => {
            titleInput.style.borderColor = '';
            titleInput.placeholder = 'Enter ticket title';
        }, 2000);
    }
    return;
}
```

**Import/refine success detail (lines 3558, 3566):**

```js
// AFTER (import success example)
if (msg.success) {
    const { detailImportButton } = getTicketsTabElements();
    if (detailImportButton) detailImportButton.disabled = false;
    // Show brief success status in tickets strip
    const ticketsStrip = document.querySelector('.tickets-controls-strip');
    if (ticketsStrip) {
        let statusSpan = ticketsStrip.querySelector('.tickets-action-status');
        if (!statusSpan) {
            statusSpan = document.createElement('span');
            statusSpan.className = 'tickets-action-status';
            statusSpan.style.cssText = 'font-size:11px; color:var(--vscode-editorInfo-foreground, #3794ff); margin-left:8px;';
            ticketsStrip.appendChild(statusSpan);
        }
        statusSpan.textContent = 'Imported ✓';
        setTimeout(() => { statusSpan.textContent = ''; }, 2000);
    }
}
```

Apply same pattern for refine success (line 3566) with text "Refined ✓".

For failure cases (lines 3529, 3549, 3560, 3568), add similar status text with error color + `console.error()`.

### Step 5: Verify no `alert()` or `confirm()` remain

Run a final grep over `planning.js` to ensure zero `alert(` and zero `confirm(` calls remain. If any are found, apply the same replacement strategy.

## Proposed Changes

### `src/webview/planning.js`

- **Lines 262–264**: Delete `confirm()` guard in Local Docs tab-switch dirty check. Keep `exitEditMode('local', true)` at line 265.
- **Lines 268–270**: Delete `confirm()` guard in Kanban tab-switch dirty check. Keep `exitEditMode('kanban', true)` at line 271.
- **Lines 274–276**: Delete `confirm()` guard in Design tab-switch dirty check. Keep `exitEditMode('design', true)` at line 277.
- **Lines 1027–1029**: Delete `confirm()` guard in design-folder file tree dirty check. Keep `exitEditMode('design', true)` at line 1030.
- **Lines 1084–1086**: Delete `confirm()` guard in local-folder file tree dirty check. Keep `exitEditMode('local', true)` at line 1087.
- **Lines 3402–3433**: Rewrite save-conflict handler. Remove `confirm()` branch, remove reload-from-disk `else` branch, remove both `alert()` calls. Add auto-overwrite with status text.
- **Lines 4025–4027**: Delete `confirm()` guard in Kanban plan selection dirty check. Keep `exitEditMode('kanban', true)` at line 4028.
- **Lines 4458–4461**: Delete `confirm()` guard inside `exitEditMode()`. Function proceeds unconditionally.
- **Line 2970**: Replace `alert()` with `console.error()`.
- **Line 3429**: Remove (branch deleted in Step 3).
- **Line 3432**: Replace `alert()` with `console.error()` + status text (handled in Step 3 rewrite).
- **Line 3520**: Remove `alert()` (ClickUp success — modal close is sufficient).
- **Line 3529**: Replace `alert()` with `console.error()` + status text in tickets strip.
- **Line 3540**: Remove `alert()` (Linear success — modal close is sufficient).
- **Line 3549**: Replace `alert()` with `console.error()` + status text in tickets strip.
- **Line 3558**: Replace `alert()` with status text "Imported ✓" in tickets strip.
- **Line 3560**: Replace `alert()` with `console.error()` + status text in tickets strip.
- **Line 3566**: Replace `alert()` with status text "Refined ✓" in tickets strip.
- **Line 3568**: Replace `alert()` with `console.error()` + status text in tickets strip.
- **Line 4335**: Replace `alert()` with `console.error()`.
- **Line 4882**: Replace `alert()` with `console.log()`.
- **Line 4939**: Replace `alert()` with inline validation (border color + placeholder change on title input).

## Files to Modify

- `src/webview/planning.js` — remove all `confirm()` (8 instances) and `alert()` (14 instances) calls

## Files Not to Modify

- `src/services/PlanningPanelProvider.ts` — the backend IPC handler already correctly sends `saveFileContentResult` with `conflict: true`; it does not use `alert()` or `confirm()`. No changes needed.
- `src/webview/planning.html` — the HTML template does not contain any modal calls. No changes needed.

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Auto-discarding changes on tab switch/Cancel could lose user work | This is the **current intended behavior** — the `confirm()` was supposed to ask, but because it's broken, users already lose work when the panel locks up. Removing the broken gate fixes the lockup. A future non-blocking inline banner can restore the safety net. |
| Auto-overwriting on conflict could clobber external edits | Same as above — the conflict dialog is already broken. Auto-overwrite is the saner default for an in-panel editor. Status text persists to inform the user. A future inline diff/banner would be better but is out of scope. |
| Removing success `alert()`s means less user feedback | Success is already communicated via status text (`"Saved successfully"`, modal closing, list refresh). For import/refine, adding status text in the tickets strip fills the gap. |
| Form validation invisible with `console.warn()` | Replaced with inline validation (border color + placeholder) — visible to user. |
| Missed a `confirm()` or `alert()` in a rarely hit code path | Final grep verification step catches this. |

## Verification Plan

### Automated Tests

- Grep verification: `rg 'confirm\(' src/webview/planning.js` returns 0 matches
- Grep verification: `rg 'alert\(' src/webview/planning.js` returns 0 matches

### Manual Verification

1. Open the Planning Panel.
2. Open a local doc, click Edit, make a change, click Cancel.
3. **Expected:** Edit mode exits immediately, no lockup.
4. Make another change, switch to the Kanban tab.
5. **Expected:** Tab switches immediately, changes auto-discarded, no lockup.
6. Edit a file externally while it's open in the panel, then Save from the panel.
7. **Expected:** Save succeeds (auto-overwrite), status text shows "Conflict detected, overwriting...", no lockup.
8. Create a ticket with an empty title.
9. **Expected:** Title input shows red border + "Title is required" placeholder, no lockup.
10. Import a task.
11. **Expected:** Status text "Imported ✓" appears briefly in tickets strip.

## Review Findings

All 8 `confirm()` and 14 `alert()` instances removed. Grep verification confirms zero remaining. One CRITICAL issue found and fixed: the plan's own code example passed `null` to `getElementById` for kanban tab in the conflict/error status paths (lines 3545, 3552), making kanban save conflict/error feedback invisible. Fixed by using the same `.kanban-controls-strip` + `.kanban-save-status` pattern already used for kanban success. One NIT deferred: dead code at line 3943 (`if (!exitEditMode(...)) return;` — unreachable after confirm removal). File changed: `src/webview/planning.js`. Remaining risk: auto-discard/auto-overwrite behavior is irreversible without a future non-blocking inline banner safety net.

## Recommendation

Complexity 4 → **Send to Coder**
