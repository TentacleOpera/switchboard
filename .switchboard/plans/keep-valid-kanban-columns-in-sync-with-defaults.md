# Keep VALID_KANBAN_COLUMNS in Sync with DEFAULT_KANBAN_COLUMNS

## Goal

`VALID_KANBAN_COLUMNS` in `KanbanDatabase.ts` is a manually maintained set of 9 column names that has drifted out of sync with the canonical `DEFAULT_KANBAN_COLUMNS` array in `agentConfig.ts`, which has 14. Seven built-in columns are missing from the validation set and are silently excluded from `kanban-board.md` export. `ClickUpSyncService.ts` has its own hardcoded copy (`CANONICAL_COLUMNS`) that has the same drift problem, and `LinearSyncService.ts` re-exports it for its own column-mapping setup flow.

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

`DEFAULT_KANBAN_COLUMNS` is a private `const` in `agentConfig.ts` (line 107) — nothing can import it. Each consumer maintains its own copy, which drifts whenever a column is added or removed from the canonical definition.

---

## Metadata

**Tags:** backend, refactor, reliability
**Complexity:** 5

---

## User Review Required

Yes — before implementation, the user should confirm:

1. **`CANONICAL_COLUMNS` name preservation**: The original plan proposed renaming `CANONICAL_COLUMNS` to `SWITCHBOARD_KANBAN_COLUMNS` in `ClickUpSyncService.ts`. This would break 4 files that import it by name (`LinearSyncService.ts`, `clickup-sync-service.test.js`, `linear-sync-service.test.js`, `linear-regression.test.js`). The improved plan keeps the name `CANONICAL_COLUMNS` and only changes its derivation. Confirm the name should be preserved.
2. **Sibling plan ordering**: This plan should be implemented **before** `remove-context-gatherer-splitter-code-researcher-agents.md` (which removes three columns from `DEFAULT_KANBAN_COLUMNS`) and **before** `split-kanban-board-into-per-column-files.md` (which relies on `exportStateToFile()` iterating the correct full column list). If this plan is implemented first, the derivation will automatically reflect any future column additions/removals. Confirm the ordering.
3. **`CODED` column deprecation**: `CODED` is in `VALID_KANBAN_COLUMNS` but not in `DEFAULT_KANBAN_COLUMNS`. It's kept permanently for backward compat. Confirm no plans exist to actively purge `CODED` from user databases.

---

## Complexity Audit

### Routine
- Changing `const DEFAULT_KANBAN_COLUMNS` to `export const DEFAULT_KANBAN_COLUMNS` (line 107 of `agentConfig.ts`) — one keyword addition
- Replacing the hardcoded `VALID_KANBAN_COLUMNS` Set with a derived one (line 631 of `KanbanDatabase.ts`) — straightforward `new Set([...DEFAULT_KANBAN_COLUMNS.map(c => c.id), 'BACKLOG', 'CODED'])`
- Replacing the hardcoded `CANONICAL_COLUMNS` array with a derived one (line 135 of `ClickUpSyncService.ts`) — same pattern
- Updating `exportStateToFile()` to iterate `DEFAULT_KANBAN_COLUMNS` sorted by `order` instead of `VALID_KANBAN_COLUMNS` (unordered Set)

### Complex / Risky
- **Multi-consumer impact**: `CANONICAL_COLUMNS` is exported from `ClickUpSyncService.ts` and re-exported from `LinearSyncService.ts` (line 105). It's used in 3 test files for quickPick response generation (`CANONICAL_COLUMNS.map(() => ...)`). Changing the array from 9 to 16 entries changes the number of quickPick responses the tests pre-queue. The tests should self-adjust because they iterate `CANONICAL_COLUMNS` dynamically, but this needs verification.
- **Export ordering change**: `exportStateToFile()` currently iterates `VALID_KANBAN_COLUMNS` (a `Set` with insertion-order iteration: `CREATED, BACKLOG, CONTEXT GATHERER, PLAN REVIEWED, LEAD CODED, CODER CODED, CODE REVIEWED, CODED, COMPLETED`). The new code iterates `DEFAULT_KANBAN_COLUMNS` sorted by `order`, which produces a different order: `CREATED (0), CONTEXT GATHERER (50), RESEARCHER (90), CODE_RESEARCHER (95), PLAN REVIEWED (100), SPLITTER (110), LEAD CODED (180), CODER CODED (190), INTERN CODED (200), ORCHESTRATING (250), CODE REVIEWED (300), ACCEPTANCE TESTED (350), TICKET UPDATER (9000), COMPLETED (9999)`, then `BACKLOG` and `CODED` appended. This changes the heading order in `kanban-board.md` — agents that parse the file by column heading are unaffected, but any agent that assumes a specific column order would break.

