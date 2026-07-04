# Fix: Review Plan navigation does not scroll sidebar to the actual card position

## Goal

When the user clicks **Review Plan** on a card in `kanban.html`, the extension opens `project.html`, activates the Kanban tab, and is supposed to scroll the sidebar list so the matching plan card is centered. The sidebar *does* scroll, but it lands at the wrong position — the target card is not actually brought into view (often off-screen or only partially visible).

### Problem Analysis & Root Cause

**Flow under test** (`src/webview/kanban.html` → `src/webview/project.js`):

1. `kanban.html` `.card-btn.review` click handler posts `{ type: 'reviewPlan', ... }` (<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html" lines="5315-5329" />).
2. The extension forwards this to `project.html` as `{ type: 'activateKanbanTabAndSelectPlan', ... }`.
3. `project.js` sets `_pendingKanbanSelection`, clears all filters to the widest view, clicks the Kanban tab, and calls `tryResolvePendingKanbanSelection()` immediately (<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/project.js" lines="676-714" />).
4. The Kanban tab click fires `fetchKanbanPlans`; the extension replies with `kanbanPlansReady`.
5. The `kanbanPlansReady` handler applies the stashed filter intent (workspace/project/column), calls `renderKanbanPlans()` (which does `kanbanListPane.innerHTML = ''` and re-appends every item), then calls `tryResolvePendingKanbanSelection()` (<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/project.js" lines="544-594" />).
6. `tryResolvePendingKanbanSelection()` finds the `.kanban-plan-item` and calls `itemDiv.scrollIntoView({ behavior: 'smooth', block: 'center' })` synchronously (<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/project.js" lines="1914-1920" />).

**Root cause:** `scrollIntoView({ behavior: 'smooth' })` is invoked **synchronously in the same tick** as `renderKanbanPlans()`, which has just wiped and rebuilt `#kanban-list-pane` via `innerHTML = ''`. At the moment `scrollIntoView` captures the target offset:

- The scroll container (`#kanban-list-pane`, `overflow-y: auto` — <ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/project.html" lines="203-211" />) has just transitioned from empty (no scrollbar) to overflowing. The scrollbar appearance shifts the content width and the layout has not fully settled.
- `behavior: 'smooth'` snapshots the destination position at call time and animates toward it asynchronously. Any subsequent layout shift (scrollbar appearing, the toggle row at the top settling, or a second `kanbanPlansReady` push re-rendering the list) invalidates that snapshot, so the animation terminates at a stale offset.

This is the classic "scrollIntoView lands in the wrong place right after innerHTML rebuild" race. The sidebar scrolls (the animation starts) but to a position computed before layout was stable.

A secondary contributor: the extension can emit `kanbanPlansReady` more than once during this navigation (initial fetch + filter narrowing). The first call starts a smooth scroll; a second `renderKanbanPlans()` wipes the DOM and removes the element the smooth scroll is animating toward, aborting it mid-flight.

## Metadata

- **Tags:** bugfix, ui, ux
- **Complexity:** 3
- **Files:** `src/webview/project.js`

## User Review Required

This plan changes the scroll behavior from smooth (animated) to instant (non-animated). The user should verify: (1) the instant scroll feels acceptable for programmatic "Review Plan" navigation — there is no smooth animation, the card snaps into view; (2) the card is correctly centered in the sidebar after navigation; (3) no visual jank or flash occurs when the deferred scroll fires (typically ~2 frames after render).

## Complexity Audit

### Routine

The change is confined to a single function (`tryResolvePendingKanbanSelection`, starting at line 1854) and possibly the `kanbanPlansReady` render path in `src/webview/project.js`. No backend/extension-host changes, no data migrations, no new APIs. The fix is a well-understood DOM timing pattern (defer scroll until layout settles + use instant scroll for programmatic navigation).

### Complex / Risky

Risk is low but non-zero: deferring the scroll means the selection highlight and preview load still happen synchronously, so the only behavioral change is *when* the scroll fires. Must ensure the deferred scroll still targets the correct element after any intervening re-render. The double-rAF pattern is well-established but depends on browser layout timing guarantees; if a second `kanbanPlansReady` re-render occurs between the first and second rAF, the re-query-by-planId guard prevents scrolling a detached node.

## Edge-Case & Dependency Audit

- **Re-render races:** If a second `kanbanPlansReady` arrives between scheduling the deferred scroll and firing it, the target `.kanban-plan-item` may have been recreated. The deferred callback must re-query the element by `data-plan-id` rather than capturing a stale node reference.
- **Item hidden by filters after narrowing:** Already handled by the existing filter-clear fallback (lines 1880-1914). The deferred scroll must preserve this fallback path.
- **Sidebar collapsed state:** `state.kanbanListCollapsed` hides list children via CSS (<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/project.html" lines="554-568" />). When collapsed, `scrollIntoView` is a no-op (element has no layout box). Not a regression — current behavior is identical — but the deferred callback should guard `getBoundingClientRect()` to avoid wasted work.
- **`block: 'center'` with very tall items:** A card taller than the viewport cannot be centered; `scrollIntoView` aligns it to the top. Acceptable and unchanged.
- **Epics tab:** `tryResolvePendingEpicSelection` (line 1936) has the same synchronous `scrollIntoView` pattern and the same bug class. This plan scopes the fix to the Kanban path per the reported issue, but the same deferral should be applied to the epics resolver for consistency (noted as an optional follow-up, not a dependency).
- **No external dependencies.** Pure client-side JS.

## Dependencies

None. The epic sibling plan touches `renderKanbanMetaBar` (line 1962) in the same file but does not conflict with changes to `tryResolvePendingKanbanSelection` (line 1854).

## Adversarial Synthesis

Key risks: (1) A second `kanbanPlansReady` re-render between the two rAF frames could wipe the DOM before the deferred scroll fires, though the re-query-by-planId guard and `_pendingKanbanSelection` null-check prevent stale-node scrolls. (2) `behavior:'auto'` respects the CSS `scroll-behavior` property; if a future theme adds `scroll-behavior: smooth` to `#kanban-list-pane`, the instant-scroll guarantee is lost — `behavior:'instant'` would be more robust against CSS overrides. Mitigations: re-query eliminates stale-node risk; the null-check prevents duplicate deferred scrolls; consider using `'instant'` instead of `'auto'` to future-proof.

## Proposed Changes

### `src/webview/project.js` — `tryResolvePendingKanbanSelection()`

Replace the direct `scrollIntoView` calls (lines 1899 and 1916) with a deferred, re-querying helper that waits for layout to settle. Use `behavior: 'auto'` (instant) for programmatic navigation so the position is applied in one frame rather than animated toward a potentially-stale target.

Add a small helper near the top of the function scope (or as a module-local function):

```js
// Scroll a freshly-rendered plan item into view after layout settles.
// Re-queries the element by planId so a re-render between schedule and
// fire does not scroll a detached/stale node. Uses instant (non-smooth)
// scrolling because the destination is computed by us, not animated by
// the user, and smooth scrolling races with post-innerHTML layout shifts
// (scrollbar appearance, toggle-row settle).
function scrollPlanItemIntoView(planId) {
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const el = kanbanListPane && kanbanListPane.querySelector(
                `.kanban-plan-item[data-plan-id="${planId}"]`
            );
            if (el) {
                el.scrollIntoView({ behavior: 'auto', block: 'center' });
            }
        });
    });
}
```

Then update the two call sites:

**Call site A — filter-clear fallback path (lines 1897-1904):**
```js
const revealed = kanbanListPane && kanbanListPane.querySelector(`.kanban-plan-item[data-plan-id="${match.planId}"]`);
if (revealed) {
    scrollPlanItemIntoView(match.planId);
    document.querySelectorAll('.kanban-plan-item').forEach(el => el.classList.remove('selected'));
    revealed.classList.add('selected');
    loadKanbanPlanPreview(match);
    _pendingKanbanSelection = null;
    return;
}
```

**Call site B — normal resolution path (lines 1916-1920):**
```js
scrollPlanItemIntoView(match.planId);
document.querySelectorAll('.kanban-plan-item').forEach(el => el.classList.remove('selected'));
itemDiv.classList.add('selected');
loadKanbanPlanPreview(match);
_pendingKanbanSelection = null;
```

Rationale for the double `requestAnimationFrame`: the first rAF fires before the next paint, the second fires after the browser has committed layout for the new content (including scrollbar appearance). This is the standard, framework-agnostic fix for "scrollIntoView immediately after innerHTML rebuild lands wrong."

### Optional consistency fix (same file) — `tryResolvePendingEpicSelection()`

Apply the same deferral pattern to line 1936 (`itemDiv.scrollIntoView({ behavior: 'smooth', block: 'center' })`) via an analogous `scrollEpicItemIntoView(planId)` helper. Same root cause, same fix. Marked optional because the reported issue is specific to the Kanban Review Plan flow, but leaving it creates an inconsistent UX between tabs.

## Verification Plan

1. **Reproduce the original bug first** (baseline): open `kanban.html`, scroll a plan card far down in a workspace with many plans, click **Review Plan**. Confirm the sidebar in `project.html` scrolls but the target card is not centered/visible.
2. **Apply the fix** and reload the webview.
3. **Happy path:** Repeat step 1. Confirm the sidebar scrolls and the target card is centered in `#kanban-list-pane`. Confirm the card is highlighted (`.selected`) and the preview pane loads the correct plan content.
4. **Filter-narrowing path:** Click Review Plan on a card whose workspace/project/column differs from the currently-active filter in `project.html`. Confirm filters narrow correctly *and* the card is scrolled into view after the narrowed re-render.
5. **Filter-hidden fallback:** Set a filter in `project.html` that would hide the target plan, then trigger Review Plan from `kanban.html`. Confirm filters clear, the card appears, and is scrolled into view (the existing fallback path, now deferred).
6. **Many plans / long list:** Test with a workspace containing 50+ plans so the target is well below the fold. Confirm accurate centering.
7. **Rapid double-navigation:** Click Review Plan, then immediately click Review Plan on a different card before the first navigation settles. Confirm the second card ends up selected and scrolled into view (no stale-scroll residue).
8. **Sidebar collapsed:** Collapse the kanban sidebar, trigger Review Plan. Confirm no errors are thrown (deferred scroll guard handles no-box case). Expand sidebar and confirm the correct card is selected.
9. **No regressions:** Manually click a plan item in the sidebar (normal click handler, line 1792) — confirm selection/preview still works (this path is unchanged).

**Recommendation:** Send to Intern

## Review Findings

Implementation verified present in `src/webview/project.js` (commit `13044c6`): `scrollPlanItemIntoView` and `scrollEpicItemIntoView` helpers added with double-rAF deferral and re-query-by-planId guards; applied to all three call sites (Kanban filter-clear fallback line 1931, Kanban normal path line 1948, Epic resolver line 1968). Review fix: changed `behavior: 'auto'` to `behavior: 'instant'` in both helpers per the plan's own Adversarial Synthesis recommendation, future-proofing against any future CSS `scroll-behavior: smooth` override. `node --check` passes with no syntax errors. No `scroll-behavior` CSS exists anywhere in `src/webview/` today. Remaining risk: rapid double-navigation (click Review Plan on A then B before settle) causes a single-frame flash as both deferred scrolls fire — acceptable since both are instant and B wins. No CRITICAL or MAJOR findings remain.
