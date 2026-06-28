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

Locate the `.card-btn` CSS block (around line 971). Insert a new rule after the existing `.card-btn.recover:hover` rule:

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

Change signature from `Promise<void>` to `Promise<boolean>`, return `moved` (or `false` on early exits):

```typescript
public async markEpicOrchestrating(...): Promise<boolean> {
    ...
    if (!epic || !epic.isEpic) {
        console.warn(...);
        return false;
    }
    if (currentColumn === 'ORCHESTRATING') {
        return true; // already there, idempotent
    }
    try {
        let moved = false;
        ...
        if (!moved) {
            console.warn(...);
        }
        this._lastColumnsSignature = null;
        await this._refreshBoard(workspaceRoot);
        return moved;
    } catch (err) {
        ...
        return false;
    }
}
```

#### Part C — Backend: use return value in handler to fix misleading status message

**File**: `src/services/KanbanProvider.ts`

In the `orchestrateEpic` case handler (around line 7091), update to:

```typescript
const moved = await this.markEpicOrchestrating(wsRoot, epicId);
const statusMsg = mode === 'send'
    ? (sent ? 'Orchestrator prompt sent and copied. Epic moved to ORCHESTRATING.' : 'No orchestrator terminal — prompt copied. Epic moved to ORCHESTRATING.')
    : (moved
        ? 'Orchestrator prompt copied. Epic moved to ORCHESTRATING.'
        : 'Orchestrator prompt copied. Could not move epic — check console for details.');
```

#### Part D — Webview safety net: handle ORCHESTRATING in `renderBoard` even without prior `updateColumns`

**File**: `src/webview/kanban.html`

In the `renderBoard` function, before the `displayCards.forEach` loop, add a guard that dynamically inserts ORCHESTRATING into `columns` and `buckets` if any card has that column:

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

---

## Implementation Order

1. Fix 1 (emoji) — trivial string changes
2. Fix 2 (purple CSS) — add new CSS rule
3. Fix 3 (immediate feedback) — add two lines to click handler
4. Fix 4 parts A+B (backend `_lastColumnsSignature` reset + return value)
5. Fix 4 part C (handler status message accuracy)
6. Fix 4 part D (webview safety net in `renderBoard`)

## Files Modified

- `src/webview/kanban.html` — emoji removal (3x), purple CSS, click feedback, `renderBoard` safety net
- `src/services/KanbanProvider.ts` — `markEpicOrchestrating` return value + `_lastColumnsSignature` reset, handler status message

## UAT Checklist

- [ ] Orchestrate button has NO emoji — label is just "Orchestrate"
- [ ] Orchestrate button is purple/violet and visually distinguishable from other card-btn buttons
- [ ] Clicking Orchestrate immediately disables the button and shows "Orchestrating…"
- [ ] After ~1-2 seconds, the ORCHESTRATING column appears in the board
- [ ] The epic card is in the ORCHESTRATING column (not CREATED)
- [ ] Status bar says "Orchestrator prompt copied. Epic moved to ORCHESTRATING."
- [ ] If the move fails for any reason, status bar shows a failure message (not the misleading success message)
- [ ] Clicking Orchestrate a second time on a card already in ORCHESTRATING: status message says it was copied, card stays in ORCHESTRATING (idempotent)