---

## Edge-Case & Dependency Audit

**Race Conditions**
- None. `VALID_KANBAN_COLUMNS` and `CANONICAL_COLUMNS` are module-load-time constants. The derivation runs once at import time. No concurrent access concerns.

**Security**
- No security implications. The change affects which column names are considered valid and which columns appear in the markdown export. No new attack surface.

**Side Effects**
- `kanban-board.md` will now include headings for 7 previously-missing columns (`RESEARCHER`, `CODE_RESEARCHER`, `SPLITTER`, `INTERN CODED`, `ORCHESTRATING`, `ACCEPTANCE TESTED`, `TICKET UPDATER`). These will show `_No plans_` for workspaces with no plans in those columns. The file will be slightly larger (more headings) but plans that were previously silently dropped will now appear.
- The column heading order in `kanban-board.md` will change from insertion-order to `order`-sorted. This is a cosmetic change that makes the export match the visual board order.
- ClickUp and Linear sync setup flows will now prompt the user to map 16 columns instead of 9. This is correct — the missing columns should have been mapped all along. Existing configs with 9 mappings will continue to work (unmapped columns fall back to defaults).
- The `kanban-auto-export.test.ts` test imports `VALID_KANBAN_COLUMNS` and iterates it (line 44) to check that all columns appear as `## {col}` headings. After this change, the test will check for 16 headings instead of 9. Since `exportStateToFile()` will also produce 16 headings, the test should self-adjust and pass. **No manual test changes needed.**
- The `builtin-role-dispatch-coverage.test.js` test uses `tsSource.indexOf('const DEFAULT_KANBAN_COLUMNS')` (line 58) to find the definition in source text. Adding `export` produces `export const DEFAULT_KANBAN_COLUMNS`, which still contains the substring `const DEFAULT_KANBAN_COLUMNS`. The test self-adjusts. **No manual test changes needed.**

**Dependencies & Conflicts**
- **`remove-context-gatherer-splitter-code-researcher-agents.md`**: That plan removes `CODE_RESEARCHER`, `SPLITTER`, and `CONTEXT GATHERER` from `DEFAULT_KANBAN_COLUMNS`. If implemented after this plan, the derived `VALID_KANBAN_COLUMNS` will automatically lose those three columns (11 + `BACKLOG` + `CODED` = 13 entries). If implemented before this plan, the hardcoded set already lacks them. **Recommended ordering: this plan first, then removal plan.**
- **`split-kanban-board-into-per-column-files.md`**: That plan relies on `exportStateToFile()` iterating the correct full column list. If this plan is implemented first, the per-column files will cover all 16 columns. **Recommended ordering: this plan first, then split plan.**
- `LinearSyncService.ts` imports `CANONICAL_COLUMNS` from `ClickUpSyncService.ts` (line 6) and re-exports it (line 105). The re-export will automatically reflect the new derivation. No changes needed to `LinearSyncService.ts` itself.
- 3 test files (`clickup-sync-service.test.js`, `linear-sync-service.test.js`, `linear-regression.test.js`) use `CANONICAL_COLUMNS.map()` to pre-queue quickPick responses. The `.map()` dynamically generates one response per column, so the tests self-adjust to the new column count. **No manual test changes needed — but verify the tests still pass.**

---

## Dependencies

- No session dependencies. This plan is self-contained.
- **Should be implemented before**: `split-kanban-board-into-per-column-files.md` (depends on correct column iteration), `remove-context-gatherer-splitter-code-researcher-agents.md` (column removal auto-reflects in derived set).

---

## Adversarial Synthesis

Key risks: (1) the original plan proposed renaming `CANONICAL_COLUMNS` to `SWITCHBOARD_KANBAN_COLUMNS`, which would break 4 files that import it by name — the rename adds risk for zero benefit; (2) the plan completely missed `LinearSyncService.ts` which imports and re-exports `CANONICAL_COLUMNS`, and 3 test files that use it dynamically; (3) the export heading order change (insertion-order → `order`-sorted) could break agents that assume a specific column sequence. Mitigations: keep the `CANONICAL_COLUMNS` name, document all consumers, and note the ordering change as a known side effect.

