# Standalone Board Renders Raw Default Columns — Custom Columns, Visibility and Order All Ignored

## Metadata

**Complexity:** 5
**Tags:** bug, backend, standalone, parity
**Project:** Browser Switchboard

## Goal

The standalone/browser host renders `DEFAULT_KANBAN_COLUMNS` verbatim. Custom agent columns and custom user columns never appear, hidden columns are still shown, and column reordering and relabelling are ignored. Build the column list from live workspace configuration, exactly as the extension does, in both state builders.

### Problem analysis and root cause

`bootstrap.ts` emits the raw defaults array as the column structure, in both of its state builders:

- `pushFullState` — `src/standalone/bootstrap.ts:341`
- `getFullState` — `src/standalone/bootstrap.ts:370`

```typescript
{ type: 'updateColumns', columns: DEFAULT_KANBAN_COLUMNS, surface: SURFACES.kanban }
```

The extension sends a **derived** list (`src/services/KanbanProvider.ts:1152`):

```typescript
{ type: 'updateColumns', columns: filteredColumns, surface: SURFACES.kanban }
```

built at `KanbanProvider.ts:1119` from `_buildKanbanColumns(customAgents, customKanbanColumns)` (`:853-857`), which calls `buildKanbanColumns` (`src/services/agentConfig.ts:414`) with `{ orderOverrides: this._getEffectiveKanbanOrderOverrides() }`, and is then filtered by per-role visibility.

So three distinct pieces of configuration are dropped in standalone: **custom columns** (both `custom-agent` and `custom-user` sources), **visibility** (`visibleAgents`), and **order/label overrides**.

**Why this looked wired.** Every mutating verb reaches the provider through the `default:` arm's delegation to `handleServiceVerb` (`bootstrap.ts:1062-1087`) — `saveKanbanColumn`, `deleteKanbanColumn`, `restoreKanbanDefaults`, `toggleKanbanColumnVisibility` and `updateKanbanStructure` all execute and persist, and all return `{ success: true }`. `bootstrap.ts:382-384` even documents four of them as delegated Board arms that fire `refreshUI`. The write lands; the read-back re-renders the defaults. The user creates a custom column, gets a success response, and the column never appears.

This is one instance of the hardcoded-payload class described in `standalone-push-parity-guard.md`; it is the largest instance, because it silently discards an entire user-configurable subsystem rather than a single boolean.

## User Review Required

None.

## Complexity Audit

### Routine
- Replacing the two literals with a derived list.

### Complex / Risky
- **`_buildKanbanColumns` is a private provider method.** Standalone must not reimplement column assembly — a second implementation is precisely how the hosts diverge. Expose the existing derivation (a public method or a shared exported helper over `buildKanbanColumns`) and call it. A parallel standalone implementation must be rejected in review.
- **Order overrides come from `_getEffectiveKanbanOrderOverrides()`**, which resolves workspace-scoped state. Standalone must feed the same source, or columns render in a different order in the browser than in the editor for the same workspace.
- **Visibility filtering must be applied, not just fetched.** The extension sends `filteredColumns`, not the built list. Sending the unfiltered list would newly *reveal* columns the user has hidden — a visible regression in the opposite direction, and worse than today's behaviour for anyone who has hidden a role.
- **Both builders must change.** `pushFullState` and `getFullState` are near-duplicates; fixing one leaves the bug on whichever path the client takes (initial fetch vs. subsequent broadcasts).
- **Async in the payload builders.** `_buildKanbanColumns` is `async` and needs `customAgents` / `customKanbanColumns` read from config. `getFullState` is already `async`; confirm `pushFullState`'s assembly can await without reordering the broadcast sequence — the array is broadcast in order at `bootstrap.ts:346-348` and the board expects `updateColumns` before `updateBoard`.

## Edge-Case & Dependency Audit

**Race Conditions**
- Column mutations already schedule a coalesced push (`bootstrap.ts:1078`, `PUSH_COALESCE_MS = 40` at `:395`). Once the payload is derived, that push becomes the mechanism that makes the change appear — the same push that currently reverts it.

**Security** — no new surface; reads existing workspace configuration.

**Side Effects**
- Users of the standalone host who have custom or hidden columns will see their board change on first load after this lands. That is the fix, not a regression, but it is a visible change worth noting in release notes.
- A custom column whose `kind` is not handled by a webview `switch` would newly reach the browser. Audit exhaustive switches on `kind` for a default arm before shipping.

**Dependencies & Conflicts**
- Independent of the backlog plan; they touch adjacent lines in the same two functions, so expect a merge conflict if developed in parallel. Sequence them or coordinate.

## Dependencies

- None (hard). Sequencing: land after `standalone-push-parity-guard.md` so the fix is verified by the guard's baseline dropping.

## Implementation

### 1. Expose the column derivation

**File:** `src/services/KanbanProvider.ts`

- Provide a public accessor over the existing derivation used at `:1119-1152` — built columns plus visibility filtering — returning exactly what the extension sends as `filteredColumns`. Do not duplicate the logic; wrap it.

### 2. Use it in both standalone builders

**File:** `src/standalone/bootstrap.ts`

- Replace `columns: DEFAULT_KANBAN_COLUMNS` at `:341` and `:370` with the derived list for the current workspace root.
- Preserve broadcast ordering: `updateColumns` must precede `updateBoard`.

## Proposed Changes

### `src/services/KanbanProvider.ts`
- **Logic:** Public accessor over the existing build + visibility-filter path.
- **Edge Cases:** Must return the *filtered* list; returning the unfiltered list reveals hidden columns.

### `src/standalone/bootstrap.ts`
- **Logic:** Call the accessor in both builders; keep message order.
- **Edge Cases:** Await without breaking broadcast sequence.

## Verification Plan

### Automated
- Test: `getFullState()`'s `updateColumns` entry reflects a custom column added to workspace config, and omits a role hidden via `visibleAgents`.
- Guard: `standalone-parity:check` baseline for hardcoded payload fields drops by one.

### Manual (standalone host in a browser)
1. **Custom column appears.** Create a custom column in the editor, reload the browser board — it renders.
2. **Created from the browser.** Create a custom column from the standalone board — it appears without a manual reload (the coalesced push now carries it).
3. **Visibility respected.** Hide a role — its column disappears from the browser board; unhide — it returns.
4. **Order respected.** Reorder columns — the browser matches the editor.
5. **Relabel respected.** Rename a column — the browser shows the new label.
6. **Delete and restore defaults** behave identically in both hosts.
7. **Extension unaffected.** Repeat 1–6 in the editor; no regression.

## Recommendation

Complexity 5 → **Send to Lead Coder.** The line change is small; the risk is a duplicated derivation in standalone and the async/order handling in the broadcast assembly.
