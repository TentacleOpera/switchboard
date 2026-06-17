# Database Tab Dropdown Redesign

## Goal
Redesign the database tab in setup.html to use a dropdown selector when multiple databases exist, instead of repeating all database controls down the page. This reduces visual clutter and improves usability for workspaces with multiple databases.

## Background & Problem Analysis
The current database tab renders a full card for each database with all controls (location, rebuild, backups, Notion) repeated. When a workspace has multiple databases, this creates a long, confusing page with redundant information. Users must scroll through repeated content to find the database they want to configure.

The existing "Managed by Workspace Mappings — edit location in the Workspace tab" text is also misleading because:
1. There is no "Workspace tab" - it's actually the "multi-repo tab"
2. The text provides no information users can't already learn by visiting the multi-repo tab

## Requirements
1. **Multi-database case (2+ databases):**
   - Display a dropdown at the top showing workspace folder names (e.g., "switchboard", "patrickwork")
   - Show only the selected database's controls card
   - Default to the first database in the list
   - Dropdown selection change updates the displayed card

2. **Single-database case:**
   - Skip the dropdown entirely
   - Display the database card directly

3. **Remove misleading text:**
   - Delete the `mappedNote` line that references "Workspace tab"

## Metadata
**Tags:** ui, ux, frontend
**Complexity:** 3

## User Review Required
- Confirm dropdown labels should prefer `db.parentFolder` (mapping name) with workspace root basename as fallback.
- Confirm plain `<select>` styling is acceptable versus a custom-styled component.

## Complexity Audit

### Routine
- Single-file change in `src/webview/setup.html`
- Pure client-side DOM manipulation
- Reuses existing event delegation and `lastAllDbPaths` state

### Complex / Risky
- None (provided `data-db-index` is preserved exactly as the original array index)

## Edge-Case & Dependency Audit
- **Race Conditions:** `allDbPathsUpdated` can arrive during user interaction, resetting the dropdown to index 0. This is acceptable for a settings panel that does not mutate frequently.
- **Security:** No new attack surface. Dropdown options rendered via existing `escapeHtml`.
- **Side Effects:** None. No backend or storage changes.
- **Dependencies & Conflicts:** None. Self-contained HTML/JS change. Does not affect `TaskViewerProvider`, `KanbanProvider`, or workspace mapping logic.

## Dependencies
- None

## Adversarial Synthesis
Key risks: incorrect `data-db-index` mapping causing the wrong database operation, and line-number drift during `mappedNote` removal. Mitigations: explicitly bind `data-db-index` to the original `lastAllDbPaths` array index, and use string-based deletion rather than blind line-number edits.

## Proposed Changes

### File: `src/webview/setup.html`

- **Context:** The `renderDatabases(databases)` function at line ~1354 currently maps the entire `databases` array into a flat list of cards. Event delegation handlers for location updates, rebuilds, and Notion actions all rely on `data-db-index` matching the original `lastAllDbPaths` array index.

- **Logic:** Introduce a module-level `selectedDatabaseIndex` state variable (default `0`). Split rendering into three branches:
  1. **Zero databases:** Show placeholder (existing behavior).
  2. **One database:** Render the single card directly, no dropdown.
  3. **Two or more databases:** Render a `<select>` dropdown before the card container, then render only the card at `selectedDatabaseIndex`.

- **Implementation:**
  1. Add state variable near line 1351:
     ```javascript
     let selectedDatabaseIndex = 0;
     ```
  2. Modify `renderDatabases()` at line 1354:
     - Keep empty-array guard.
     - If `databases.length === 1`, render card directly using the existing template.
     - If `databases.length > 1`:
       - Generate dropdown HTML with `<select>` and `<option>` elements. Use `db.parentFolder` if present; otherwise derive a fallback label from the last segment of `db.workspaceRoots[0]` using string split (e.g., `db.workspaceRoots[0].split(/[\\/]/).pop()`). Use `"Unknown workspace"` if both are missing.
       - Reuse existing inline styles from other `<select>` elements in setup.html, e.g.:
         ```
         style="width:100%; box-sizing:border-box; font-family:var(--font-mono); font-size:11px; background:var(--panel-bg2); border:1px solid var(--border-color); color:var(--text-primary); padding:6px 8px; border-radius:4px;"
         ```
       - Mark the option at `selectedDatabaseIndex` as `selected`.
       - Append dropdown HTML to `container.innerHTML`, then append the card HTML for `databases[selectedDatabaseIndex]`.
       - Preserve `data-db-index="${selectedDatabaseIndex}"` on the card `<div class="db-card">` so event delegation continues to resolve the correct database from `lastAllDbPaths`.
     - Add a delegated `change` listener on the persistent `#databases-list` container for the dropdown. On change, parse `parseInt(e.target.value)`, update `selectedDatabaseIndex`, and call `renderDatabases(databases)`.
  3. Remove `mappedNote` text:
     - Delete the `const mappedNote = ...` declaration (currently near line 1371).
     - Remove `${mappedNote}` from the card template (currently near line 1392).
     > *Note: line numbers are approximate and will shift after inserting the dropdown markup. Use a search-based edit rather than a line-targeted one.*
  4. Ensure event handler wiring remains intact:
     - Existing `click` delegation on `#databases-list` uses `data-db-index` to index into `lastAllDbPaths`. Because the single rendered card carries the original array index, no handler changes are needed.

- **Edge Cases:**
  - **Empty `workspaceRoots`:** Fallback label `"Unknown workspace"`.
  - **Duplicate parentFolder names:** Acceptable; full path shown in card disambiguates.
  - **External DB list update during interaction:** `allDbPathsUpdated` resets `lastAllDbPaths` and calls `renderDatabases`, which will reconstruct the dropdown defaulting to index 0. This is acceptable for a settings panel.
  - **Single database:** Dropdown skipped entirely, preserving current UX.
  - **Dropdown re-rendering:** Because `renderDatabases` rebuilds the dropdown via `innerHTML`, the `change` listener must be attached via event delegation on the persistent `#databases-list` container, not directly on the `<select>` element.

## Verification Plan

### Automated Tests
- No automated test changes required for this UI-only HTML modification. The test suite will be run separately by the user.

### Manual Testing Checklist
- [ ] Single database: No dropdown shown, card displays correctly
- [ ] Two databases: Dropdown appears with two workspace names, selection switches cards
- [ ] Three+ databases: Dropdown appears, all options accessible
- [ ] "Mapped" badge still displays correctly on mapped databases
- [ ] Location radio buttons and custom path input work for selected database
- [ ] Rebuild button works for selected database
- [ ] Notion backup/restore buttons work for selected database
- [ ] Dropdown defaults to first database on page load
- [ ] Misleading "Workspace tab" text is removed

**Recommendation:** Send to Intern