---

## Proposed Changes

### `src/services/agentConfig.ts` (Step 1)

**Context:** `DEFAULT_KANBAN_COLUMNS` is the canonical column definition array. It's currently private (`const`), preventing any consumer from importing it.

**Implementation:** Change line 107 from:
```typescript
const DEFAULT_KANBAN_COLUMNS: KanbanColumnDefinition[] = [
```
to:
```typescript
export const DEFAULT_KANBAN_COLUMNS: KanbanColumnDefinition[] = [
```

No other changes to this file.

**Edge Cases:** The `builtin-role-dispatch-coverage.test.js` test searches for `'const DEFAULT_KANBAN_COLUMNS'` in the source text (line 58). Since `export const DEFAULT_KANBAN_COLUMNS` contains this substring, the test continues to work without modification.

### `src/services/KanbanDatabase.ts` (Step 2)

**Context:** `VALID_KANBAN_COLUMNS` (line 631) is a hardcoded `Set` of 9 column names. It's used for column validation in `updateColumnByPlanFile` (line 1434), `movePlanByPlanFile` (line 1491), `updateColumnWithEpicCascadeByPlanId` (line 3833), `cascadeEpicByPlanId` (line 3884), and for column iteration in `exportStateToFile()` (line 5466).

**Implementation:** Add an import at the top of the file and replace the hardcoded Set:

```typescript
import { DEFAULT_KANBAN_COLUMNS } from './agentConfig';

export const VALID_KANBAN_COLUMNS = new Set([
    ...DEFAULT_KANBAN_COLUMNS.map(c => c.id),
    'BACKLOG',  // dynamically added by PlanningPanelProvider, not in DEFAULT_KANBAN_COLUMNS
    'CODED',    // deprecated column — kept for backward compat with existing user DBs
]);
```

This makes `VALID_KANBAN_COLUMNS` automatically include any future columns added to `DEFAULT_KANBAN_COLUMNS`. After this change, the set will contain 16 entries (14 from `DEFAULT_KANBAN_COLUMNS` + `BACKLOG` + `CODED`).

**Edge Cases:** All validation sites use `VALID_KANBAN_COLUMNS.has(newColumn) || SAFE_COLUMN_NAME_RE.test(newColumn)` — the `SAFE_COLUMN_NAME_RE` fallback still handles custom columns. The expanded set simply allows more built-in column names to pass validation without needing the regex fallback. No behavior change for custom columns.

### `src/services/KanbanDatabase.ts` — Update `exportStateToFile()` (Step 3)

**Context:** `exportStateToFile()` (line 5451) currently seeds its `columns` map from `VALID_KANBAN_COLUMNS` (line 5466), which is a `Set` with insertion-order iteration. This produces columns in the order they were added to the Set, not in the visual board order.

**Implementation:** Replace the column seeding (lines 5465–5468) with `DEFAULT_KANBAN_COLUMNS` sorted by `order`:

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

Any plans in columns not covered by this map fall into the custom-column pass (per the sibling plan `split-kanban-board-into-per-column-files.md`, if implemented).

**Edge Cases:** The heading order in `kanban-board.md` changes from insertion-order to `order`-sorted. This is a cosmetic improvement — the export will match the visual board order. Agents that parse by column heading name (not by position) are unaffected.

### `src/services/ClickUpSyncService.ts` (Step 4)

**Context:** `CANONICAL_COLUMNS` (line 135) is a hardcoded 9-column array with a comment saying it mirrors `VALID_KANBAN_COLUMNS`. It's exported and used by `LinearSyncService.ts` (import at line 6, re-export at line 105, usage at line 1777) and 3 test files.

**Implementation:** Add an import and replace the hardcoded array with a derived one. **Keep the name `CANONICAL_COLUMNS`** — do NOT rename to `SWITCHBOARD_KANBAN_COLUMNS` as the original plan proposed. Renaming would break 4 files that import it by name for zero benefit.

```typescript
import { DEFAULT_KANBAN_COLUMNS } from './agentConfig';

// Canonical Switchboard kanban columns (derived from DEFAULT_KANBAN_COLUMNS + legacy columns)
export const CANONICAL_COLUMNS = [
    ...DEFAULT_KANBAN_COLUMNS.map(c => c.id),
    'BACKLOG',
    'CODED',
];
```

