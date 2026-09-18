# Plan: Sort Tickets by Priority Within Status Groups

## Goal
Within each status-group accordion in the Tickets sidebar, order tickets by priority (urgent first) instead of by creation date alone, so high-priority tickets rise to the top of their group instead of being buried below older low-priority ones.

### Problem
Tickets in the sidebar are sorted only by `dateCreated` (newest-first) within each status group. Priority is ignored, so high-priority tickets get buried below low-priority ones.

### Root Cause
- `getFilteredLinearIssues()` (`planning.js:10359`) sorts by `dateCreated` then `title` — no priority consideration.
- `getFilteredClickUpTasks()` (`planning.js:11260`) sorts by `dateCreated` then `title` — no priority consideration.
- `_groupTicketsByStatus()` (`planning.js:10421`) groups an already-sorted array and **preserves each group's internal order** (Map insertion order + array push order). Group *order* is set separately by `_ticketStatusOrder()`. So whatever order the filter functions produce is exactly what the user sees inside each status group.

**Consequence:** the fix belongs in the sort inside each filter function. If the filtered array is ordered by (priority, then date), the group builder carries that order straight into each status group — no change to the grouping helper is needed.

## Metadata
- **Tags:** frontend, ui, bugfix
- **Complexity:** 3

## User Review Required
- None. Both providers already expose priority (Linear as a numeric field, ClickUp as a `priority` object) and both are already rendered as the priority dot on each card, so no new data or product decision is introduced — only the sort order of existing data.

## Complexity Audit

### Routine
- Single file (`src/webview/planning.js`), two localized sort comparators.
- Reuses the exact priority-extraction idiom already present in the card renderers (`_renderLinearTicketCard`, `_renderClickUpTicketCard`) and the priority-name helpers.
- No new state, no message passing, no backend change.

### Complex / Risky
- **Provider-shape divergence (the one real gotcha):** Linear `priority` is a **number**; ClickUp `priority` is an **object** (`{id, priority, color, orderindex}`) or `null`. A single generic comparator cannot treat both correctly — see the superseded callout under Approach. Each filter function must use its own provider's shape.

## Edge-Case & Dependency Audit
- **Race Conditions:** None. Pure client-side sort of an in-memory array during render.
- **Security:** None. No new input, no injection surface.
- **Side Effects:** The filter functions are also consumed by the "select all" id-collectors (`planning.js:9091/9118/9143`), which only `.map()` to ids — order is irrelevant there. Normal-mode rendering always groups by status (Linear render at `10702→10722`, ClickUp render at `11317→11323`); there is no flat/ungrouped consumer whose order matters. Drill-down subtask lists render via `_renderClickUpTicketCard`/`_renderLinearTicketCard` directly on `_drillDownSubtasks` (not via the filter functions), so subtask ordering is out of scope for this change.
- **Dependencies & Conflicts:** None. No other plan touches these comparators.

## Dependencies
- None.

## Adversarial Synthesis
Key risks: (1) applying one generic `a.priority || 99` comparator across both providers silently breaks ClickUp because its `priority` is a truthy object, yielding `NaN` and an unstable sort; (2) treating Linear/ClickUp priority `0`/missing as "highest" would push unprioritised tickets to the top instead of the bottom. Mitigations: use a per-provider comparator that extracts `orderindex` for ClickUp and reads the numeric field for Linear, and map `0`/missing → `99` so no-priority tickets sink to the bottom of their group; keep the existing date+title comparison as the secondary/tiebreak key so same-priority ordering is unchanged.

## Proposed Changes

### `src/webview/planning.js`

**Context.** Two sibling filter functions each end in a `.sort()` that is currently `dateCreated`-primary, `title`-tiebreak. `_groupTicketsByStatus()` (line 10421) preserves the order it receives. Priority semantics are already established by the codebase's own helpers:
- **Linear** (`_linearPriorityName`, `planning.js:721`): `priority` is a number — `0`=No priority, `1`=Urgent, `2`=High, `3`=Normal, `4`=Low.
- **ClickUp** (`_clickUpPriorityName`/`_availableClickUpPriorities`, `planning.js:740`/`754`): `priority` is an object; `Number(task.priority?.orderindex)` → `1`=Urgent … `4`=Low; `null`/missing = No priority. (Range is **1–4**, not 1–5.)

> **Superseded:** "Modify `_groupTicketsByStatus()` to sort each group's array by priority … This is cleaner than modifying both filter functions," using `const pa = a.priority || 99; … return pa - pb;`.
> **Reason:** `_groupTicketsByStatus()` is provider-agnostic (it only receives a `statusGetter`) and is called from two sites with two different priority shapes, so it would need a new `priorityGetter` parameter threaded through *both* call sites — that is more surface, not less. Worse, the proposed generic comparator is a correctness bug: ClickUp's `priority` is an **object**, so `a.priority || 99` yields the object (truthy), and `object - object` is `NaN`, leaving the ClickUp sort effectively broken. The snippet's "1=urgent, 5=low" for ClickUp is also wrong (ClickUp `orderindex` runs 1–4).
> **Replaced with:** Add priority as the **primary** sort key inside each filter function, using that provider's own shape. Because grouping preserves intra-group order and group order is set independently by `_ticketStatusOrder()`, a (priority, date, title) ordering in the filtered array produces exactly "priority-first within each status group."

