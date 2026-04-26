```markdown
# Fix Kanban Column Advancement - Switchboard State Override

## Goal
Disable the "## Switchboard State" text block synchronization entirely. The file-based state mechanism is overriding the authoritative database state, creating race conditions that prevent plans from advancing between Kanban columns.

## Metadata
**Tags:** bugfix, reliability, workflow, database
**Complexity:** 3
**Repo:** src

## User Review Required
> [!WARNING]
> By completely disabling file-based Kanban state, the "Reset Database" command will no longer be able to remember which column a plan was in (e.g., `CODED`, `REVIEWED`). All plans will default back to the `CREATED` column upon a hard database reset. This is standard behavior for a reset, but worth noting.

## Complexity Audit
### Routine
- Disabling the body of `writePlanStateToFile`.
- Disabling the body of `_schedulePlanStateWrite`.
- Hardcoding `inspectKanbanState` to return `null`.

### Complex / Risky
- None. This is a straightforward deprecation of a broken file-write mechanism.

## Edge-Case & Dependency Audit
- **Race Conditions:** By removing the file write debouncer and file watcher feedback loop for Kanban columns, we actively *eliminate* the race condition that was causing column advancements to revert.
- **Security:** N/A.
- **Side Effects:** `PlanFileImporter` will now safely default to treating all discovered plans as `CREATED` during database rebuilds. `ClickUpSyncService` will no longer append metadata to imported tasks.
- **Dependencies & Conflicts:** This change touches core state management but does not conflict with active frontend UI work.

## Dependencies
> [!IMPORTANT]
> None

## Adversarial Synthesis
### Grumpy Critique
If we completely disable `inspectKanbanState`, what happens to all the legacy plans that currently have the state block? The text will just sit there, stale and dead, confusing users. Also, if we just comment out the body of `writePlanStateToFile`, does that mean `TaskViewerProvider` is still going to call it and waste cycles? What if someone relies on `ClickUpSyncService` generating that block for external automation?

### Balanced Response
Legacy plans will indeed keep the dead text, but since `inspectKanbanState` returns `null`, the system will safely ignore it, rendering it harmless metadata. Users can manually delete it if they wish. We keep the signature of `writePlanStateToFile` intact but make it an immediate `Promise.resolve()` no-op, which wastes effectively zero cycles while avoiding a massive refactoring of `TaskViewerProvider` call sites. External automation should be using the SQLite database, not parsing markdown files, so removing it from `ClickUpSyncService` is the correct architectural move.

## Proposed Changes
> [!IMPORTANT]
> Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing code.

### `planStateUtils.ts`
#### [MODIFY] `src/services/planStateUtils.ts`
- **Context:** We need to completely disable reading and writing the markdown state block without breaking external signatures.
- **Logic:** 
  1. Replace the entire body of `writePlanStateToFile` with a no-op that resolves immediately.
  2. Modify `inspectKanbanState` to return `null`.

- **Implementation:**
```typescript
export async function writePlanStateToFile(
    planFilePath: string,
    workspaceRoot: string,
    column: string,
    status: string
): Promise<void> {
    // DISABLED: Switchboard State writes are disabled to prevent file-state override bugs.
    // The KanbanDatabase is the sole source of truth.
    return Promise.resolve();
}

export async function inspectKanbanState(planFilePath: string): Promise<{ column: string; status: string; formatVersion: number; lastUpdated?: string } | null> {
    // DISABLED: We no longer trust or read file-based state.
    return null;
}
```
- **Edge Cases Handled:** Prevents any future caller from accidentally writing or reading state.

### `ClickUpSyncService.ts`
#### [MODIFY] `src/services/ClickUpSyncService.ts`
- **Context:** This service currently hardcodes the kanban column state block into freshly imported markdown files.
- **Logic:** Remove the `switchboardState` variable and its insertion into the markdown stub.

- **Implementation:**
```typescript
        // Embedded kanban column for PlanFileImporter is NO LONGER REQUIRED.
        // We rely on the database default (CREATED) during discovery.

        const stub = [
          `# ${task.name || `ClickUp Task ${task.id}`}`,
          '',
          metaLines,
          '',
          '## Goal',
          '',
          description || 'TODO',
          '',
          '## Proposed Changes',
          '',
          'TODO',
          '',
          notesLines,
          '' // Removed switchboardState inclusion here
        ].join('\n');
```
- **Edge Cases Handled:** Ensures new ClickUp imports don't re-introduce the problematic text block.

### `KanbanProvider.ts`
#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** `KanbanProvider` attempts to debounce plan state writes.
- **Logic:** Make `_schedulePlanStateWrite` a no-op.

- **Implementation:**
```typescript
  private _schedulePlanStateWrite(planId: string, column: string, status: string = 'active'): void {
    // DISABLED: File-based state writes are deprecated.
    return;
  }
