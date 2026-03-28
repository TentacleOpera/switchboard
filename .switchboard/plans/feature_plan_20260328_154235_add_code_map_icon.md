# Add Code Map Icon

## Goal
Add a code map icon to the CREATED column icon area using `icons/25-1-100 Sci-Fi Flat icons-90.png`. When clicked, it dispatches selected plans (or all plans in column if none selected) to the analyst agent with a "context map" prompt that inserts a file-list into each plan. The icon is only visible when an analyst agent is registered.

## Metadata
**Tags:** frontend, backend, UI
**Complexity:** High

## User Review Required

> [!NOTE]
> This adds a new icon to the CREATED column header. The icon only appears when an analyst agent is available. It dispatches plans to the analyst for file-list annotation — it does NOT trigger full planning.

## Complexity Audit

### Routine
- Register icon placeholder `{{ICON_CODE_MAP}}` in `KanbanProvider.ts` icon map.
- Add `ICON_CODE_MAP` JS constant in `kanban.html`.
- Add the `<button>` element to the CREATED column header area.
- Add `codeMapSelected` case to the webview click handler.

### Complex / Risky
- **Dual selection behavior:** When no plans are selected, the icon applies to ALL plans in the column. This requires falling back from `getSelectedInColumn()` to `getAllInColumn()`.
- **Analyst availability gating:** The icon must be conditionally rendered based on `lastVisibleAgents.analyst !== false`. The column header HTML is generated once during render and must be re-rendered when agent visibility changes.
- **Backend batch dispatch:** The `codeMapSelected` handler in `KanbanProvider.ts` must iterate over multiple session IDs and call the existing `switchboard.analystMapFromKanban` command for each. Error handling for partial failures (some plans succeed, some fail) must be considered.

## Edge-Case & Dependency Audit
- **Race Conditions:** If the analyst is processing a map request and the user clicks again, duplicate map requests could be sent. Mitigation: disable the button after click until the backend acknowledges (existing pattern with `btn.disabled = true`).
- **Security:** No new user input. Session IDs and workspace root are internal state.
- **Side Effects:** The analyst modifies plan files in-place (appending a `## Context Map` section). If multiple plans are dispatched simultaneously, the analyst may be overwhelmed. Consider sequential dispatch or a brief delay.
- **Dependencies & Conflicts:**
  - **Cross-plan conflict with "Add Chat Mode Copy Button"**: Both plans add icons to the CREATED column header. The CREATED column's `rightSide` area currently only has `+` and Import buttons. Both plans must add to the `buttonArea` (the column-button-area div), not the `rightSide`. Coordinate icon ordering: code map icon should appear before chat icon.
  - The existing `switchboard.analystMapFromKanban` command (registered in `extension.ts` line 1052) already handles single-plan analyst dispatch. This plan reuses it.

## Adversarial Synthesis

### Grumpy Critique
"So you're re-adding a feature that was *just removed* from the Planned column, but now sticking it in the CREATED column. Were the reasons it was removed addressed, or are we just playing musical columns? The dual-selection behavior is a UX landmine — a user with 50 plans in CREATED who accidentally clicks this with nothing selected will spam the analyst with 50 context map requests. That's not a feature, that's a denial-of-service attack on your own agent. Also, 'only visible when analyst is available' — what happens when the analyst becomes unavailable mid-session? The icon vanishes? Does the user get told why? And batch dispatch to `analystMapFromKanban` is a serial loop over an async command — what's the failure model when plan #23 out of 50 fails?"

### Balanced Response
Valid concerns, addressed:
1. **Feature relocation rationale:** The code map was removed from PLAN REVIEWED because it conflicted with the planning workflow in that column. CREATED is the correct home because plans are being triaged and need file-list annotation before planning begins. The feature itself was valuable — only its placement was wrong.
2. **Mass-dispatch on empty selection:** We will add a confirmation dialog when no plans are selected AND the column has more than 5 plans: `"Run code map on all ${count} plans in this column?"`. This prevents accidental mass dispatch.
3. **Analyst availability changes mid-session:** The kanban board already re-renders column headers when `lastVisibleAgents` updates (triggered by sidebar agent roster changes). The icon will appear/disappear dynamically.
4. **Batch failure model:** We will dispatch sequentially with error counting. On completion, show `"Code map completed for X/Y plans. Z failed."` If any fail, log the specific session IDs to the console for debugging.

