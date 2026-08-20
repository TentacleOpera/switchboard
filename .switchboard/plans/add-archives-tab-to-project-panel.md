# Add Archives Tab to Project Panel

## Goal

Add a new "Archives" tab to the Project panel (`project.html`) that reads archived plans from the cold store (`kanban-archive.db`) and displays them in a searchable list. A "Query Archives" button copies a prompt to the clipboard that points the agent to the archive protocol by path — same pattern as the tickets tab Agent API button. This replaces the current `queryArchives` handler in the implementation panel sidebar (which is not visible in Browser Switchboard) and makes the archive protocol (`archive` skill, moving to `.switchboard/protocols/archive/SKILL.md`) discoverable via UI instead of via CLI skill discovery.

## Problem Analysis

### Background

The Switchboard archive is a cold store (`kanban-archive.db`) that holds plans moved out of the hot kanban board. The `KanbanDatabase` class already supports archive reads — `getArchiveInstanceIfPresent()`, `getCompletedPlansCold()`, and union reads across hot + cold are all implemented.

The current archive UI is a "QUERY ARCHIVES" button in the implementation panel sidebar (`implementation.html:3422-3426`). It sends a `queryArchives` message to `TaskViewerProvider` which generates an inline prompt telling the agent to use `duckdb` CLI directly. This has two problems:

1. **Not visible in Browser Switchboard** — the implementation panel sidebar is a VS Code-only feature. Browser Switchboard users have no way to access archived plans.
2. **Inline instructions, not protocol-referenced** — the generated prompt gives raw duckdb commands instead of pointing to the archive protocol, so the agent doesn't benefit from the protocol's schema reference, security guardrails, or query templates.

### Root Cause

The archive was originally a DuckDB database (`archive.duckdb`) queried via CLI. It has since been migrated to a SQLite cold store (`kanban-archive.db`) managed by `KanbanDatabase`, but the UI was never updated to reflect this. The `queryArchives` handler (`TaskViewerProvider.ts:15156`) still generates DuckDB CLI instructions, which are stale.

### Current State

- `KanbanDatabase.getArchiveInstanceIfPresent(workspaceRoot)` — returns a `KanbanDatabase` instance for the cold store if it exists, null otherwise.
- `KanbanDatabase.archiveAvailable(workspaceRoot)` — returns true if the archive instance is open or the archive file exists on disk.
- `KanbanDatabase.getCompletedPlansCold(workspaceId, limit, offset)` — reads completed plans from the cold store. Queries `WHERE status = 'completed'` (NOT `'archived'` — the V10 migration repairs `status = 'archived'` rows to `status = 'completed'`).
- The cold store uses the same `plans` table schema as the hot store.
- No UI in the Project panel for browsing archives.

## Metadata

**Complexity:** 4
**Tags:** feature, ui, archives, browser-switchboard
**Project:** Browser Switchboard

## User Review Required

No user review required — the approach follows existing tab patterns and the archive protocol path is determined by Subtask 2.

## Complexity Audit

### Routine
- Adding a new tab button + content container to `project.html` (same pattern as 6 existing tabs)
- Adding tab switching logic to `project.js` (same pattern as existing tabs)
- Adding a `fetchArchivedPlans` message handler to `PlanningPanelProvider.ts` (same pattern as `fetchKanbanPlans`)
- Adding a "Query Archives" button that copies a prompt to clipboard (same pattern as tickets tab Agent API button)
- Adding verbs to the generated allowlist (run `npm run catalog:generate`)

### Complex / Risky
- **SQL query correctness**: The cold store uses `status = 'completed'` (not `'archived'`) after the V10 migration. The handler must use the existing `getCompletedPlansCold` method, not a raw SQL query with `WHERE status = 'archived'`.
- **Plan file content reading**: Archived plan records are in the cold store DB, but the plan file content is on disk at the path stored in the `plan_file` field. The detail view must read from disk, not from the DB.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — archive reads are read-only SQLite queries. The existing `requestId` guard pattern (used in `fetchKanbanPlans`) should be applied to prevent stale responses.
- **Security:** The "Query Archives" button copies a prompt to clipboard — no sensitive data exposed. The archive protocol at `.switchboard/protocols/archive/SKILL.md` includes security guardrails for read-only queries.
- **Side Effects:** Removing the old `queryArchives` handler from `TaskViewerProvider.ts` and the "QUERY ARCHIVES" button from `implementation.html` — these are VS Code-only features being replaced by the new Archives tab. The old handler generates stale DuckDB CLI instructions that no longer work.
- **Dependencies & Conflicts:** Depends on Subtask 2 (Move Protocols Out of Skill Discovery) — the archive protocol must be at `.switchboard/protocols/archive/SKILL.md` for the "Query Archives" button prompt to reference it by path.

## Dependencies

- Subtask 2 (Move Protocols Out of Skill Discovery) must land first — the archive protocol must be at `.switchboard/protocols/archive/SKILL.md` before the "Query Archives" button can reference it by path.

