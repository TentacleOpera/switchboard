# Tickets tab: move the search input to the top of the sidebar

## Goal

Move the ticket **Search** input out of the crowded top control strip and into the top of the sidebar (directly above the ticket list it filters). This puts search where it belongs — over the results — and removes one wide element from the overloaded top strip.

### Problem & root-cause analysis

The search box currently lives mid-way through the top control strip ([src/webview/planning.html:3898](src/webview/planning.html)), wedged between the status filters and the Refresh/Refetch/Sync/Agent-API action buttons:

```html
<input id="tickets-search" type="text" class="sidebar-search-input" placeholder="Search tickets..." />
```

That strip (`#controls-strip-tickets`) is `overflow-x: auto; flex-wrap: nowrap` ([:196-206](src/webview/planning.html)), so with the workspace picker + Source + summary + 3 filter selects + search + 4 action buttons it silently scrolls horizontally and search can fall off-screen. It also sits visually far from the list it acts on. The sidebar (`#tree-pane-tickets`) is the natural home: search filters the cards rendered directly below it.

## User Review Required

- Confirm placement: a **dedicated full-width search row** at the very top of the sidebar (not inline in the `+ New Ticket / Link all` toggle row). The plan rejected the inline-in-toggle-row placement as too cramped.
- Confirm the search input keeps its **same `id="tickets-search"` and classes** so every existing listener/reference keeps working unchanged (no rename).

## Metadata
**Tags:** frontend, ui, layout
**Complexity:** 3

## Complexity Audit

### Routine
- Removing `#tickets-search` from the top strip ([:3898](src/webview/planning.html)) and re-inserting it at the top of `#tree-pane-tickets` ([:3906-3917](src/webview/planning.html)) — same id/handlers, DOM location only.
- Reusing `.sidebar-search-input` styling; making it full-width within the sidebar.
- Adding a collapse rule so the search input hides in the narrow rail.

