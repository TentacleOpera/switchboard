# Feature: Link All Button + Complexity Filter in Project Panel Kanban Plans Tab

## Goal

### Problem
The Kanban Plans tab in `project.html` has no "Link All" button and no complexity
filter. The Planning panel's Tickets tab (`planning.html`) already has a "Link
All" button that copies all ticket file paths/links to clipboard for the filtered
view. The user wants the same capability for kanban plans — a "Link All" button at
the top of the sidebar that produces a list of links for each plan in the filtered
view, plus a complexity filter so they can link all plans of a certain complexity.

### Background
The Kanban Plans tab sidebar (`#kanban-list-pane`) currently contains only a
sidebar toggle button. The controls strip has workspace, project, and column
filters plus Import / Create / Chat Prompt buttons and a search input — but no
complexity filter and no Link All button.

The Planning panel's Tickets tab has a working "Link All" button
(`#tickets-link-all`) at `src/webview/planning.html` line 3531, wired in
`src/webview/planning.js` lines 6778-6793. It collects the filtered ticket IDs and
posts a `copyToClipboard` message to the extension.

Complexity data IS available per plan: the `plans` table in `kanban.db` has a
`complexity` column (TEXT, `'1'`–`'10'` or `'Unknown'`), and the plan render in
`project.js` already displays a `complexity-dot` (line 1148). So the data needed
for both the filter and the link list is already in the rendered plan cache.

### Root Cause
This is a missing-feature, not a bug. The Kanban Plans tab was built without
parity to the Tickets tab's Link All, and without a complexity filter. The
complexity value is present in each plan object (`plan.complexity`) but is only
used for the visual dot — not for filtering.

## Metadata
**Tags:** feature, project-panel, kanban-plans, link-all, complexity-filter
**Complexity:** 3
**Repo:** switchboard (source at `/Users/patrickvuleta/Documents/GitHub/switchboard`)

## Complexity Audit

### Routine
1. Add a `#kanban-link-all` button to the `#kanban-list-pane` sidebar toggle row
   in `project.html`.
2. Add a complexity `<select>` to the kanban controls strip in `project.html`.
3. Wire the complexity filter in `project.js` to filter `_kanbanPlansCache` and
   re-render.
4. Wire the Link All button to collect filtered plan file paths and copy them to
   clipboard (mirroring the Copy Link per-plan button which already uses
   `navigator.clipboard.writeText(toAgentRef(path))`).

### Complex / Risky
1. **Filter composition.** The complexity filter must compose with the existing
   workspace/project/column/search filters. The render path
   (`renderKanbanPlans`) reads `kanbanFilters` — a new `kanbanFilters.complexity`
   field must be threaded through the filter predicate without breaking the
   existing filter logic.
