# Fix Sidebar Scroll-to-Top on Plan Creation in Project.html

## Goal

When a plan is created via the kanban "Create Plan" button, the project panel opens and switches to the Kanban tab, but the sidebar list does not scroll to the newly created plan card. The card is completely off-screen, forcing the user to hunt for it manually before they can click Edit.

### Problem Analysis & Root Cause

**Flow:**
1. `createDraftPlanTicket()` calls `activatePlanInProjectPanel(planFileRelative, workspaceRoot, true)` with `autoEdit: true`.
2. `activatePlanInProjectPanel` (KanbanProvider.ts:248) sends `activateKanbanTabAndSelectPlan` to the project webview.
3. The project webview (project.js:662) sets `_pendingKanbanSelection`, clears all filters, and clicks the Kanban tab button.
4. The Kanban tab click handler fires `fetchKanbanPlans` to the backend.
5. When `kanbanPlansReady` arrives, `tryResolvePendingKanbanSelection()` (line 1692) searches the cache for the matching plan.
6. If found, it calls `scrollPlanItemIntoView(planId)` (line 1754) and `loadKanbanPlanPreview(match)`.

**Root cause (two contributing mechanisms):**

1. **Layout timing (primary, confirmed).** `scrollPlanItemIntoView` (line 1666) uses a double `requestAnimationFrame` before calling `el.scrollIntoView({ behavior: 'instant', block: 'center' })`. Even when the element is found, the double-rAF can fire before the list's `innerHTML` has fully laid out (scrollbar appearance, toggle-row settle). `scrollIntoView` then silently no-ops or scrolls to a stale offset because the element has not reached its final position/height.

2. **Cache/render availability (secondary).** If the freshly created plan is not yet in `_kanbanPlansCache` when the first `kanbanPlansReady` arrives, `tryResolvePendingKanbanSelection` increments a retry counter and returns. It retries on subsequent `kanbanPlansReady` messages; after the retry cap it clears filters, re-fetches once, and gives up.

> **Superseded:** Attribute the miss primarily to a DB-write race — "the plan was just written to the DB but the first `fetchKanbanPlans` query raced ahead of the DB write."
> **Reason:** `_createInitiatedPlan` **awaits** `_registerPlan(...)` (TaskViewerProvider.ts:18823) — the DB row is committed *before* `activatePlanInProjectPanel` is invoked and before the webview fires its first `fetchKanbanPlans`. So a genuine "query outran the write" race is unlikely to be the dominant cause. The dominant, reproducible cause is **layout timing** (mechanism 1): the element exists but `scrollIntoView` fires against an unsettled layout. Cache-availability (mechanism 2) is a real but secondary tail case (e.g. filtered-cache mismatch), already partly handled by the existing retry/clear-filters fallback.
> **Replaced with:** Prioritize the layout-timing fixes (scroll-reset + post-render fallback, Proposed Changes §1 and §2). Treat the retry hardening (§3) as a secondary, optional safety net for the cache tail case — not the main fix.

### Background Context

`tryResolvePendingKanbanSelection` has **two** retry-increment sites, both currently capped at `>= 3`:
- Line 1704 (`if (!match)`): plan not in the filtered cache → after 3 tries, widen filters and re-fetch.
- Line 1748 (`if (!itemDiv)` after force-clearing filters): confirmed in cache but not rendered → after 3 tries, drop selection and re-fetch.

Any change to the retry cap must be applied consistently to **both** sites, or the two paths will disagree.

## Metadata
**Tags:** bugfix, ui, frontend
**Complexity:** 3
**Project:** switchboard

## User Review Required

The improve pass reframed the root cause from "DB-write race" to "layout timing" (see Superseded callout) and demoted the retry-count increase to an optional safety net. Confirm you're comfortable shipping §1 + §2 as the primary fix. §3 (retry hardening) is included but marked optional — decide whether to include it.

## Complexity Audit

### Routine
- Single-file frontend change (`src/webview/project.js`).
- §1 and §2 are small, self-contained additions to existing functions (`scrollPlanItemIntoView`, the `activateKanbanTabAndSelectPlan` handler).