```
- **Edge Cases Handled:** Prevents unnecessary enqueueing and timeout cycles for a deprecated mechanism.

## Verification Plan
### Automated Tests
- N/A - relying on manual verification as this is a complex state interaction.

### Manual Verification
1. Open the Kanban board.
2. Move a plan card from `CREATED` to `PLAN REVIEWED`.
3. Verify the plan file does NOT regenerate the section.
4. Reload the VS Code window; verify the card remains in `PLAN REVIEWED` (database persistence).
```

## Reviewer Pass — 2026-04-26

### Stage 1: Grumpy Findings
- **CRITICAL #1:** `duplicate-switchboard-state-regression.test.js` had 5 assertion failures — `inspectKanbanState` now returns `{ state: null, topLevelSectionCount: 0, lastSeenColumn: null }` for all inputs, but the test still asserted the old parsing behavior (e.g., `topLevelSectionCount === 2`, `state?.kanbanColumn === 'PLAN REVIEWED'`, imported plan column from embedded state).
- **CRITICAL #2:** `custom-lane-roundtrip-regression.test.js` had 2 assertion failures — `writePlanStateToFile` is now a no-op, but the test still asserted that the file was modified with the custom column, and that the imported plan had the custom column instead of defaulting to `CREATED`.
- **MAJOR #3:** `_planStateWriteTimers` Map at `KanbanProvider.ts:35` was dead code — declared but never read or written since `_schedulePlanStateWrite` is a no-op. Orphan that would confuse future developers.
- **MAJOR #4:** 13+ call sites to `_schedulePlanStateWrite(...).catch(() => {})` in `KanbanProvider.ts` are now dead code invoking a no-op. Not harmful but actively misleading.
- **NIT #5:** `PlanFileImporter.ts:100-115` has dead conditional logic around `inspectKanbanState` that always evaluates to the same path (`CREATED`/`active`).
- **NIT #6:** `applyKanbanStateToPlanContent` in `planStateUtils.ts:188-207` still has full implementation but is only reachable from test code. JSDoc is misleading.

### Stage 2: Balanced Synthesis
| Finding | Verdict | Action |
|---------|---------|--------|
| #1 CRITICAL: duplicate-state test | **Fixed** | Updated assertions to verify disabled behavior |
| #2 CRITICAL: custom-lane test | **Fixed** | Updated assertions to verify no-op behavior |
| #3 MAJOR: `_planStateWriteTimers` dead | **Fixed** | Removed orphan Map declaration |
| #4 MAJOR: 13+ dead call sites | **Deferred** | Large refactor beyond plan scope; no-op calls harmless |
| #5 NIT: PlanFileImporter dead logic | **Deferred** | Functional but dead; low risk |
| #6 NIT: applyKanbanStateToPlanContent | **Keep** | Still used by tests |

### Code Fixes Applied
1. **`src/services/KanbanProvider.ts:34-35`** — Removed dead `_planStateWriteTimers` Map declaration and its JSDoc comment.
2. **`src/test/duplicate-switchboard-state-regression.test.js`** — Updated 5 assertions to verify `inspectKanbanState` returns null state / zero count, and that `PlanFileImporter` defaults to `CREATED`/`active`.
3. **`src/test/custom-lane-roundtrip-regression.test.js`** — Updated 2 assertions to verify `writePlanStateToFile` is a no-op (file unchanged) and importer defaults to `CREATED`.

### Verification Results
- `npm run compile`: ✅ webpack compiled successfully
- `duplicate-switchboard-state-regression.test.js`: ✅ passed
- `custom-lane-roundtrip-regression.test.js`: ✅ passed

### Files Changed (by this review)
- `src/services/KanbanProvider.ts` — removed `_planStateWriteTimers` Map (2 lines)
- `src/test/duplicate-switchboard-state-regression.test.js` — updated 5 assertions
- `src/test/custom-lane-roundtrip-regression.test.js` — updated 2 assertions

### Remaining Risks
- 13+ `_schedulePlanStateWrite` call sites in `KanbanProvider.ts` are no-op dead code. Should be removed in a future cleanup pass.
- `PlanFileImporter.ts` has dead conditional logic around `inspectKanbanState` that always resolves to `CREATED`. Could be simplified but is not harmful.
- `applyKanbanStateToPlanContent` still has full implementation reachable only from tests. If tests are refactored away from it, the function can be removed entirely.

---

## Switchboard State
**Kanban Column:** CODE REVIEWED
**Status:** active
**Last Updated:** 2026-04-26T08:41:38.451Z
**Format Version:** 1
