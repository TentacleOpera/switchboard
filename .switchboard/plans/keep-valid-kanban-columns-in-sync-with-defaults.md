# Keep VALID_KANBAN_COLUMNS in Sync with DEFAULT_KANBAN_COLUMNS

## Goal

`VALID_KANBAN_COLUMNS` in `KanbanDatabase.ts` is a manually maintained set of 9 column names that has drifted out of sync with the canonical `DEFAULT_KANBAN_COLUMNS` array in `agentConfig.ts`, which has 14. Seven built-in columns are missing from the validation set and are silently excluded from `kanban-board.md` export. `ClickUpSyncService.ts` has its own hardcoded copy that has the same drift problem.

### Missing from VALID_KANBAN_COLUMNS

| Column | order | hideWhenNoAgent |
|---|---|---|
| RESEARCHER | 90 | yes |
| CODE_RESEARCHER | 95 | yes |
| SPLITTER | 110 | yes |
| INTERN CODED | 200 | yes |
| ORCHESTRATING | 250 | yes |
| ACCEPTANCE TESTED | 350 | yes |
| TICKET UPDATER | 9000 | yes |

### Extra entries in VALID_KANBAN_COLUMNS not in DEFAULT_KANBAN_COLUMNS

- **CODED** — present in `VALID_KANBAN_COLUMNS`, absent from `DEFAULT_KANBAN_COLUMNS`. Likely deprecated. Must be kept in the valid set permanently for backward compat (existing user DBs may have plans in this column).
- **BACKLOG** — not in `DEFAULT_KANBAN_COLUMNS`, dynamically added by `PlanningPanelProvider.ts`. Must also be kept.

### Root cause

`DEFAULT_KANBAN_COLUMNS` is a private `const` in `agentConfig.ts` — nothing can import it. Each consumer maintains its own copy, which drifts whenever a column is added or removed from the canonical definition.

---

## Implementation Steps

### 1. Export DEFAULT_KANBAN_COLUMNS from agentConfig.ts

Change `const DEFAULT_KANBAN_COLUMNS` to `export const DEFAULT_KANBAN_COLUMNS` (line 107). No other changes to that file.

### 2. Derive VALID_KANBAN_COLUMNS in KanbanDatabase.ts

Replace the hardcoded `Set` with one derived at module load time:

```typescript
import { DEFAULT_KANBAN_COLUMNS } from './agentConfig';

export const VALID_KANBAN_COLUMNS = new Set([
    ...DEFAULT_KANBAN_COLUMNS.map(c => c.id),
    'BACKLOG',  // dynamically added by PlanningPanelProvider, not in DEFAULT_KANBAN_COLUMNS
    'CODED',    // deprecated column — kept for backward compat with existing user DBs
]);
```

This makes `VALID_KANBAN_COLUMNS` automatically include any future columns added to `DEFAULT_KANBAN_COLUMNS`.

### 3. Update exportStateToFile() column iteration source

`exportStateToFile()` currently seeds its columns map from `VALID_KANBAN_COLUMNS` (a `Set`, unordered). Replace with `DEFAULT_KANBAN_COLUMNS` sorted by `order`, so the export reflects the correct visual order:

```typescript
const orderedColumns = [...DEFAULT_KANBAN_COLUMNS].sort((a, b) => a.order - b.order);
const columns = new Map<string, KanbanPlanRecord[]>();
for (const col of orderedColumns) {
    columns.set(col.id, []);
}
// Also seed BACKLOG and CODED buckets for backward compat
columns.set('BACKLOG', []);
columns.set('CODED', []);
```

Any plans in columns not covered by this map fall into the custom-column pass (per the sibling plan `split-kanban-board-into-per-column-files.md`).

### 4. Update ClickUpSyncService.ts

Lines 134-137 have a hardcoded 9-column array with a comment saying it mirrors `VALID_KANBAN_COLUMNS`. Replace with a derived set using the same import:

```typescript
import { DEFAULT_KANBAN_COLUMNS } from './agentConfig';
const SWITCHBOARD_KANBAN_COLUMNS = new Set([
    ...DEFAULT_KANBAN_COLUMNS.map(c => c.id),
    'BACKLOG',
    'CODED',
]);
```

Update any downstream usages in that file accordingly.

---

## What Stays the Same

- The `SAFE_COLUMN_NAME_RE` fallback in move/update operations — still needed for user-defined custom columns that won't appear in `DEFAULT_KANBAN_COLUMNS`.
- All database schema — no column renames, no migrations needed.
- `BACKLOG` and `CODED` remain valid forever via the explicit additions.

---

## Relationship to Sibling Plan

`split-kanban-board-into-per-column-files.md` should be implemented after this plan — it relies on `exportStateToFile()` iterating the correct full column list, which this plan fixes first.

---

## Metadata

**Complexity:** 5
**Tags:** backend, refactor, reliability