### Complex / Risky
- §3 touches retry control flow with a `setTimeout`-driven re-fetch, which can double-fire `fetchKanbanPlans` and interacts with the existing filter-clearing fallback. This is the one moderate risk and is why the plan is scored 3, not 1–2.

## Edge-Case & Dependency Audit

- **Race Conditions:** The `setTimeout` fallback in §2 could fire after the user has already scrolled manually — mitigated by re-checking the element's visible bounds before adjusting `scrollTop`. The §3 delayed re-fetch can race the natural `kanbanPlansReady`-driven retry, producing a redundant board fetch — benign but worth gating on `_pendingKanbanSelection` still being set (as the snippet does).
- **Security:** None.
- **Side Effects:** Resetting `kanbanListPane.scrollTop = 0` on `activateKanbanTabAndSelectPlan` discards any prior scroll position — acceptable because this message only fires on explicit plan activation, not on ordinary tab switches.
- **Dependencies & Conflicts:** Depends on `kanbanListPane` being the correct scroll container and on new plans sorting to the top (by `updatedAt` desc). If sort order changes so the newest plan is *not* at the top, the scroll-to-0 in §1 becomes a weak fallback and §2's `scrollIntoView`/offset path becomes the real mechanism — still correct, just less of a shortcut.

## Dependencies

- None.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) `scrollIntoView` racing an unsettled layout (the actual bug), (2) a `setTimeout` fallback firing after the user manually scrolls, (3) a delayed re-fetch double-firing `fetchKanbanPlans`. Mitigations: reset `scrollTop` to 0 up front and add a bounds-checked `offsetTop` fallback after the double-rAF (both cheap, both address the layout-timing root cause); keep the optional retry hardening gated on `_pendingKanbanSelection` and apply any cap change to **both** retry sites (lines 1704 and 1748) so they stay consistent.

## Proposed Changes

### `src/webview/project.js` — `activateKanbanTabAndSelectPlan` handler (line ~662)

**Context:** The handler sets `_pendingKanbanSelection`, resets `_pendingKanbanSelectionRetries`, clears filters, and clicks the Kanban tab (lines 662–692).

**Logic:** Reset the sidebar pane's scroll position to the top immediately, so even if `scrollIntoView` later no-ops, the user is looking at the top of the list where the newest plan sorts.

**Implementation** (after setting `_pendingKanbanSelection`, ~line 667):
```javascript
if (kanbanListPane) {
    kanbanListPane.scrollTop = 0;
}
```

**Edge Cases:** If `kanbanListPane` is null (tab not yet rendered), the guard no-ops; §2's fallback still runs on the eventual render.

### `src/webview/project.js` — `scrollPlanItemIntoView` (line ~1666)

**Context:** Currently a double-rAF then `el.scrollIntoView({ behavior: 'instant', block: 'center' })`.

**Logic:** After the `scrollIntoView` call, add a short `setTimeout` that re-checks whether the element is actually within the pane's visible bounds; if not (layout settled after the rAF), explicitly set `scrollTop` from the element's `offsetTop`.

**Implementation:**
```javascript
function scrollPlanItemIntoView(planId) {
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const el = kanbanListPane && kanbanListPane.querySelector(
                `.kanban-plan-item[data-plan-id="${planId}"]`
            );
            if (el) {
                el.scrollIntoView({ behavior: 'instant', block: 'center' });
                // Fallback: if scrollIntoView raced layout, correct via offsetTop.
                setTimeout(() => {
                    if (kanbanListPane) {
                        const elRect = el.getBoundingClientRect();
                        const paneRect = kanbanListPane.getBoundingClientRect();
                        if (elRect.top < paneRect.top || elRect.bottom > paneRect.bottom) {
                            kanbanListPane.scrollTop = el.offsetTop - kanbanListPane.clientHeight / 2;
                        }
                    }
                }, 50);
            }
        });
    });
}
```

**Edge Cases:** Bounds check prevents yanking the view if the element is already visible (e.g. user scrolled). `el` is captured in closure — if the list re-renders within the 50ms window the node may be detached; `getBoundingClientRect` on a detached node returns zeros, and the bounds check would then set `scrollTop` harmlessly toward 0. Acceptable; re-querying by `planId` inside the timeout is a safer variant if this proves flaky in testing.