### Complex / Risky
- **`.sidebar-search-input` style context.** The class was authored assuming the top-strip context (the strip's `flex-shrink: 0` children, `gap: 8px`, `padding: 6px 12px`). Moving the input into the sidebar changes its parent. Verify the class does not rely on strip-specific parent styles (e.g. inherited font-size, border, or width constraints). If it does, add sidebar-scoped overrides rather than renaming the class (the id/classes must stay to preserve listeners).
- **Collision with the `«` collapse toggle.** The sidebar-toggle-row at [:3907-3912](src/webview/planning.html) has `+ New Ticket`, `Link all`, `Kanban all`, and the `«` toggle pinned right. The new search row sits **above** this toggle row (per the plan: "directly under `.sidebar-toggle-row` and before `#tickets-empty-state`" — wait, the plan says "directly under `.sidebar-toggle-row`", which means *below* the toggle row; confirm placement is below the toggle row, above the empty state). Verify the full-width search row does not collide visually with the toggle row's `«` button.
- **Collapsed-sidebar rule.** The existing collapse rules at [:325-403](src/webview/planning.html) hide `.strip-btn` in the toggle row ([:400-403](src/webview/planning.html)) but do NOT cover `.sidebar-search-input`. A new rule like `.content-row.collapsed #tree-pane-tickets .sidebar-search-input { display: none !important; }` is required. The `!important` is needed because JS may set inline `style.display` on the input.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The input's listeners are wired by id; moving the element does not change wiring.
- **Security:** None. Search input is existing; no new input handling.
- **Side Effects:** `getTicketsTabElements().searchInput` ([planning.js:2293](src/webview/planning.js)) still resolves (id unchanged). Any code that assumes `#tickets-search` is a child of `#controls-strip-tickets` will break — grep `tickets-search` in planning.js to confirm no such assumption. The top strip loses a wide element, relieving its horizontal overflow (synergistic with the *Move Refetch into a "More" menu* subtask).
- **Dependencies & Conflicts:**
  - **No hard dependency** on any other subtask. Independent.
  - **Synergy:** with *Move Refetch into a "More" menu* (which moves Refetch/Sync/Agent API into a "⋯ More" menu), the top strip goes from { workspace picker + Source + summary + 3 filters + search + Refresh + Refetch + Sync + Agent API } to { workspace picker + Source + summary + 3 filters + Refresh + ⋯ More } — no horizontal scroll at typical widths. Landing both is the full top-strip relief.
  - No backend changes.

## Dependencies

- **No hard dependencies.** Independent; can land in any order.
- **Synergy** with *Move Refetch into a "More" menu* — together they fully relieve the top strip's horizontal overflow.

## Adversarial Synthesis

Key risks: (1) `.sidebar-search-input` may rely on strip-specific parent styles that break in the sidebar context — verify and add sidebar-scoped overrides if so (do not rename the class); (2) the collapsed-sidebar rule must use `!important` to override JS-set inline `display`; (3) placement must not collide with the `«` toggle row. Mitigations: grep `tickets-search` in planning.js to confirm no parent assumption; add the `!important` collapse rule; place the search row below the toggle row and above the empty state, full-width.

## Proposed Changes

### `src/webview/planning.html` (DOM)
- **Context:** Top strip at [:3898](src/webview/planning.html); sidebar `#tree-pane-tickets` at [:3906-3917](src/webview/planning.html).
- **Logic:** Move the search input out of the top strip and into the top of the sidebar.
- **Implementation:**
  1. **Remove `#tickets-search` from the top strip** ([:3898](src/webview/planning.html)).
  2. **Add it as a dedicated full-width search row** at the top of the sidebar `#tree-pane-tickets` ([:3906-3917](src/webview/planning.html)), directly under `.sidebar-toggle-row` and before `#tickets-empty-state` / `#tickets-issues-container`. Keep the **same `id="tickets-search"` and classes** so every existing listener/reference keeps working unchanged (verify by grepping `tickets-search` in planning.js — do not rename).
- **Edge Cases:** Placement below the toggle row — verify no collision with `«`.

### `src/webview/planning.html` (CSS)
- **Context:** Collapse rules at [:325-403](src/webview/planning.html); `.sidebar-search-input` class.
- **Logic:** Make the input full-width in the sidebar; hide it when the sidebar is collapsed.
- **Implementation:**
  1. **Collapsed-sidebar handling:** when the sidebar is collapsed (`.content-row.collapsed #tree-pane-tickets`), hide the search input the same way the other sidebar controls are hidden ([:325-403](src/webview/planning.html) show the existing collapse rules for `#tree-pane-tickets` strip-btns). Add a matching rule for the search input so it doesn't show in the narrow rail:
     ```css
     .content-row.collapsed #tree-pane-tickets .sidebar-search-input { display: none !important; }
     ```
  2. **Style:** reuse `.sidebar-search-input`; make it full-width within the sidebar (the strip previously constrained it). Confirm it doesn't collide with the `«` collapse toggle. If `.sidebar-search-input` relies on strip-specific parent styles, add sidebar-scoped overrides (do not rename the class).
- **Edge Cases:** `!important` needed to override JS-set inline `display`.

### `src/webview/planning.js` (verify only)
- **Context:** `getTicketsTabElements().searchInput` at [planning.js:2293](src/webview/planning.js); search handler wiring.
- **Logic:** No change expected — the input is wired by id, which survives the move.
- **Implementation:** Grep `tickets-search` in planning.js to confirm no code assumes the input is a child of `#controls-strip-tickets`. If any such assumption exists, update it to look inside `#tree-pane-tickets` instead.
- **Edge Cases:** None expected.

## Verification Plan

### Automated Tests
- Skipped per session directive (no automated tests run).

### Manual Checks
- Search input appears at the top of the ticket sidebar, full width, above the card list.
- Typing filters the list exactly as before (same handler fires — id unchanged).
- Top control strip no longer contains the search box and fits more comfortably (less/no horizontal scroll).
- Collapsing the sidebar hides the search input; expanding restores it.
- Both providers (Linear/ClickUp) and drill-down subtask view still filter correctly.
- No collision with the `«` collapse toggle in either expanded or collapsed state.

## Decisions (confirmed)
- Placement: a dedicated full-width search row at the very top of the sidebar (not inline in the `+ New Ticket / Link all` toggle row).

## Routing
**Complexity 3 → Send to Intern.** Single-file DOM move + CSS additions. One verify-only JS check (grep for parent assumptions). The collapse-rule `!important` and class-context verification are the only sharp edges.

## Review Findings

Reviewed the committed implementation (commit 32bc8ab) against this plan. `#tickets-search` is moved from `#controls-strip-tickets` into a new `.sidebar-search-row` at the top of `#tree-pane-tickets` (planning.html:3976-3978), placed below `.sidebar-toggle-row` and above `#tickets-empty-state` — no collision with the `«` toggle. Same id and classes preserved; `wireSidebarSearch('tickets-search', ...)` (planning.js:2545) wires by `getElementById`, so all listeners survive the move. Grep confirmed no code in planning.js assumes `#tickets-search` is a child of `#controls-strip-tickets`. The collapse rule (planning.html:1979-1981) uses `!important` to override JS-set inline `display` — matches the plan's sharp-edge requirement. Sidebar-scoped CSS (planning.html:1973-1977) makes the input full-width, overriding the base `.sidebar-search-input` (`max-width: 200px; margin-left: auto`) without cross-contaminating `#docs-search` (different parent scope). No CRITICAL/MAJOR findings, no NITs. Verification: grep confirmed `searchInput.style.display = ''` at planning.js:10584/11280 clears inline display and falls back to CSS (visible expanded, hidden collapsed). Remaining risk: none material — the `!important` collapse rule is belt-and-suspenders with the parent collapse behavior.