## Adversarial Synthesis

Key risks: (1) SQL query using `status = 'archived'` instead of `status = 'completed'` — the V10 migration repairs archived rows to completed, so a raw `WHERE status = 'archived'` query returns zero rows; mitigated by using the existing `getCompletedPlansCold` method which queries correctly; (2) plan file content reading — the cold store DB has plan records (metadata), not file content; the detail view must read the plan file from disk using the `plan_file` path from the record; (3) stale `queryArchives` handler removal — the old handler in `TaskViewerProvider.ts` generates DuckDB CLI instructions that are completely stale; removing it is safe since the new Archives tab replaces it. Overall risk is moderate: follows existing patterns but the SQL correctness issue would have been a silent failure (tab loads, shows empty, no errors).

## Proposed Changes

### `src/webview/project.html` — Add Archives tab

- **Context:** The Project panel has 6 existing tabs (Kanban, Features, PRDs, Constitution, System, Tuning). A new Archives tab follows the same pattern.
- **Logic:** Add a tab button after the existing tabs in the `.shared-tab-bar` and a corresponding tab content container.
- **Implementation:**
  ```html
  <!-- In .shared-tab-bar, after TUNING button: -->
  <button class="shared-tab-btn" data-tab="archives">ARCHIVES</button>
  ```
  ```html
  <!-- Tab content container: -->
  <div id="archives-content" class="shared-tab-content">
      <!-- Archives list + detail view -->
  </div>
  ```
  Follow the same layout pattern as the Kanban Plans tab: a sidebar list (archived plans) + a main content area (selected plan's rendered markdown). Include:
  - Workspace filter dropdown (same as other tabs)
  - Search input (filter by topic/plan file name)
  - Column filter (archived plans retain their last `kanban_column`)
  - Plan list rendering archived plans as cards
  - Detail view showing the plan's rendered markdown content (read-only)
- **Edge Cases:** Empty state when no archive exists or no archived plans are found.

### `src/webview/project.js` — Add tab switching logic

- **Context:** Tab switching is handled by a click handler that toggles `active` class and posts a fetch message to the extension.
- **Logic:** Add `'archives'` to the tab switching logic.
- **Implementation:**
  - Tab click handler: when `archives` tab is activated, post `{ type: 'fetchArchivedPlans', workspaceRoot, requestId }` to the extension.
  - `activeTab` handling: add `else if (targetTab === 'archives')` block.
  - Sidebar state: add `state.archivesListCollapsed` following the same pattern as other tabs.
  - Add `renderArchivedPlans()` function following the same pattern as `renderKanbanPlans()`.
  - Add message handler for `archivedPlansReady`:
    ```js
    case 'archivedPlansReady':
        _archivedPlansCache = msg.plans || [];
        renderArchivedPlans();
        break;
    ```
- **Edge Cases:** Apply the `requestId` stale-response guard pattern (same as `fetchKanbanPlans`).

### `src/services/PlanningPanelProvider.ts` — Add `fetchArchivedPlans` handler

- **Context:** The Planning panel provider handles messages from the Project panel webview. The existing `fetchKanbanPlans` handler (line 3620) is the pattern to follow.
- **Logic:** Add a new message handler for `fetchArchivedPlans` that reads from the cold store using the existing `getCompletedPlansCold` method.
- **Implementation:**
  1. Resolve the workspace root from the message.
  2. Call `KanbanDatabase.getArchiveInstanceIfPresent(workspaceRoot)`.
  3. If no archive instance, return `{ success: false, error: 'No archive found' }`.
  4. Call `getCompletedPlansCold(workspaceId, limit, offset)` — this queries `WHERE status = 'completed'` (the correct status after V10 migration).
  5. Post `{ type: 'archivedPlansReady', plans, workspaceRoot }` back to the webview.

  > **Superseded:** Query all archived plans: `SELECT * FROM plans WHERE status = 'archived' ORDER BY updated_at DESC`
  > **Reason:** The cold store uses `status = 'completed'`, NOT `'archived'`. The V10 migration (`KanbanDatabase.ts:7292`) repairs `status = 'archived'` rows to `status = 'completed'`. A raw SQL query with `WHERE status = 'archived'` would return zero rows after migration — a silent failure (tab loads, shows empty, no errors). The existing `getCompletedPlansCold` method already queries with the correct status.
  > **Replaced with:** Call `getCompletedPlansCold(workspaceId, limit, offset)` — queries `WHERE status = 'completed'`, which is the correct status for archived plans in the cold store.

  Also add a handler for `fetchArchivedPlanDetail` to read a single plan's file content from disk (the plan file path is stored in the record's `plan_file` field — same as the existing plan file reader for the Kanban tab).
- **Edge Cases:** Apply the `requestId` stale-response guard (same as `fetchKanbanPlans`). Handle the case where the plan file has been deleted from disk but the record still exists in the cold store.

