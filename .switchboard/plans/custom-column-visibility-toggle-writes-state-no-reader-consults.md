# Hiding a Custom Kanban Column Does Nothing — the Toggle Writes State Both Readers Structurally Ignore

## Metadata

**Complexity:** 4
**Tags:** kanban, columns, visibility, both-hosts

## Goal

Make column visibility work for custom columns in both hosts: the toggle already persists a value, but every reader hardcodes custom columns to visible, so the column never hides and never stays hidden across reload.

### Problem analysis and root cause

The Kanban Column Editor offers a visibility toggle on custom columns. It reports success. The column stays visible — immediately, after settle, and after reload. The write lands and both readers discard it.

**Root cause, verified against the tree — three files, all in shared code:**

1. **The write is generic.** `TaskViewerProvider.handleToggleKanbanColumnVisibility` (`src/services/TaskViewerProvider.ts:10604-10611`) stores under whatever id it is given:
   ```ts
   state.visibleAgents[columnId] = visible;
   ```
   It is reached from `KanbanProvider.ts:10847-10852` for **any** column, custom or built-in. Nothing rejects a custom column id.

2. **The filter ignores custom columns.** `_filterVisibleColumns` (`src/services/TaskViewerProvider.ts:3854-3866`) only ever drops a column when it is built-in:
   ```ts
   if (column.source === 'built-in' && column.role && visibleAgents[column.role] === false) {
       return false;
   }
   return true;
   ```
   A custom column falls through to `return true` unconditionally.

3. **The reported flag is hardcoded.** `_buildSetupKanbanStructure` (`src/services/TaskViewerProvider.ts:3868-3900`) computes:
   ```ts
   const visible = fixed ? true
       : column.source === 'built-in' ? (!column.role || visibleAgents[column.role] !== false)
       : true;                      // ← custom columns: always true
   ```

So the toggle writes `visibleAgents[<customColumnId>]`, and neither the filter nor the structure builder ever reads that key. Built-in role visibility works because it is keyed on `column.role` and both readers consult exactly that.

**This is not a standalone defect.** All three sites are in `TaskViewerProvider`/`KanbanProvider`, shared by the extension and the browser host. The doc-parity audit recorded it as a standalone gap (`BRD-089`); that scoping is wrong. It is broken everywhere, and a fix in one host fixes both.

**Why it survived:** the toggle returns `{success: true}` and the write genuinely persists to `state.visibleAgents`. Every check short of *re-reading the structure and looking at the column* passes. It is the exact shape of defect the parity audits kept classifying as working.

### Migration — this state has shipped

`visibleAgents` is shipped, released state on ~4,000 installs. Two consequences:

- Installs where a user has already toggled a custom column carry orphan `visibleAgents[<customColumnId>]` keys written by the broken toggle. Once the readers start honouring that key, those stale entries **become live** — a user who toggled a column months ago and saw nothing happen will find it suddenly hidden after upgrading. Those keys must be reconciled deliberately (adopt them, or clear them once, with the choice stated), never silently activated.
- Unknown/legacy keys in `visibleAgents` must be preserved, not dropped, by whatever reconciliation runs.

## User Review Required

None. Recommended disposition for the stale keys: **adopt** them — the user's expressed intent was to hide the column, and honouring it is the least surprising outcome. Record the adoption in the migration so the behaviour change is traceable.

## Complexity Audit

### Routine

- Extending two conditionals to cover `source !== 'built-in'`.

### Complex / Risky

- **Two readers must change together.** Fixing `_buildSetupKanbanStructure` alone makes the editor's checkbox render correctly while the column still appears on the board, because `_filterVisibleColumns` is what actually removes it. Fixing the filter alone leaves the checkbox showing the wrong state. Both, or the bug merely changes shape.
- **The keying is inconsistent by design.** Built-in columns key visibility on `column.role`; custom columns have no role and must key on `column.id`. A single shared resolver for "what key does this column's visibility live under" is worth more than two parallel conditionals, and prevents the third reader from getting it wrong.
- **`CREATED` and `COMPLETED` stay fixed.** They are anchors and must remain visible regardless of state — the `fixed` short-circuit must survive.
- **Hiding a column that holds cards.** The board must not orphan plans sitting in a hidden custom column. Establish and state the behaviour (cards remain in the DB and reappear when unhidden) and confirm no read path drops them.
- **Interaction with next-column resolution.** `standalone-kanban-column-parity-audit.md` owns visibility-aware advance. Once custom columns can genuinely hide, that plan's problem statement widens to include them — link, do not absorb.

## Edge-Case & Dependency Audit

**Race Conditions** — the toggle calls `sendVisibleAgents()` and re-posts setup state, and in standalone additionally re-arms the coalesced full-state push. Both readers must be fixed before the push fires, or the coalesced push re-asserts a visible column ~40 ms later and the fix looks broken.

**Security** — none.

**Side Effects** — a column that genuinely hides changes board layout for existing users on upgrade. See the migration note.

**Dependencies & Conflicts** — `standalone-kanban-column-parity-audit.md` (visibility-aware next-column resolution) is adjacent; link findings rather than merging the plans.

## Dependencies

None.

## Implementation

1. Introduce one resolver that returns the visibility key for a column — `column.role` for built-in, `column.id` for custom — and use it in both readers.
2. Update `_filterVisibleColumns` (`TaskViewerProvider.ts:3854-3866`) to drop any non-fixed column whose resolved key is `false`, regardless of `source`.
3. Update `_buildSetupKanbanStructure` (`TaskViewerProvider.ts:3868-3900`) so `visible` is computed from the same resolver instead of hardcoding `true` for custom columns.
4. Confirm `handleToggleKanbanColumnVisibility` (`:10604-10611`) writes under the same resolved key — it already writes under the raw `columnId`, which is correct once the readers agree.
5. Reconcile pre-existing `visibleAgents` entries for custom column ids per the disposition above, preserving unknown keys.
6. Add a regression test that hides a custom column, re-reads the structure, and asserts both the `visible` flag and the column's absence from the filtered set — the assertion the current code would pass vacuously.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`
- **Context:** `_filterVisibleColumns:3854-3866` and `_buildSetupKanbanStructure:3868-3900` both treat custom columns as unconditionally visible.
- **Logic:** Resolve the visibility key per column source; honour it in both.
- **Edge Cases:** `CREATED`/`COMPLETED` stay fixed; columns holding cards must not orphan them; stale keys reconciled, unknown keys preserved.

### Regression test (new)
- **Logic:** Toggle a custom column hidden → re-read structure → assert `visible: false` **and** absence from the filtered column set.
- **Edge Cases:** Must fail against current `main`, or it is not testing the defect.

## Verification Plan

1. Hiding a custom column removes it from the board and it stays removed after reload, in both hosts.
2. Unhiding restores it, with its cards intact.
3. Built-in role visibility is unchanged — no regression on the path that already worked.
4. `CREATED` and `COMPLETED` remain visible under every combination.
5. The new regression test fails on current `main` and passes after the change.
6. An install carrying a pre-existing `visibleAgents[<customColumnId>]` key reconciles per the stated disposition, and unrelated keys in that map are preserved.
7. `npx tsc --noEmit` introduces no new errors against the pre-existing baseline (5 `TS2835` errors at HEAD, unrelated).

## Recommendation

Complexity 4 → **Send to Coder.** The code change is small and precisely located; the care is in changing both readers together and in not silently activating shipped state.
