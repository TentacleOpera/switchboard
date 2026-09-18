# Bug Fix: ORCHESTRATING Column Never Appears After Clicking Orchestrate

## Goal

Fix three inter-related issues with the Orchestrate button on epic kanban cards:

1. **Remove the 🎯 emoji** from button label (looks unprofessional, clutters the card)
2. **Add purple styling** so the Orchestrate button visually stands out from other card-btn buttons
3. **ORCHESTRATING column never appears** on the board after clicking — the core bug

### Problem Analysis

**Root Cause (confirmed via code trace):**

`renderBoard()` in `kanban.html` line 5105 falls back cards with unknown columns to CREATED:
```js
const col = columns.includes(effectiveCol) ? effectiveCol : 'CREATED';
```

The webview's `columns` array is only updated when a `updateColumns` message is received. That message is guarded by `_lastColumnsSignature` deduplication in `KanbanProvider.refreshWithData` (line 1280). If the signature hasn't changed (ORCHESTRATING was already in the previous signature), `updateColumns` is NOT sent. The webview's `columns` array doesn't contain ORCHESTRATING. `renderBoard` silently falls the epic back to CREATED.

**Secondary failure mode**: The `updateColumns` handler in the webview resets `lastBoardSignature = ''`, which is what allows the subsequent `updateBoard` message to actually call `renderBoard`. If `updateColumns` is suppressed, `lastBoardSignature` is NOT reset. If the epic's column changed (CREATED → ORCHESTRATING), `nextBoardSignature !== lastBoardSignature` is still true, so `renderBoard` IS called — but with `columns` not containing ORCHESTRATING, so it falls back to CREATED anyway.

**Third failure mode**: If `moveCardToColumn` silently returns `false` (e.g. `getPlanBySessionId(epic.sessionId)` returns null due to a sessionId mismatch, which can happen for some epic creation paths), the DB is never updated. The subsequent `_refreshBoard` call shows the epic in its original column, ORCHESTRATING never occupies any cards, and the column doesn't appear.

### Root Cause Evidence

- `_lastColumnsSignature = null` is only reset on panel dispose (lines 950, 992) — not before `markEpicOrchestrating`
- `markEpicOrchestrating` has no return value (`Promise<void>`), so the caller (`orchestrateEpic` handler) cannot know if the move succeeded
- The handler always sends "Epic moved to ORCHESTRATING" status message even when `moved === false`
- `renderBoard` line 5105: `columns.includes(effectiveCol) ? effectiveCol : 'CREATED'` is the silent discard
- `_filterDynamicColumns` (line 2424) uses `epicOnly` to gate ORCHESTRATING visibility: `if (col.epicOnly) return occupiedColumns.has(col.id)` — the column only appears in the filtered set when occupied. If the signature already reflects an occupied ORCHESTRATING from a prior refresh, a second orchestration's `_refreshBoard` produces the same signature and `updateColumns` is suppressed.

---

## Metadata

**Tags:** [frontend, backend, bugfix, ui, ux]
**Complexity:** 5

## User Review Required

Yes — the purple color choice (`#6b21a8` / `#7c3aed`) is a design decision the user should confirm. The safety net's stub column definition (order, label, kind) should also be reviewed to ensure it matches the backend's actual ORCHESTRATING column definition.

## Complexity Audit

### Routine
- Removing the 🎯 emoji from 3 string locations (trivial text replacement)
- Adding a CSS rule for `.card-btn.orchestrate` (follows existing `.card-btn.recover` pattern)
- Adding `btn.disabled = true; btn.textContent = 'Orchestrating…'` to the click handler (2 lines)
- Resetting `_lastColumnsSignature = null` before `_refreshBoard` (1 line)
- Changing `markEpicOrchestrating` return type from `Promise<void>` to `Promise<boolean>` and adding return statements