### `src/webview/project.js` — retry hardening (OPTIONAL, lines ~1704 and ~1748)

**Context:** Two retry sites both cap at `>= 3`.

**Logic:** If runtime observation shows the cache tail case (mechanism 2) still drops selections, raise the cap and add a single delayed re-fetch. **Apply the cap change to both sites** to keep them consistent.

**Implementation** (at the `!match` site, line ~1704 — and mirror the cap at line ~1748):
```javascript
if (!match) {
    if (++_pendingKanbanSelectionRetries >= 5) {  // was 3 — update BOTH retry sites
        // ... existing widen-filters + re-fetch fallback ...
    } else {
        setTimeout(() => {
            if (_pendingKanbanSelection) {
                vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
            }
        }, 500);
    }
    return;
}
```

**Edge Cases:** The delayed re-fetch is gated on `_pendingKanbanSelection` still being set, so it self-cancels once resolved. Ship this only if §1 + §2 don't fully resolve the miss in testing — it treats the secondary cause and adds control-flow surface.

## Verification Plan

> Session directive: automated tests and compilation are **not** run as part of this planning pass. Steps below are for the implementer.

### Automated Tests
- No existing automated test covers this DOM-coupled scroll behavior. If a webview DOM harness exists, assert `scrollPlanItemIntoView` sets `scrollTop` toward the target's `offsetTop` when the element is out of bounds. Otherwise manual verification is the gate.

### Manual Verification
1. Create a new plan via the kanban "Create Plan" button → project panel opens to the Kanban tab.
2. Sidebar scrolls to show the new plan card (visible without manual scrolling).
3. Card is selected (highlighted) and the preview pane shows the plan content.
4. Auto-edit mode activates (editor textarea appears).
5. Create a plan while the sidebar has many plans and is scrolled to the bottom → it scrolls to the new card at the top.
6. Create a plan while the Kanban tab is already open → scroll still works.
7. Scroll manually right after creation → the §2 fallback does **not** yank the view back if the card is already visible.

## Recommendation

**Send to Intern** (complexity 3). §1 + §2 are localized and low-risk. Flag §3 to the implementer as optional and only-if-needed, since it adds control-flow surface for the secondary cause.

## Completion Report

Implemented the §1 and §2 layout-timing fixes in `src/webview/project.js`. On `activateKanbanTabAndSelectPlan` the kanban list pane now resets `scrollTop` to 0 immediately, and `scrollPlanItemIntoView` schedules a 50 ms fallback that re-queries the live element, checks its visible bounds, and corrects `scrollTop` using viewport-rect math instead of `offsetTop` so it works regardless of `offsetParent`. The optional §3 retry-hardening change was not applied because the plan identifies it as optional and adds control-flow surface. `node --check` passed for `project.js`.

## Review Findings

Reviewed the committed implementation (commit `abed6f9`, `src/webview/project.js` +28 lines) against the plan. §1 (`scrollTop = 0` reset at line 673) and §2 (50 ms bounds-checked fallback at lines 1684–1701) are implemented correctly; §2 improves on the plan snippet by re-querying the live node by `planId` inside the timeout and using viewport-rect math instead of `offsetTop`. §3 was intentionally omitted, matching the plan recommendation; both retry sites remain capped at `>= 3` and stay consistent. Regression audit traced all callers of `scrollPlanItemIntoView` (lines 1765, 1782) and the full `activateKanbanTabAndSelectPlan` → `kanbanPlansReady` path — no double-trigger (early `_pendingKanbanSelection = null` guards both resolution sites), no orphaned references, no race with autoban/file-watchers (change is webview-only). One NIT fixed: the §2 fallback comment said "correct via offsetTop" but the code uses viewport-rect math — corrected the comment to match. `node --check` passed after the fix. Remaining risk: if the 50 ms fallback fires before `kanbanPlansReady` re-renders AND the new plan does not sort to the top, the re-render's `innerHTML = ''` can wipe the scroll with no correction — a tail case the plan's Edge-Case audit already acknowledges as an accepted dependency on sort order.