### `src/webview/project.html` — Add "Query Archives" button

- **Context:** The tickets tab has an Agent API button that copies a prompt to clipboard. The Archives tab follows the same pattern.
- **Logic:** Add a button in the Archives tab toolbar that copies a prompt pointing to the archive protocol by path.
- **Implementation:**
  ```html
  <button class="strip-btn" id="btn-query-archives-prompt" data-tooltip="Copy a prompt for an agent to query the archives">QUERY ARCHIVES</button>
  ```
  When clicked, copy a prompt to the clipboard:
  ```
  Read and follow .switchboard/protocols/archive/SKILL.md to query the Switchboard archive for workspace: {workspaceRoot}.

  The archive is a SQLite cold store at {archiveDbPath}. Use sqlite3 (read-only) to query it.

  What would you like to find?
  ```
- **Edge Cases:** The `archiveDbPath` should be resolved from `KanbanDatabase.getArchiveDbPath(workspaceRoot)` if available, or fall back to the default path `<workspaceRoot>/.switchboard/kanban-archive.db`.

### `src/webview/project.js` — Update `REVIEWABLE_TABS`

- **Context:** `REVIEWABLE_TABS` (line 3537) is `['kanban', 'features', 'projects', 'constitution', 'system']`. Tuning is excluded by design.
- **Logic:** Add `'archives'` to `REVIEWABLE_TABS` if review mode should apply to archived plans.
- **Implementation:** `const REVIEWABLE_TABS = ['kanban', 'features', 'projects', 'constitution', 'system', 'archives'];`
- **Edge Cases:** If review mode is not needed for archived plans (they are read-only), skip this step.

### `src/services/verbSchemas.ts` + `src/generated/verbAllowlist.ts` — Add verbs

- **Context:** The verb allowlist is auto-generated by `npm run catalog:generate` from the providers' case blocks.
- **Logic:** Add the new verbs to the schema and regenerate the allowlist.
- **Implementation:**
  1. Add `fetchArchivedPlans` and `fetchArchivedPlanDetail` case blocks to `PlanningPanelProvider.ts` (done in the handler step above).
  2. Add payload schemas to `verbSchemas.ts` (if the verbs have payloads — `fetchArchivedPlans` has `workspaceRoot` and `requestId`).
  3. Run `npm run catalog:generate` to regenerate `verbAllowlist.ts`. This automatically adds the verbs to `PLANNING_VERBS`.
- **Edge Cases:** The `queryArchivesPrompt` verb (for the clipboard button) may not need a server round-trip — it can be handled entirely in the webview JS. If so, it does NOT need to be in the verb allowlist.

### `src/services/TaskViewerProvider.ts` — Remove stale `queryArchives` handler

- **Context:** The `queryArchives` handler (line 15156) generates stale DuckDB CLI instructions. The new Archives tab replaces it.
- **Logic:** Remove the handler and the "QUERY ARCHIVES" button from `implementation.html`.
- **Implementation:**
  - Remove the `case 'queryArchives':` block from `TaskViewerProvider.ts` (lines 15156-15185).
  - Remove the "QUERY ARCHIVES" button from `implementation.html` (lines 3422-3426).
  - Remove `queryArchives` from `TASKVIEWER_VERBS` (regenerate via `npm run catalog:generate`).
  - Remove `queryArchives` from `verbSchemas.ts` (line 1718).
- **Edge Cases:** The `queryArchives` verb is in `TASKVIEWER_VERBS` in the generated allowlist. After removing the case block and running `catalog:generate`, it will be automatically removed from the allowlist.

## Verification Plan

### Automated Tests
- Verify `fetchArchivedPlans` is in `PLANNING_VERBS` after running `npm run catalog:generate`.
- Verify `queryArchives` is NOT in `TASKVIEWER_VERBS` after removal.
- `grep -r "queryArchives" src/` — returns zero matches (old handler fully removed).

### Manual
- Open the Project panel — verify the "ARCHIVES" tab appears.
- Click the tab — verify archived plans load (or empty state shows if no archive).
- Search/filter archived plans.
- Click a plan — verify its content renders in the detail view (read from disk via `plan_file` path).
- Click "QUERY ARCHIVES" — verify a prompt is copied to clipboard referencing `.switchboard/protocols/archive/SKILL.md`.
- Test in Browser Switchboard — verify the tab and button are visible and functional.
- Verify the old "QUERY ARCHIVES" button is gone from the implementation panel sidebar.

## Impact

- Browser Switchboard users gain access to archived plans.
- Archive protocol is delivered by path (via button prompt) instead of by CLI discovery.
- Replaces stale DuckDB CLI instructions with a proper SQLite-backed UI + protocol reference.
- Enables the archive skill to move out of `.agents/skills/` (reducing CLI system prompt noise).

**Recommendation:** Complexity 4 → Send to Coder.
