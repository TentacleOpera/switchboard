# Feature: Link All Button + Complexity Filter in Project Panel Kanban Plans Tab

## Goal

Add a "Link All" button and a complexity filter to the Kanban Plans tab in
`project.html`/`project.js`, achieving parity with the Planning panel's Tickets
tab Link All capability and enabling complexity-based filtering of plans.

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
**Tags:** feature, ui, ux
**Complexity:** 3

## User Review Required
Yes — confirm the complexity filter ranges (Unknown / Low 1-3 / Medium 4-6 / High
7-10) match expectations, and confirm the Link All output format (one
`toAgentRef(path)` per line, plain absolute paths) is the desired clipboard
payload.

## Complexity Audit

### Routine
- Add a `#kanban-complexity-filter` `<select>` to the kanban controls strip in
  `project.html` (static HTML — the controls strip is NOT wiped by render).
- Add `complexity: ''` to the `kanbanFilters` object (line 289) and an element
  ref (near line 204).
- Wire the complexity filter `change` handler to set `kanbanFilters.complexity`
  and call `renderKanbanPlans()`.
- Apply the complexity filter in the plan-filter predicate inside
  `renderKanbanPlans`.
- Wire the Link All button to collect filtered plan file paths and copy them to
  clipboard (mirroring the Copy Link per-plan button which already uses
  `navigator.clipboard.writeText(toAgentRef(path))`).
- Reset the complexity filter in `activateKanbanTabAndSelectPlan` alongside the
  other filter resets.

### Complex / Risky
- **Link All button placement (CRITICAL).** `renderKanbanPlans()` calls
  `kanbanListPane.innerHTML = ''` (line 1116) on every render, then rebuilds the
  toggle row dynamically (lines 1117-1125). Any button placed in static HTML
  inside `#kanban-list-pane` is DESTROYED on the first render. The Link All
  button MUST be created dynamically inside the toggle-row build in
  `renderKanbanPlans()`, and its click handler attached there — exactly like the
  existing toggle button. A static HTML placeholder may be kept in
  `project.html` for initial scaffold but will be replaced on first render.
- **Filter composition.** The complexity filter must compose with the existing
  workspace/project/column/search filters. The render path
  (`renderKanbanPlans`) reads `kanbanFilters` — a new `kanbanFilters.complexity`
  field must be threaded through the filter predicate without breaking the
  existing filter logic.
- **Link All output format.** The per-plan "Copy Link" button (project.js line
  1181) uses `toAgentRef(path)` to produce an agent-reference link. Link All
  should produce one such link per line for all filtered plans, matching the
  Tickets tab's bulk-copy behavior. `toAgentRef` is defined in `sharedUtils.js`
  line 7 (globally available in the webview) and is already used at project.js
  lines 1181 and 1589.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The Link All handler reads `_kanbanPlansCache`
  synchronously through the same filter predicate as the render. No async fetch
  is triggered between filter application and clipboard copy.
- **Security:** `toAgentRef` returns the path as-is (no prefix, no
  transformation). Clipboard write is user-initiated. No injection risk.
- **Side Effects:** Clipboard overwrite. The button shows "Copied!" for 2 seconds
  (matching the per-plan Copy Link pattern at line 1183).
- **Dependencies & Conflicts:** None. No new imports needed — `toAgentRef` is
  global, `showToast` exists at line 78, `navigator.clipboard` is already used.
- **Plans with no `planFile`:** The Copy Link button only renders when
  `plan.planFile` exists (line 1160). Link All must skip plans without a
  `planFile`.
- **Empty filtered view:** Link All on an empty list should show a "No plans to
  link" toast via `showToast` and copy nothing.
- **Complexity value normalization:** `plan.complexity` can be `'Unknown'`,
  `undefined`, `null`, `''`, or a string integer `'1'`–`'10'`. The filter
  dropdown offers ranges (Unknown / Low 1-3 / Medium 4-6 / High 7-10) and parses
  the string to int for range comparison. The "Unknown" option must use a
  case-insensitive comparison (`String(c).toLowerCase() === 'unknown'` or empty)
  to handle casing variants.
- **Existing search input:** The complexity filter is independent of the text
  search; both must apply simultaneously.

## Dependencies
- None — this plan is self-contained.