### Complex / Risky
- Webview safety net (Fix 4D) dynamically mutates module-level `columns` and `columnDefinitions` arrays inside `renderBoard()`, then calls `renderColumns()` to re-render headers mid-board-render. While `renderColumns()` does not call `renderBoard()` (no recursion risk), the mid-render DOM rebuild has subtle ordering dependencies: `buckets` must be initialized after the safety net adds ORCHESTRATING, and the card-rendering loop later in `renderBoard` must find the DOM container created by `renderColumns()`.
- The `send` mode path (`dispatchEpicOrchestration`) calls `markEpicOrchestrating` internally (line 3186) but does not propagate the `moved` result back to the handler. The handler's `send` mode status message (line 7094) unconditionally claims "Epic moved to ORCHESTRATING" even if the move failed. Fix 4C only addresses the `copy` mode path — the `send` mode path needs a parallel fix.
- The idempotency short-circuit (line 3212) returns early without refreshing. If the epic is already in ORCHESTRATING in the DB but the webview's `columns` doesn't contain ORCHESTRATING (the bug state), clicking Orchestrate again hits the short-circuit and no `renderBoard` occurs — the column stays invisible until some other action triggers a board refresh.

## Edge-Case & Dependency Audit

**Race Conditions:**
- `refreshWithData` is async with multiple `await` points between `updateColumns` (line 1281) and `updateBoard` (later in the function). If a second `_refreshBoard` is triggered concurrently (e.g., file watcher fires during orchestration), the two refreshes' messages could interleave. However, VS Code's `postMessage` preserves order within a single sender, and `_refreshBoard` is not re-entrant guarded — the second call's `updateColumns` could overwrite the first's before the first's `updateBoard` arrives. Fix 4A mitigates this by forcing the signature reset, but does not eliminate the interleaving risk entirely. Risk is low because orchestration is a user-initiated action unlikely to coincide with a file watcher event for the same workspace.

**Security:**
- No security implications. All changes are UI state management and internal column visibility logic.

**Side Effects:**
- Fix 4A forces `updateColumns` to be sent on every orchestration, even when columns haven't changed. This causes the webview to reset `lastBoardSignature = ''` (line 6341) and call `renderBoard(currentCards)` (line 6344) — an extra full board render. Performance impact is negligible (board renders are already fast and debounced by signature comparison in the normal path).
- Fix 4D's safety net permanently modifies the module-level `columns` and `columnDefinitions` arrays. If a subsequent `updateColumns` message arrives (from Fix 4A), it overwrites both arrays with the backend's authoritative version — the safety net's modification is cleanly replaced. If no `updateColumns` arrives, the modification persists, which is the desired behavior (column stays visible).
- Fix 3's `btn.disabled = true` state is lost if the board re-renders between the click and the `epicOrchestrationResult` message (the button DOM element is replaced). The `epicOrchestrationResult` handler uses `document.querySelector` to find the (new) button, so it still resets correctly. Minor UX flicker, not a functional bug.

**Dependencies & Conflicts:**
- No external library dependencies. All changes use existing project APIs (`moveCardToColumn`, `_refreshBoard`, `renderColumns`, `renderBoard`).
- Fix 4B (return type change) is a breaking interface change for `markEpicOrchestrating`. All callers must be checked: `orchestrateEpic` handler (line 7091, copy mode) and `dispatchEpicOrchestration` (line 3186, send mode). Both are updated by the plan.

## Dependencies

None — this is a self-contained bug fix with no prerequisite plans.

## Adversarial Synthesis

Key risks: (1) the `send` mode path's status message is not fixed by the plan as written — `dispatchEpicOrchestration` must propagate the `moved` result; (2) the idempotent short-circuit bypasses the refresh, leaving the column invisible if the webview is already in the bug state; (3) the webview safety net mutates module-level state mid-render, which works but is fragile. Mitigations: add `moved` propagation to `dispatchEpicOrchestration`, add a lightweight refresh to the idempotent path, and keep the safety net as defense-in-depth rather than the primary fix.

---

## Fixes

### Fix 1 — Remove emoji (kanban.html, 3 occurrences)

**File**: `src/webview/kanban.html`

Occurrence 1 — Button template (line 5411):
```
🎯 Orchestrate  →  Orchestrate
```

Occurrences 2 & 3 — `epicOrchestrationResult` feedback reset (lines 6517, 6530):
```
btn.textContent = '🎯 Orchestrate'  →  btn.textContent = 'Orchestrate'
```

---

### Fix 2 — Purple CSS styling

**File**: `src/webview/kanban.html`

Locate the `.card-btn` CSS block (around line 971). Insert a new rule after the existing `.card-btn.recover:hover` rule (line 996-999):