## Proposed Changes

### Icon URI Registration

#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** The `iconMap` object (around line 2128) needs a new entry for icon 90.
- **Logic:** Add `{{ICON_CODE_MAP}}` placeholder mapped to the icon file.
- **Implementation:**

Add to `iconMap` (after existing entries):
```typescript
'{{ICON_CODE_MAP}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-90.png')).toString(),
```

### Icon Constant & Button HTML

#### [MODIFY] `src/webview/kanban.html`
- **Context:** Icon constants are declared around line 1103. The CREATED column's button area is generated around line 1320.
- **Logic:**
  1. Add `ICON_CODE_MAP` constant.
  2. Create a conditional `codeMapBtn` variable that renders only when `isCreated && lastVisibleAgents.analyst !== false`.
  3. Insert the button into the CREATED column's `buttonArea` div.
- **Implementation:**

**Step 1 — Add icon constant** (after line 1112):
```javascript
const ICON_CODE_MAP = '{{ICON_CODE_MAP}}';
```

**Step 2 — Add conditional button variable** (around line 1304, alongside `julesBtn` and `rePlanBtn`):
```javascript
const codeMapBtn = (isCreated && lastVisibleAgents.analyst !== false)
    ? `<button class="column-icon-btn" data-action="codeMapSelected" data-column="${escapeAttr(def.id)}" data-tooltip="Run code map on selected plans (or all if none selected)">
           <img src="${ICON_CODE_MAP}" alt="Code Map">
       </button>`
    : '';
```

**Step 3 — Insert into button area** for the CREATED column. In the `buttonArea` template where CREATED column buttons are generated (the else block around line 1320), append `${codeMapBtn}` after the existing buttons:
```javascript
${codeMapBtn}
```

### Click Handler

#### [MODIFY] `src/webview/kanban.html`
- **Context:** The column-icon-btn click handler switch statement (around line 1386).
- **Logic:** Add a `codeMapSelected` case that:
  1. Gets selected plans via `getSelectedInColumn(column)`.
  2. Falls back to `getAllInColumn(column)` if none selected.
  3. If falling back and count > 5, posts a confirmation request.
  4. Posts the message to the backend.
- **Implementation:**

Add new case (after `rePlanSelected` case, around line 1430):
```javascript
case 'codeMapSelected': {
    let ids = getSelectedInColumn(column);
    const usedAll = ids.length === 0;
    if (usedAll) {
        ids = getAllInColumn(column);
    }
    if (ids.length === 0) return;
    if (usedAll && ids.length > 5) {
        postKanbanMessage({ type: 'codeMapConfirm', sessionIds: ids, count: ids.length, workspaceRoot: getActiveWorkspaceRoot() });
    } else {
        postKanbanMessage({ type: 'codeMapSelected', sessionIds: ids, workspaceRoot: getActiveWorkspaceRoot() });
    }
    break;
}
```

### Backend Message Handler

#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** The webview message handler switch statement (around line 1984).
- **Logic:** Add handlers for `codeMapSelected` and `codeMapConfirm`. Both dispatch the analyst context map command for each session ID sequentially. `codeMapConfirm` first shows a confirmation dialog.
- **Implementation:**

