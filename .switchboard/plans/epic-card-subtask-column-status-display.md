# Enhancement: Epic Cards Should Display Subtask Column Status Breakdown

## Goal

When an orchestrator agent looks at an epic card on the kanban board, it should see a breakdown of where each subtask currently sits — e.g., "2 CREATED, 1 PLAN REVIEWED" — so the agent knows what work remains without opening the epic file.

### Problem

The current epic badge (line 5350 of `kanban.html`) only shows a count:
```javascript
const epicBadge = card.isEpic ? `<span class="epic-badge">EPIC · ${card.subtaskCount || 0} subtask${(card.subtaskCount || 0) !== 1 ? 's' : ''}</span>` : '';
```

This tells the agent how many subtasks exist but not their status. An epic with 5 subtasks all in `PLAN REVIEWED` looks identical to an epic with 5 subtasks all in `CREATED`. The orchestrator can't tell whether the epic is ready to advance or still needs work.

### Root Cause

The card data sent to the webview (`KanbanCard` type) includes `isEpic`, `epicId`, and `subtaskCount` but does not include per-subtask column information. The board refresh in `_refreshBoardImpl` (KanbanProvider.ts) builds `subtaskCountMap` by counting rows with `epicId` set, but does not break down counts by column.

## Metadata

**Complexity:** 3
**Tags:** feature, frontend, kanban, epic, ui

## Files to Modify

### 1. `src/services/KanbanProvider.ts`

**a. Add `subtaskColumnBreakdown` to the card data** — in `_refreshBoardImpl` (around line 2140), after building `subtaskCountMap`, also build a per-epic column breakdown:

```typescript
// After subtaskCountMap2 construction (line ~2143):
const subtaskColumnMap = new Map<string, Record<string, number>>();
for (const row of allRows2) {
    if (row.epicId && !row.isEpic) {
        const breakdown = subtaskColumnMap.get(row.epicId) || {};
        const col = row.kanbanColumn || 'CREATED';
        breakdown[col] = (breakdown[col] || 0) + 1;
        subtaskColumnMap.set(row.epicId, breakdown);
    }
}
```

**b. Include the breakdown in the card object** — where `subtaskCount` is set (lines ~1242, ~1259, ~2161, ~2180):

```typescript
subtaskCount: rec.isEpic ? (subtaskCountMap2.get(rec.planId) || 0) : undefined,
subtaskColumnBreakdown: rec.isEpic ? (subtaskColumnMap.get(rec.planId) || {}) : undefined,
```

### 2. `src/webview/kanban.html`

**a. Update the epic badge** (line 5350) to show the column breakdown:

```javascript
// Before:
const epicBadge = card.isEpic ? `<span class="epic-badge">EPIC · ${card.subtaskCount || 0} subtask${(card.subtaskCount || 0) !== 1 ? 's' : ''}</span>` : '';

// After:
let epicBadge = '';
if (card.isEpic) {
    const count = card.subtaskCount || 0;
    const breakdown = card.subtaskColumnBreakdown || {};
    // Build a compact summary: "2 CREATED, 1 PLAN REVIEWED"
    // Only show non-zero columns, ordered by column ordinal
    const columnOrder = ['CREATED', 'IN PROGRESS', 'CODE REVIEWED', 'PLAN REVIEWED', 'REVIEWED', 'DONE', 'COMPLETED'];
    const parts = columnOrder
        .filter(col => breakdown[col] > 0)
        .map(col => `${breakdown[col]} ${col}`);
    const breakdownStr = parts.length > 0 ? ` · ${parts.join(', ')}` : '';
    epicBadge = `<span class="epic-badge">EPIC · ${count} subtask${count !== 1 ? 's' : ''}${breakdownStr}</span>`;
}
```

**b. Add CSS for the breakdown text** — the badge may get long. Add styling to keep it readable:

```css
.epic-badge {
    /* existing styles stay */
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
```

**c. Update `buildBoardSignature`** (line 4444) to include the breakdown so signature-based refresh detection picks up subtask column changes:

```javascript
// Before:
.map(card => `${card.workspaceRoot || ''}|${card.planId || card.sessionId || ''}|${card.column}|${card.topic || ''}|${card.planFile || ''}|${card.complexity || 'Unknown'}|${card.lastActivity || ''}|${card.isEpic ? '1' : '0'}|${card.subtaskCount || 0}|${card.epicId || ''}`)

// After:
.map(card => `${card.workspaceRoot || ''}|${card.planId || card.sessionId || ''}|${card.column}|${card.topic || ''}|${card.planFile || ''}|${card.complexity || 'Unknown'}|${card.lastActivity || ''}|${card.isEpic ? '1' : '0'}|${card.subtaskCount || 0}|${card.epicId || ''}|${card.isEpic ? JSON.stringify(card.subtaskColumnBreakdown || {}) : ''}`)
```

## Verification

- Create an epic with 3 subtasks in CREATED, 2 in PLAN REVIEWED → badge shows "EPIC · 5 subtasks · 3 CREATED, 2 PLAN REVIEWED"
- Move one subtask from CREATED to PLAN REVIEWED → badge updates to "EPIC · 5 subtasks · 2 CREATED, 3 PLAN REVIEWED" after board refresh
- Epic with all subtasks in the same column → badge shows "EPIC · 3 subtasks · 3 PLAN REVIEWED"
- Epic with 0 subtasks → badge shows "EPIC · 0 subtasks" (no breakdown)
- Non-epic cards → no badge, no breakdown (unchanged)