```css
.card-btn.orchestrate {
    background: #6b21a8;
    color: #fff;
}
.card-btn.orchestrate:hover {
    background: #7c3aed;
}
```

---

### Fix 3 — Immediate click feedback (kanban.html, click handler)

**File**: `src/webview/kanban.html`

In the `.card-btn.orchestrate` click handler (lines 5295-5308), add immediate visual feedback BEFORE posting the message:

```js
document.querySelectorAll('.card-btn.orchestrate').forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        btn.disabled = true;
        btn.textContent = 'Orchestrating…';   // ← ADD THIS
        postKanbanMessage({
            type: 'orchestrateEpic',
            planId: btn.dataset.planId || '',
            sessionId: btn.dataset.session || '',
            workspaceRoot: btn.dataset.workspaceRoot || '',
            mode: 'copy'
        });
    });
});
```

---

### Fix 4 — Force ORCHESTRATING column to appear (the core fix)

**Two-part fix: backend + webview safety net**

#### Part A — Backend: force `_lastColumnsSignature = null` before refresh

**File**: `src/services/KanbanProvider.ts`

In `markEpicOrchestrating` (line 3225), reset the signature to null before calling `_refreshBoard`. This ensures `updateColumns` is always sent after an orchestration, regardless of previous signature state:

```typescript
// BEFORE (current code):
await this._refreshBoard(workspaceRoot);

// AFTER:
this._lastColumnsSignature = null;   // force updateColumns to always be sent
await this._refreshBoard(workspaceRoot);
```

#### Part B — Backend: make `markEpicOrchestrating` return success/failure

**File**: `src/services/KanbanProvider.ts`

Change signature from `Promise<void>` to `Promise<boolean>`, return `moved` (or `false` on early exits). Also add a lightweight refresh to the idempotent path so the column appears even if the webview was in the bug state:

```typescript
public async markEpicOrchestrating(...): Promise<boolean> {
    const db = this._getKanbanDb(workspaceRoot);
    if (!db || !(await db.ensureReady())) {
        console.warn(...);
        return false;
    }
    const epic = await db.getPlanByPlanId(epicSessionId);
    if (!epic || !epic.isEpic) {
        console.warn(...);
        return false;
    }
    const currentColumn = this._normalizeLegacyKanbanColumn(epic.kanbanColumn) || '';
    if (currentColumn === 'ORCHESTRATING') {
        // Idempotent: epic is already in ORCHESTRATING. Still refresh in case the
        // webview's column state is stale (the bug we're fixing). The signature reset
        // ensures updateColumns is re-sent.
        this._lastColumnsSignature = null;
        await this._refreshBoard(workspaceRoot);
        return true;
    }
    try {
        let moved = false;
        if (epic.sessionId) {
            moved = await this.moveCardToColumn(workspaceRoot, epic.sessionId, 'ORCHESTRATING');
        } else if (epic.planFile) {
            moved = await this.moveCardToColumnByPlanFile(workspaceRoot, epic.planFile, 'ORCHESTRATING');
        }
        if (!moved) {
            console.warn(`[KanbanProvider] markEpicOrchestrating: move to ORCHESTRATING returned false for ${epicSessionId}`);
        }
        this._lastColumnsSignature = null;
        await this._refreshBoard(workspaceRoot);
        return moved;
    } catch (err) {
        console.warn(`[KanbanProvider] markEpicOrchestrating: teleport to ORCHESTRATING failed for ${epicSessionId}: ${err}`);
        return false;
    }
}
```

#### Part C — Backend: use return value in handler to fix misleading status message (copy mode)

**File**: `src/services/KanbanProvider.ts`

In the `orchestrateEpic` case handler (around line 7091), update the copy-mode path to use the `moved` return value:

```typescript
if (mode === 'copy') {
    // Copy path must teleport explicitly (send path already did above).
    const moved = await this.markEpicOrchestrating(wsRoot, epicId);
    const statusMsg = mode === 'send'
        ? (sent ? 'Orchestrator prompt sent and copied. Epic moved to ORCHESTRATING.' : 'No orchestrator terminal — prompt copied. Epic moved to ORCHESTRATING.')
        : (moved
            ? 'Orchestrator prompt copied. Epic moved to ORCHESTRATING.'
            : 'Orchestrator prompt copied. Could not move epic — check console for details.');
    // ... (rest of handler unchanged)
}
```