**Note:** `CANONICAL_COLUMNS` is an array (not a Set) because `LinearSyncService.ts` iterates it with `.map()` for quickPick response generation (line 1777). The array format is preserved.

**Edge Cases:**
- `LinearSyncService.ts` imports `CANONICAL_COLUMNS` by name (line 6: `import { CANONICAL_COLUMNS } from './ClickUpSyncService'`). Keeping the name means zero changes to `LinearSyncService.ts`.
- `LinearSyncService.ts` re-exports it (line 105: `export { CANONICAL_COLUMNS }`). The re-export automatically reflects the new derivation.
- 3 test files import `CANONICAL_COLUMNS` dynamically and use `.map()` to generate quickPick responses. The tests self-adjust to the new column count (16 instead of 9). **No manual test changes needed — but verify the tests still pass.**
- The ClickUp and Linear sync setup flows will now prompt users to map 16 columns instead of 9. Existing configs with 9 mappings continue to work (unmapped columns fall back to defaults or are skipped).

---

## What Stays the Same

- The `SAFE_COLUMN_NAME_RE` fallback in move/update operations — still needed for user-defined custom columns that won't appear in `DEFAULT_KANBAN_COLUMNS`.
- All database schema — no column renames, no migrations needed.
- `BACKLOG` and `CODED` remain valid forever via the explicit additions.
- The `CANONICAL_COLUMNS` export name — preserved to avoid breaking consumers.
- The `builtin-role-dispatch-coverage.test.js` test — self-adjusts (substring search still finds `const DEFAULT_KANBAN_COLUMNS` within `export const DEFAULT_KANBAN_COLUMNS`).
- The `kanban-auto-export.test.ts` test — self-adjusts (imports and iterates `VALID_KANBAN_COLUMNS` dynamically).

---

## Relationship to Sibling Plans

- **`remove-context-gatherer-splitter-code-researcher-agents.md`**: Should be implemented **after** this plan. It removes three columns from `DEFAULT_KANBAN_COLUMNS`. With the derivation in place, `VALID_KANBAN_COLUMNS` and `CANONICAL_COLUMNS` will automatically lose those three columns — no manual updates needed to the derived sets.
- **`split-kanban-board-into-per-column-files.md`**: Should be implemented **after** this plan. It relies on `exportStateToFile()` iterating the correct full column list, which this plan fixes first.

---

## Verification Plan

### Automated Tests

Per session directives, automated tests are **not run** in this planning pass — the suite will be run separately by the user. The following describes what to verify when implementation lands:

- **`kanban-auto-export.test.ts`**: The test at line 24 ("Markdown file is created with header and all VALID_KANBAN_COLUMNS") iterates `VALID_KANBAN_COLUMNS` and checks for `## {col}` headings. After this change, it will check for 16 headings. Verify the test passes — if `exportStateToFile()` produces all 16 headings, it will.
- **`builtin-role-dispatch-coverage.test.js`**: Verify the `extractDefaultKanbanRoles` function still finds `DEFAULT_KANBAN_COLUMNS` after the `export` keyword is added. The `indexOf('const DEFAULT_KANBAN_COLUMNS')` search should still match.
- **`clickup-sync-service.test.js`**: The test uses `CANONICAL_COLUMNS.map()` to generate quickPick responses. With 16 columns instead of 9, the test generates 16 responses. Verify the setup flow consumes all 16.
- **`linear-sync-service.test.js`** and **`linear-regression.test.js`**: Same pattern — verify the quickPick response generation works with 16 columns.
- **Grep verification**: After all edits, run `grep -rn "VALID_KANBAN_COLUMNS\|CANONICAL_COLUMNS" src/` — verify no hardcoded column lists remain that duplicate the canonical definition.

### Manual Verification

1. Create a plan in a previously-missing column (e.g., `RESEARCHER`) — confirm it now appears in `kanban-board.md` under the correct heading.
2. Open the ClickUp sync setup flow — confirm it prompts for 16 column mappings instead of 9.
3. Open the Linear sync setup flow — confirm the same.
4. Check the heading order in `kanban-board.md` — confirm columns appear in `order`-sorted sequence (CREATED first, COMPLETED last), not in the old insertion order.

---

## Recommendation

Complexity 5 → **Send to Coder**