Add new cases (after `rePlanSelected` handler):
```typescript
case 'codeMapConfirm': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) { break; }
    const confirm = await vscode.window.showWarningMessage(
        `Run code map on all ${msg.sessionIds.length} plans in this column?`,
        'Run All', 'Cancel'
    );
    if (confirm !== 'Run All') { break; }
    // Fall through to codeMapSelected logic
    msg.type = 'codeMapSelected';
}
// falls through
case 'codeMapSelected': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) { break; }
    const visibleAgents = await this._getVisibleAgents(workspaceRoot);
    if (visibleAgents.analyst === false) {
        vscode.window.showWarningMessage('Analyst agent is not available.');
        break;
    }
    let succeeded = 0;
    let failed = 0;
    for (const sessionId of msg.sessionIds) {
        try {
            await vscode.commands.executeCommand('switchboard.analystMapFromKanban', sessionId, workspaceRoot);
            succeeded++;
        } catch (err) {
            failed++;
            console.error(`[KanbanProvider] Code map failed for session ${sessionId}:`, err);
        }
    }
    const failMsg = failed > 0 ? ` ${failed} failed.` : '';
    vscode.window.showInformationMessage(`Code map dispatched for ${succeeded}/${msg.sessionIds.length} plan(s).${failMsg}`);
    break;
}
```

**Clarification:** The fall-through from `codeMapConfirm` to `codeMapSelected` avoids duplicating the dispatch logic. The `workspaceRoot` is resolved again in the second case to handle both entry points.

## Open Questions

None. Requirements are clear from the original spec.

## Verification Plan

### Manual Verification
1. Open the Kanban board with an analyst agent registered in the sidebar.
2. **Icon visibility:** Verify the code map icon appears in the CREATED column header.
3. **Selection behavior:** Select 1 plan, click the icon. Verify the analyst receives the context map request for that plan only.
4. **All-plans behavior:** Deselect all plans, click the icon. If ≤5 plans in column, verify all are dispatched. If >5, verify a confirmation dialog appears.
5. **Agent gating:** Disable the analyst agent in setup. Verify the icon disappears from the CREATED column.
6. **Result:** Verify the plan file receives a `## Context Map` section with file paths.

### Build Verification
- Run `npm run compile` — no errors.
- Verify icon file `icons/25-1-100 Sci-Fi Flat icons-90.png` exists and is bundled.

### Agent Recommendation
**Send to Lead Coder** — Multiple files, dual-selection logic, batch dispatch with error handling, and agent availability gating make this a complex change.

---

## Reviewer Pass — 2026-03-28

### Verification Results
- **`npx tsc --noEmit`**: ✅ PASS — zero errors
- **Icon file**: ✅ `icons/25-1-100 Sci-Fi Flat icons-90.png` exists
- **Code review**: All plan steps verified against implementation

### Implementation Status

| Step | Description | Status |
|---|---|---|
| Icon URI | `{{ICON_CODE_MAP}}` registered in `KanbanProvider.ts` icon map (line 2212) | ✅ Complete |
| Icon Constant | `ICON_CODE_MAP` declared in `kanban.html` (line 1109) | ✅ Complete |
| Button HTML | Conditional button with analyst gating (`lastVisibleAgents.analyst !== false`) | ✅ Complete |
| Button Placement | Inserted into CREATED column `buttonArea` (line 1342) | ✅ Complete |
| Click Handler | `codeMapSelected` case with dual selection + >5 confirmation threshold | ✅ Complete |
| Backend Confirm | `codeMapConfirm` handler with warning dialog + fall-through | ✅ Complete |
| Backend Dispatch | `codeMapSelected` handler with sequential dispatch + error counting | ✅ Complete |

### Files Changed
- `src/services/KanbanProvider.ts` — icon URI registration, `codeMapConfirm`/`codeMapSelected` message handlers
- `src/webview/kanban.html` — icon constant, conditional button, click handler

### Review Findings
- **0 CRITICAL**, **0 MAJOR**, **2 NIT**
- NIT: No button disable after click (anti-double-click) — idempotent operation, minor UX polish
- NIT: Icon filename convention (`25-1-100 Sci-Fi Flat icons-90.png`) — project-wide convention, not this plan's scope

### Remaining Risks
- None blocking. Anti-double-click is a future UX polish item.