**Note**: The `statusMsg` declaration must be moved inside the `if (mode === 'copy')` block (or restructured) so that `moved` is in scope. The `send` mode path's status message remains unchanged for now (see Fix 4E).

#### Part D — Webview safety net: handle ORCHESTRATING in `renderBoard` even without prior `updateColumns`

**File**: `src/webview/kanban.html`

In the `renderBoard` function, before the `displayCards.forEach` loop (after line 5101, before line 5103), add a guard that dynamically inserts ORCHESTRATING into `columns` and `buckets` if any card has that column:

```js
// Safety net: if any card is in ORCHESTRATING but it's not in columns yet,
// add it now so the card isn't silently dropped to CREATED.
const hasOrchestrating = displayCards.some(card => (card._effectiveColumn || card.column) === 'ORCHESTRATING');
if (hasOrchestrating && !columns.includes('ORCHESTRATING')) {
    // Find the column definition if available, else create a minimal stub.
    const orchDef = columnDefinitions.find(d => d.id === 'ORCHESTRATING') || {
        id: 'ORCHESTRATING', label: 'Orchestrator', order: 250,
        kind: 'review', source: 'built-in', autobanEnabled: false,
        dragDropMode: 'cli', hideWhenNoAgent: true, epicOnly: true
    };
    // Insert ORCHESTRATING at the correct sort position.
    const insertAt = columnDefinitions.findIndex(d => d.order > orchDef.order);
    if (insertAt === -1) {
        columnDefinitions.push(orchDef);
        columns.push('ORCHESTRATING');
    } else {
        columnDefinitions.splice(insertAt, 0, orchDef);
        columns.splice(insertAt, 0, 'ORCHESTRATING');
    }
    buckets['ORCHESTRATING'] = [];
    renderColumns(); // re-render column headers
}
```

This is a safety net only — it should never be needed if Fix 4A works, but it prevents silent data loss when the column is missing from the current column set.

#### Part E — Backend: propagate `moved` result through `dispatchEpicOrchestration` (send mode)

**File**: `src/services/KanbanProvider.ts`

`dispatchEpicOrchestration` (line 3171) currently calls `markEpicOrchestrating` internally (line 3186) but discards the result. Update it to capture and return `moved` so the handler can produce an accurate status message for the `send` mode path:

```typescript
public async dispatchEpicOrchestration(
    workspaceRoot: string,
    epicSessionId: string
): Promise<{ assembled: { prompt: string; epicTopic: string; subtaskCount: number; totalSubtasks: number } | null; sent: boolean; moved: boolean }> {
    const assembled = await this.buildEpicOrchestrationPrompt(workspaceRoot, epicSessionId);
    if (!assembled) { return { assembled: null, sent: false, moved: false }; }
    let sent = false;
    if (this._taskViewerProvider) {
        sent = await this._taskViewerProvider.dispatchCustomPromptToRole('orchestrator', assembled.prompt, workspaceRoot);
    }
    let moved = false;
    try {
        moved = await this.markEpicOrchestrating(workspaceRoot, epicSessionId);
    } catch (teleportErr) {
        console.warn(`[KanbanProvider] dispatchEpicOrchestration: teleport to ORCHESTRATING failed (prompt was still dispatched): ${teleportErr}`);
    }
    return { assembled, sent, moved };
}
```

Then update the handler (around line 7077) to use `res.moved`:

```typescript
if (mode === 'send') {
    const res = await this.dispatchEpicOrchestration(wsRoot, epicId);
    assembled = res.assembled;
    sent = res.sent;
    moved = res.moved;  // ← NEW: track move success for send mode
} else {
    assembled = await this.buildEpicOrchestrationPrompt(wsRoot, epicId);
}
```

And update the status message to account for `moved` in both modes. Declare `let moved = false;` before the if/else and set it in both branches, then use it in the status message:

```typescript
let moved = false;
if (mode === 'send') {
    const res = await this.dispatchEpicOrchestration(wsRoot, epicId);
    assembled = res.assembled;
    sent = res.sent;
    moved = res.moved;
} else {
    assembled = await this.buildEpicOrchestrationPrompt(wsRoot, epicId);
}
// ... (assembled null check, clipboard write) ...
if (mode === 'copy') {
    moved = await this.markEpicOrchestrating(wsRoot, epicId);
}
const statusMsg = mode === 'send'
    ? (sent && moved ? 'Orchestrator prompt sent and copied. Epic moved to ORCHESTRATING.'
        : sent ? 'Orchestrator prompt sent and copied. Could not move epic — check console for details.'
        : moved ? 'No orchestrator terminal — prompt copied. Epic moved to ORCHESTRATING.'
        : 'No orchestrator terminal — prompt copied. Could not move epic — check console for details.')
    : (moved
        ? 'Orchestrator prompt copied. Epic moved to ORCHESTRATING.'
        : 'Orchestrator prompt copied. Could not move epic — check console for details.');
```

---

## Implementation Order

1. Fix 1 (emoji) — trivial string changes
2. Fix 2 (purple CSS) — add new CSS rule
3. Fix 3 (immediate feedback) — add two lines to click handler
4. Fix 4 parts A+B (backend `_lastColumnsSignature` reset + return value + idempotent refresh)
5. Fix 4 part C (handler status message accuracy — copy mode)
6. Fix 4 part E (dispatchEpicOrchestration `moved` propagation — send mode)
7. Fix 4 part D (webview safety net in `renderBoard`)

## Files Modified

- `src/webview/kanban.html` — emoji removal (3x), purple CSS, click feedback, `renderBoard` safety net
- `src/services/KanbanProvider.ts` — `markEpicOrchestrating` return value + `_lastColumnsSignature` reset + idempotent refresh, `dispatchEpicOrchestration` `moved` propagation, handler status message (both modes)
- `src/services/PlanningPanelProvider.ts` — `orchestrateEpic` handler now propagates `moved` in both `send` and `copy` paths (reviewer fix for MAJOR-2)

## Verification Plan

### Automated Tests

Per session directives: compilation and automated tests are skipped. The test suite will be run separately by the user.

### Manual UAT Checklist

- [ ] Orchestrate button has NO emoji — label is just "Orchestrate"
- [ ] Orchestrate button is purple/violet and visually distinguishable from other card-btn buttons
- [ ] Clicking Orchestrate immediately disables the button and shows "Orchestrating…"
- [ ] After ~1-2 seconds, the ORCHESTRATING column appears in the board
- [ ] The epic card is in the ORCHESTRATING column (not CREATED)
- [ ] Status bar says "Orchestrator prompt copied. Epic moved to ORCHESTRATING." (copy mode)
- [ ] If the move fails for any reason, status bar shows a failure message (not the misleading success message)
- [ ] Clicking Orchestrate a second time on a card already in ORCHESTRATING: status message says it was copied, card stays in ORCHESTRATING (idempotent), and the column is visible
- [ ] Send mode (if orchestrator terminal is configured): status message accurately reflects whether the move succeeded
- [ ] Send mode (if orchestrator terminal is NOT configured): status message says "No orchestrator terminal" and accurately reflects whether the move succeeded

## Recommendation

Complexity 5 → **Send to Coder**

---

## Reviewer Pass (In-Place Direct Review)

### Verification Summary

All 8 fixes (1, 2, 3, 4A–4E) verified as correctly applied against the plan requirements:

| Fix | Status | Evidence |
|-----|--------|----------|
| Fix 1 (emoji removal, 3x) | VERIFIED | No `🎯` in kanban.html; button template (line 5442) says "Orchestrate"; reset at lines 6548, 6561 |
| Fix 2 (purple CSS) | VERIFIED | `.card-btn.orchestrate` at lines 1001-1007; placed after `.card-btn.recover:hover`; correct specificity (0,2,0 > 0,1,0) |
| Fix 3 (immediate feedback) | VERIFIED | Click handler (lines 5324-5340) sets `btn.disabled = true` and `btn.textContent = 'Orchestrating…'` before postMessage |
| Fix 4A (signature reset) | VERIFIED | `_lastColumnsSignature = null` at line 3217 (idempotent) and line 3231 (main path), both before `_refreshBoard` |
| Fix 4B (return boolean) | VERIFIED | `markEpicOrchestrating` returns `Promise<boolean>` (line 3198); returns `false` on all error/early-exit paths, `true`/`moved` on success |
| Fix 4C (status message, copy mode) | VERIFIED | Handler (lines 7084-7111) declares `let moved = false`, sets it in both branches, uses unified ternary for both modes — cleaner than plan's suggestion |
| Fix 4D (webview safety net) | VERIFIED + FIXED | Safety net at lines 5111-5130; placed after `buckets` init (5095), before `forEach` (5132); `renderColumns()` does NOT clobber `buckets`; **stub was missing `role: 'orchestrator'` — fixed by reviewer** |
| Fix 4E (dispatch moved propagation) | VERIFIED + FIXED | `dispatchEpicOrchestration` (lines 3171-3192) returns `moved`; KanbanProvider handler (7087-7090) consumes it; **PlanningPanelProvider handler was NOT consuming it — fixed by reviewer** |

