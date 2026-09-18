# Fix: Review Plan Silently Opens Wrong Plan When Column Filter Excludes Target

## Problem

When `kanban.html`'s "review plan" button is clicked, planning.html receives an `activateKanbanTabAndSelectPlan` message and attempts to select the target plan. The handler correctly resets the workspace and project filters, but **does not clear the column filter**. If the column filter is set to a value that excludes the target plan (e.g. filter = "backlog" but the plan is in "in-progress"), `renderKanbanPlans` never creates a DOM element for that plan. The subsequent `querySelector('.kanban-plan-item[data-plan-id="..."]')` returns `null`, the selection block is silently skipped, and whatever plan was previously shown (or the first visible one) remains — wrong plan, no error.

## Root Cause

In `planning.js`, the `activateKanbanTabAndSelectPlan` case (~line 2637) resets workspace filter and project filter, but leaves `kanbanFilters.column` untouched. The column filter is persisted in localStorage, so it survives across sessions. When the tab re-renders via `switchToTab('kanban')` → `fetchKanbanPlans` → `renderKanbanPlans`, the active column filter excludes the target plan from the DOM entirely. Both the immediate-match path (line ~2648) and the `handleKanbanPlansReady` path (line ~4530) both do a `querySelector` lookup — both fail silently when `itemDiv` is null.

## Fix

**File:** `src/webview/planning.js`  
**Location:** `activateKanbanTabAndSelectPlan` case, immediately after the existing workspace filter reset block (after line ~2643, before `switchToTab('kanban')`)

Add three lines to clear the column filter and persist the reset to localStorage:

```js
// Clear column filter so the target plan is guaranteed to be in the DOM
kanbanFilters.column = '';
if (kanbanColumnFilter) kanbanColumnFilter.value = '';
persistTab('kanban.column', '');
```

This mirrors the existing pattern used for the workspace and project filter resets in the same block, ensuring `renderKanbanPlans` renders the target plan unconditionally when navigating to it.

No other changes needed — `findPendingKanbanMatch` already searches the full unfiltered cache correctly, and both selection paths will find the `itemDiv` once the column filter is cleared.

## Verification

1. In planning.html, set the column filter to "backlog"
2. In kanban.html, click "review plan" on a plan that is in a different column (e.g. "in-progress")
3. Confirm planning.html switches to the kanban tab, clears the column filter dropdown, and selects/previews the correct plan
4. Confirm the column filter dropdown shows "All" (or blank) after navigation
5. Reload planning.html (to verify localStorage was cleared) and confirm the column filter remains blank

## Metadata

**Complexity:** 1  
**Tags:** frontend, bugfix

## Review Findings

Implemented exactly as specified in [planning.js](../../src/webview/planning.js#L2646-L2649) — `kanbanFilters.column = ''`, dropdown reset, and `persistTab('kanban.column', '')` added before `switchToTab('kanban')`. Traced both selection paths: the immediate-match path skips silently if the DOM is still stale, but `_pendingKanbanSelection` survives and `handleKanbanPlansReady` re-resolves it after the async fetch re-renders with the cleared filter (`updateKanbanColumnFilter` reads the now-empty `kanbanFilters.column`, `renderKanbanPlans` filter at L4030 passes the target). No double-trigger (single fetch via `switchToTab`), no orphaned refs, no race. Files changed: `src/webview/planning.js`. Validation: static trace only (compile/tests skipped per session directive). No remaining risks.