2. **Link All output format.** The per-plan "Copy Link" button (project.js line
   1167) uses `toAgentRef(path)` to produce an agent-reference link. Link All
   should produce one such link per line for all filtered plans, matching the
   Tickets tab's bulk-copy behavior. Confirm `toAgentRef` is importable/available
   in project.js (it's already used at line 1167).

## Edge-Case & Dependency Audit

- **Plans with no `planFile`:** The Copy Link button only renders when
  `plan.planFile` exists (line 1146). Link All must skip plans without a
  `planFile`.
- **Empty filtered view:** Link All on an empty list should either be disabled
  or copy an empty string with a "No plans to link" toast. Prefer disabling the
  button when the filtered list is empty.
- **Complexity value normalization:** `plan.complexity` can be `'Unknown'` or a
  string integer `'1'`–`'10'`. The filter dropdown should offer ranges
  (Unknown / Low 1-3 / Medium 4-6 / High 7-10) and parse the string to int for
  range comparison.
- **Existing search input:** The complexity filter is independent of the text
  search; both must apply simultaneously.

## Proposed Changes

### File: `src/webview/project.html`

**Change 1 — Add complexity filter to the kanban controls strip (after the column
filter, around line 1412).**

```html
<select id="kanban-complexity-filter">
    <option value="">All Complexity</option>
    <option value="unknown">Unknown</option>
    <option value="1-3">Low (1-3)</option>
    <option value="4-6">Medium (4-6)</option>
    <option value="7-10">High (7-10)</option>
</select>
```

**Change 2 — Add Link All button to the kanban sidebar toggle row (around line
1420).**

Replace:
```html
<div id="kanban-list-pane">
    <div class="sidebar-toggle-row">
        <button class="sidebar-toggle-btn" title="Toggle sidebar">«</button>
    </div>
</div>
```
With:
```html
<div id="kanban-list-pane">
    <div class="sidebar-toggle-row">
        <button id="kanban-link-all" class="strip-btn" title="Copy all filtered plan links to clipboard">Link all</button>
        <button class="sidebar-toggle-btn" title="Toggle sidebar">«</button>
    </div>
</div>
```

### File: `src/webview/project.js`

**Change 3 — Add complexity filter state and element reference (near line 203).**

```javascript
const kanbanComplexityFilter = document.getElementById('kanban-complexity-filter');
```
And in the `kanbanFilters` object, add:
```javascript
complexity: ''
```

**Change 4 — Wire the complexity filter change handler (near the other filter
wiring).**

```javascript
if (kanbanComplexityFilter) {
    kanbanComplexityFilter.addEventListener('change', () => {
        kanbanFilters.complexity = kanbanComplexityFilter.value;
        renderKanbanPlans();
    });
}
```

**Change 5 — Apply the complexity filter in the plan-filter predicate inside
`renderKanbanPlans`.**

In the existing filter predicate (where workspace/project/column/search are
applied), add:
```javascript
if (kanbanFilters.complexity) {
    const c = plan.complexity || 'Unknown';
    if (kanbanFilters.complexity === 'unknown') {
        if (c !== 'Unknown' && c !== '') return false;
    } else {
        const [lo, hi] = kanbanFilters.complexity.split('-').map(Number);
        const score = parseInt(c, 10);
        if (isNaN(score) || score < lo || score > hi) return false;
    }
}
```

**Change 6 — Wire the Link All button.**

```javascript
const kanbanLinkAllBtn = document.getElementById('kanban-link-all');
if (kanbanLinkAllBtn) {
    kanbanLinkAllBtn.addEventListener('click', () => {
        // Reuse the same filter predicate as renderKanbanPlans to get the
        // currently-visible (filtered) plans.
        const visiblePlans = getFilteredKanbanPlans(); // extract the filter logic into a reusable fn
        const links = visiblePlans
            .filter(p => p.planFile)
            .map(p => toAgentRef(p.planFile))
            .join('\n');
        if (!links) {
            showToast('No plans to link in the current filter.', 'info');
            return;
        }
        navigator.clipboard.writeText(links).then(() => {
            const oldText = kanbanLinkAllBtn.textContent;
            kanbanLinkAllBtn.textContent = 'Copied!';
            setTimeout(() => { kanbanLinkAllBtn.textContent = oldText; }, 2000);
        });
    });
}
```

**Refactor note:** Extract the filter predicate currently inline in
`renderKanbanPlans` into a `getFilteredKanbanPlans()` helper so both the render
and Link All use the same filtered set. This avoids drift between what's
displayed and what's copied.

**Change 7 — Reset complexity filter on `activateKanbanTabAndSelectPlan`.**

In the `activateKanbanTabAndSelectPlan` handler (line 420-425), add:
```javascript
kanbanFilters.complexity = '';
if (kanbanComplexityFilter) kanbanComplexityFilter.value = '';
```
so the review-plan navigation isn't narrowed by a stale complexity filter.

## Verification Plan

1. **Link All basic test:** Open the Kanban Plans tab with several plans visible.
   Click "Link all". Paste into a text editor. Confirm one agent-ref link per
   visible plan appears.
2. **Link All + filter test:** Apply a workspace + column filter. Click "Link
   all". Confirm only the filtered plans' links are copied.
3. **Complexity filter test:** Select "High (7-10)". Confirm only plans with
   complexity 7-10 render. Confirm the complexity dot colors match.
4. **Complexity + Link All test:** Set complexity to "Medium (4-6)" and click
   "Link all". Confirm only medium-complexity plan links are copied.
5. **Unknown complexity test:** Select "Unknown". Confirm plans with
   `complexity === 'Unknown'` or empty render.
6. **Empty filter test:** Apply a filter that matches zero plans. Confirm "Link
   all" shows the "No plans to link" toast and copies nothing.
7. **Review-plan navigation test:** Set a complexity filter, then click "Review
   Plan" on a card in kanban.html. Confirm the project panel resets the
   complexity filter (doesn't hide the target plan).
8. **Reset on tab switch test:** Switch away from and back to the Kanban tab.
   Confirm the complexity filter persists or resets per existing filter
   persistence behavior (match whatever workspace/project/column filters do).