### Adversarial Findings

**MAJOR-1 (FIXED): Safety net stub missing `role: 'orchestrator'`**
- File: `src/webview/kanban.html:5116` (was line 5116 before fix)
- The backend's authoritative definition (`src/services/agentConfig.ts:117`) includes `role: 'orchestrator'`. The stub was missing it, causing `columnToRole()` (line 4931) to return `null` and drag-drop/assigned-agent consumers (lines 8691, 8864) to misbehave when the safety net path is active.
- **Fix applied**: Added `role: 'orchestrator'` to the stub object literal.

**MAJOR-2 (FIXED): `PlanningPanelProvider.orchestrateEpic` ignored `moved` return value**
- File: `src/services/PlanningPanelProvider.ts:3269, 3284`
- The Epics tab has its own `orchestrateEpic` handler. It destructured `{ assembled, sent }` from `dispatchEpicOrchestration` (dropping `moved`) and discarded `markEpicOrchestrating`'s boolean return, posting `ok: true` unconditionally. This is the exact bug class the plan's Adversarial Synthesis (line 56) flagged and Fix 4E was meant to address — but only the KanbanProvider caller was fixed.
- **Fix applied**: Both `send` and `copy` paths now capture `moved` and include it in the `epicOrchestrationResult` message.

**NIT-1 (DEFERRED): Idempotent path returns `true`, status says "moved"**
- File: `src/services/KanbanProvider.ts:3219`
- The idempotent path returns `true` (epic IS in ORCHESTRATING), causing status to say "Epic moved to ORCHESTRATING" even though no move occurred. The plan's UAT checklist (line 365) explicitly expects this behavior. Semantically defensible. No action.

**NIT-2 (INFORMATIONAL): Implementation diverged from plan's statusMsg structure**
- The plan (line 232) suggested moving `statusMsg` inside the `if (mode === 'copy')` block. The actual implementation (lines 7084-7111) uses a unified `let moved = false` + dual-branch ternary — cleaner and handles both modes symmetrically. Good divergence. No action.

**NIT-3 (DEFERRED): Extra full board render on every orchestration**
- Fix 4A forces `updateColumns` unconditionally, causing an extra `renderBoard` via `lastBoardSignature` reset. Plan already documented this (line 68) and assessed impact as negligible. Agreed. No action.

### Validation Results

- **Compilation**: Skipped per session directives.
- **Automated tests**: Skipped per session directives. Test suite to be run separately by user.
- **Static verification**: All 8 fixes traced to correct code locations and confirmed semantically correct. Two MAJOR findings fixed and re-verified by re-reading the modified sections.

### Remaining Risks

1. **Race condition (low)**: `refreshWithData` has multiple `await` points between `updateColumns` and `updateBoard`. A concurrent file-watcher refresh could interleave messages. Fix 4A mitigates (forces signature reset) but does not eliminate interleaving. Low risk — orchestration is user-initiated, unlikely to coincide with a file-watcher event for the same workspace.
2. **Button state flicker (minor UX)**: Fix 3's `btn.disabled = true` is lost if the board re-renders between click and `epicOrchestrationResult`. The `epicOrchestrationResult` handler uses `querySelector` to find the new button, so it resets correctly. Minor flicker, not functional.
3. **Epics tab `ok: true` semantics**: The `ok` field in `epicOrchestrationResult` means "prompt assembled and copied" — `ok: true` when move failed is semantically correct from the prompt perspective. The `moved` field (now propagated) carries the move-success signal for any future UI that wants to surface it.