## Adversarial Synthesis
Key risks: (1) the Link All button placed in static HTML would be destroyed by
`renderKanbanPlans()` which clears `kanbanListPane.innerHTML` on every render —
the button MUST be created dynamically inside the render function's toggle-row
build; (2) complexity value casing inconsistencies could cause the "Unknown"
filter to silently miss plans — use case-insensitive comparison; (3) line-number
references in the original plan conflated the element-ref location (line 204)
with the `kanbanFilters` object declaration (line 289). Mitigations: create the
button in the dynamic render path, normalize complexity strings, and correct all
line references to verified locations.

## Proposed Changes

### File: `src/webview/project.html`

**Change 1 — Add complexity filter to the kanban controls strip (after the column
filter `<select>`, line 1412, before the Import button at line 1413).**

The controls strip is static HTML and is NOT wiped by `renderKanbanPlans()`, so
this is safe as a static element.

```html
<select id="kanban-complexity-filter">
    <option value="">All Complexity</option>
    <option value="unknown">Unknown</option>
    <option value="1-3">Low (1-3)</option>
    <option value="4-6">Medium (4-6)</option>
    <option value="7-10">High (7-10)</option>
</select>
```

**Change 2 — Add Link All button to the kanban sidebar toggle row (static HTML
placeholder, around line 1420).**

> **NOTE:** This static HTML is a placeholder only. `renderKanbanPlans()` wipes
> `kanbanListPane.innerHTML` (line 1116) and rebuilds the toggle row dynamically
> on every render. The Link All button MUST also be created in the dynamic
> rebuild (see Change 6 below). This static HTML ensures the button is visible
> before the first render fires.

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

**Change 3 — Add complexity filter element reference and state.**

Add the element ref near line 204 (alongside the other kanban filter element
refs):
```javascript
const kanbanComplexityFilter = document.getElementById('kanban-complexity-filter');
```

Add `complexity: ''` to the `kanbanFilters` object at **line 289** (NOT line 203 —
the object is declared at 289):
```javascript
const kanbanFilters = { column: '', workspaceRoot: '', project: '', search: '', complexity: '' };
```

**Change 4 — Wire the complexity filter change handler (near line 1458, after
the `kanbanProjectFilter` change handler and before the `kanbanSearch` handler).**

```javascript
if (kanbanComplexityFilter) {
    kanbanComplexityFilter.addEventListener('change', () => {
        kanbanFilters.complexity = kanbanComplexityFilter.value;
        renderKanbanPlans();
    });
}
```

**Change 5 — Extract `getFilteredKanbanPlans()` helper and apply the complexity
filter.**

Extract the filter predicate currently inline in `renderKanbanPlans()` (lines
1099-1113) into a reusable `getFilteredKanbanPlans()` function so both the render
and Link All use the same filtered set. This avoids drift between what's
displayed and what's copied.

Replace the inline filter (lines 1099-1113):
```javascript
let filtered = _kanbanPlansCache.filter(plan => {
    if (kanbanFilters.column && plan.column !== kanbanFilters.column) return false;
    if (kanbanFilters.workspaceRoot && plan.workspaceRoot !== kanbanFilters.workspaceRoot) return false;
    if (kanbanFilters.project) {
        if (kanbanFilters.project === '__none__') {
            if (plan.project !== '') return false;
        } else if (plan.project !== kanbanFilters.project) {
            return false;
        }
    }
    if (kanbanFilters.search) {
        const searchLower = kanbanFilters.search.toLowerCase();
        if (!plan.topic.toLowerCase().includes(searchLower)) return false;
    }
    return true;
});
```

With a call to the new helper:
```javascript
let filtered = getFilteredKanbanPlans();
```

And add the helper function (place it just before `renderKanbanPlans`, around
line 1095):
```javascript
function getFilteredKanbanPlans() {
    return _kanbanPlansCache.filter(plan => {
        if (kanbanFilters.column && plan.column !== kanbanFilters.column) return false;
        if (kanbanFilters.workspaceRoot && plan.workspaceRoot !== kanbanFilters.workspaceRoot) return false;
        if (kanbanFilters.project) {
            if (kanbanFilters.project === '__none__') {
                if (plan.project !== '') return false;
            } else if (plan.project !== kanbanFilters.project) {
                return false;
            }
        }
        if (kanbanFilters.search) {
            const searchLower = kanbanFilters.search.toLowerCase();
            if (!plan.topic.toLowerCase().includes(searchLower)) return false;
        }
        if (kanbanFilters.complexity) {
            const c = String(plan.complexity || '').toLowerCase();
            if (kanbanFilters.complexity === 'unknown') {
                if (c !== 'unknown' && c !== '') return false;
            } else {
                const [lo, hi] = kanbanFilters.complexity.split('-').map(Number);
                const score = parseInt(plan.complexity, 10);
                if (isNaN(score) || score < lo || score > hi) return false;
            }
        }
        return true;
    });
}
```