**Logic + Implementation.**

Change 1 — `getFilteredLinearIssues()` (`planning.js:10379–10384`). Replace the return-sort with a priority-primary comparator:
```js
// Priority first (urgent first), then newest-first by creation date, with a
// stable title tiebreak so the order doesn't flicker across re-renders.
// Linear priority is a number: 0=No priority, 1=Urgent … 4=Low. Map 0 → 99 so
// unprioritised issues sink to the bottom of their status group.
return filtered.sort((a, b) => {
    const pa = a.priority || 99;
    const pb = b.priority || 99;
    if (pa !== pb) return pa - pb;
    const aTime = a.dateCreated ? new Date(a.dateCreated).getTime() : 0;
    const bTime = b.dateCreated ? new Date(b.dateCreated).getTime() : 0;
    if (bTime !== aTime) return bTime - aTime;
    return (a.title || '').localeCompare(b.title || '');
});
```

Change 2 — `getFilteredClickUpTasks()` (`planning.js:11278–11283`). Replace the return-sort with a priority-primary comparator that extracts `orderindex`:
```js
// Priority first (urgent first), then newest-first by creation date, with a
// stable title tiebreak. ClickUp priority is an OBJECT ({priority,color,
// orderindex}) or null — extract orderindex exactly as _renderClickUpTicketCard
// / _clickUpPriorityName do. 1=Urgent … 4=Low; missing/0 → 99 so unprioritised
// tasks sink to the bottom of their status group.
return filtered.sort((a, b) => {
    const pa = Number(a.priority?.orderindex) || 99;
    const pb = Number(b.priority?.orderindex) || 99;
    if (pa !== pb) return pa - pb;
    const aTime = a.dateCreated ? new Date(a.dateCreated).getTime() : 0;
    const bTime = b.dateCreated ? new Date(b.dateCreated).getTime() : 0;
    if (bTime !== aTime) return bTime - aTime;
    return (a.title || '').localeCompare(b.title || '');
});
```

Change 3 — Update the two "Newest-first by creation date …" comments immediately above each sort to describe the new "priority-first, then newest" ordering so the doc comment matches the code.

**Edge Cases.**
- `Number("0") || 99` → `99`; `Number(undefined) || 99` → `99` — both map "no priority" to the bottom, matching intent.
- Same-priority tickets retain the existing newest-first-by-date, then title ordering — no regression for the common case where priority is uniform.
- `_groupTicketsByStatus()` is left untouched, so group ordering and the collapse-state cache comment are unaffected.

## Verification Plan

### Automated Tests
- Out of scope for this task per session directive (skip tests, skip compilation). No unit-test harness change requested.

### Manual Verification
1. Open the Tickets tab with a Linear workspace that has mixed-priority tickets in one status. Confirm Urgent (1) tickets appear at the top of the status group, then High/Normal/Low, then "No priority" tickets last.
2. Repeat for a ClickUp workspace — confirm the same ordering and that the ClickUp list is not scrambled (the previous generic-comparator bug would have left it unsorted/unstable).
3. Confirm within a single priority level, tickets remain newest-first by creation date.
4. Confirm status-group *order* (To Do → In Progress → Blocked → Review → Done) is unchanged and collapse/expand still works.

## Recommendation
Complexity 3 → **Send to Intern.** Straightforward two-comparator change; the only thing the implementer must not miss is the per-provider priority shape (Linear number vs ClickUp `orderindex` object) — do not collapse the two comparators into one generic `a.priority || 99`.

## Completion Summary
Implemented priority-first sorting within status groups for both Linear and ClickUp tickets in `src/webview/planning.js`. Replaced the date-primary comparators in `getFilteredLinearIssues()` and `getFilteredClickUpTasks()` with per-provider comparators that sort by priority (urgent first, no-priority last), then creation date, then title. Updated the associated comments, plus the `_groupTicketsByStatus()` and render-list comments, to reflect the new ordering. No issues were encountered; `node --check` passed and `git diff --check` reported no whitespace errors. Tests and compilation were skipped per the session directive.

## Review Findings
Direct reviewer pass completed — both comparators verified present and correct in `src/webview/planning.js` (Linear at `:10360-10368` using `a.priority || 99`; ClickUp at `:11215-11223` using `Number(a.priority?.orderindex) || 99`), with matching comment updates in both filter functions and both render-list sites. `_groupTicketsByStatus` (`:10405`) confirmed untouched. No CRITICAL or MAJOR findings; two academic NITs noted (deferred): Linear `a.priority || 99` relies on JS coercion if priority were ever a string (plan says it's a number — no issue), and ClickUp `Number("0") || 99` → `99` correctly sinks a hypothetical zero-orderindex to bottom (plan says range is 1–4 — no issue). Verification: `node --check` passed; the "select all" id-collectors only `.map()` to ids so sort order is irrelevant there. No code fixes applied. Remaining risk: none material.