> **Clarification:** The complexity filter uses `String(plan.complexity ||
> '').toLowerCase()` for the "Unknown" check to handle casing variants
> (`'Unknown'`, `'unknown'`, `null`, `undefined`, `''`). For range filters, it
> parses with `parseInt` and excludes NaN scores.

**Change 6 — Create the Link All button dynamically in `renderKanbanPlans()`
toggle-row build (lines 1117-1125) and wire its click handler.**

> **CRITICAL:** This is the fix for the static-HTML-wipe bug. The button must be
> created here because `kanbanListPane.innerHTML = ''` (line 1116) destroys any
> static content. The click handler must be attached here because the button
> element is recreated on every render.

After line 1124 (`toggleRow.appendChild(toggleBtn);`), add:
```javascript
const linkAllBtn = document.createElement('button');
linkAllBtn.id = 'kanban-link-all';
linkAllBtn.className = 'strip-btn';
linkAllBtn.title = 'Copy all filtered plan links to clipboard';
linkAllBtn.textContent = 'Link all';
linkAllBtn.addEventListener('click', () => {
    const visiblePlans = getFilteredKanbanPlans();
    const links = visiblePlans
        .filter(p => p.planFile)
        .map(p => toAgentRef(p.planFile))
        .join('\n');
    if (!links) {
        showToast('No plans to link in the current filter.', 'info');
        return;
    }
    navigator.clipboard.writeText(links).then(() => {
        const oldText = linkAllBtn.textContent;
        linkAllBtn.textContent = 'Copied!';
        setTimeout(() => { linkAllBtn.textContent = oldText; }, 2000);
    });
});
toggleRow.appendChild(linkAllBtn);
```

> **Note:** The button is appended BEFORE the toggle button in the toggle row.
> If the desired visual order is [Link all] [«], insert the Link All button
> before `toggleRow.appendChild(toggleBtn)`. Adjust insertion order to match the
> Tickets tab layout (`#tickets-link-all` appears before the toggle button at
> planning.html line 3531-3533).

**Change 7 — Reset complexity filter on `activateKanbanTabAndSelectPlan` (lines
422-427).**

In the `activateKanbanTabAndSelectPlan` handler, after the existing filter resets
(line 427), add:
```javascript
kanbanFilters.complexity = '';
if (kanbanComplexityFilter) kanbanComplexityFilter.value = '';
```
so the review-plan navigation isn't narrowed by a stale complexity filter.

## Verification Plan

> **SKIP COMPILATION:** Do NOT run `npm run compile` or any build step. The
> project is in a pre-compiled state for this session.
> **SKIP TESTS:** Do NOT run automated tests. The test suite will be run
> separately by the user.

### Manual Verification (via installed VSIX)

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
   `complexity === 'Unknown'` (case-insensitive), `null`, `undefined`, or empty
   render.
6. **Empty filter test:** Apply a filter that matches zero plans. Confirm "Link
   all" shows the "No plans to link" toast and copies nothing.
7. **Review-plan navigation test:** Set a complexity filter, then click "Review
   Plan" on a card in kanban.html. Confirm the project panel resets the
   complexity filter (doesn't hide the target plan).
8. **Reset on tab switch test:** Switch away from and back to the Kanban tab.
   Confirm the complexity filter persists (matching the existing
   workspace/project/column filter persistence behavior — `kanbanFilters` is a
   module-level object that survives tab switches).
9. **Button persistence test:** Change any filter (workspace, project, column,
   or search). Confirm the "Link all" button remains visible and clickable after
   re-render (verifies the dynamic-creation fix).
10. **Plans without planFile test:** Confirm plans without a `planFile` are
    excluded from the Link All output but still render in the list.

## Recommendation
Complexity is 3 (routine: two files, reuses existing patterns, one critical
placement fix). **Send to Coder.**
