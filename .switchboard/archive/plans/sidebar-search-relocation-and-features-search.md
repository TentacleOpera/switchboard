# Relocate Kanban Search to Sidebar Top + Add Features Tab Search

## Goal

The Project panel's sidebar search UX is inconsistent and partially missing:

1. **Kanban plans tab** — the search box (`#kanban-search`) currently lives in the `.kanban-controls-strip` (the top bar alongside the workspace/project/column/complexity dropdowns and the Import/Create/Chat Prompt/Review buttons). It should live at the top of the plans sidebar pane, directly beneath the toggle row, where users expect a list-filter to be.
2. **Features tab** — the features sidebar has **no search box at all**. With many features loaded, there is no way to filter the list by text.

Both issues share a root cause: the sidebar search pattern was never consolidated. The kanban search was bolted onto the controls strip (the only place a static `<input>` could survive the pane's `innerHTML = ''` re-render), and the features tab was never given one. This plan consolidates the pattern: a full-width search row rendered as the first child of each sidebar pane (below the toggle row), re-created on each render with its value restored from filter state.

### Problems / Background

- `project.html:1245` places `<input id="kanban-search" class="sidebar-search-input">` inside `.kanban-controls-strip`. The `.sidebar-search-input` CSS (`project.html:137`) uses `margin-left: auto; width: 150px;` — a style written for the controls-strip context (pushed to the right edge). That style is wrong for a full-width sidebar row.
- `project.js:2135` wires `kanbanSearch.addEventListener('input', ...)` once, referencing the static element. The listener is attached exactly once because the element is never re-rendered.
- `renderKanbanPlans()` (`project.js:1546`) does `kanbanListPane.innerHTML = ''` on every render, then rebuilds the toggle row and plan cards. Any input placed inside the pane would be destroyed on each render unless re-created.
- `renderFeaturesList()` (`project.js:2148`) has the same `innerHTML = ''` rebuild pattern. `featuresFilters` (`project.js:385`) is `{ workspaceRoot, column, project }` — no `search` field. No text filter is applied in the render function.
- The kanban search filter logic (`project.js:1528`) matches `kanbanFilters.search` against `plan.topic` (case-insensitive substring). This is the canonical behavior to mirror for features. Features render `plan.topic` at `project.js:2254`, so the same field is the correct match target.
- Sidebar collapse: `project.html:474` hides everything in the pane except `.sidebar-toggle-row` when `.content-row.collapsed`. A search row placed as a sibling of the toggle row will be hidden automatically when collapsed — no extra CSS needed.

### Root Cause

The search input was placed in the controls strip as a shortcut to avoid the re-render lifecycle problem, not because it belongs there. The features tab was simply never wired up. The fix is to make the sidebar render the search row itself (re-creating the input each render and restoring its value from filter state), then remove the static input from the controls strip.

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, ux, bugfix, refactor
**Project:** Browser Switchboard

## User Review Required

Yes — this plan changes the render lifecycle of both sidebar panes (rebuild-on-render with value restoration + post-render re-focus) and removes a static DOM element (`#kanban-search`) that current one-time wiring depends on. Reviewer should confirm:

1. The rebuild-on-render approach (vs. a stable-header/list-body refactor) is acceptable as the consolidation pattern. A stable-header refactor (`innerHTML = ''` only clears a list body, leaving toggle + search row untouched) would eliminate the value-loss/focus-loss class of bugs entirely, at the cost of restructuring both render functions and updating the collapse CSS selector. This plan chooses rebuild-on-render because it mirrors the existing toggle-row pattern (already rebuilt each render), is the smaller diff, and keeps the collapse rule working unchanged. If the reviewer prefers the stable-header approach, this plan should be superseded before coding.
2. The features-tab navigation reset (clearing `featuresFilters.search` in the `activateKanbanTabAndSelectPlan` `isFeature` branch) is the right call — see Proposed Changes › project.js › Step 7.

## Complexity Audit

### Routine

- Adding one CSS rule (`.sidebar-search-row`) and adjusting one existing rule (`.sidebar-search-input` width/margin) — pure CSS, no logic.
- Removing the static `<input id="kanban-search">` from `.kanban-controls-strip` — single DOM deletion.
- Adding a `search: ''` field to `featuresFilters` — one-line state change.
- Mirroring the existing kanban text filter (`project.js:1528–1531`) inside `renderFeaturesList()` — copy-paste of a 4-line pattern against the same `plan.topic` field.
- Removing dead code: the `const kanbanSearch = document.getElementById('kanban-search')` lookup (`project.js:213`), the one-time listener block (`project.js:2135–2143`), and the `if (kanbanSearch) kanbanSearch.value = '';` reset (`project.js:698`).

### Complex / Risky

- **Rebuild-on-render lifecycle for the search input**: the input is destroyed and recreated on every `renderKanbanPlans()` / `renderFeaturesList()` call. Value restoration from `filters.search` and post-render re-focus + caret restoration are both required, or the input silently breaks (value blanks on each keystroke; focus drops after the first debounced re-render). This is the core risk of the plan.
- **Re-focus targeting the NEW input**: after a debounced re-render, the re-focus must query the freshly-attached input (`pane.querySelector('.sidebar-search-input')`), not the detached one the listener was registered on. The listener continues running synchronously on the detached element, but only the new input is interactive.
- **Two independent debounce timers**: kanban and features must not share a `let searchTimeout` — a shared variable would let a features keystroke cancel a pending kanban re-render (or vice versa).
- **Features-tab navigation hijack (found during review)**: `activateKanbanTabAndSelectPlan` with `msg.isFeature === true` (`project.js:640–661`) auto-selects a specific feature card on tab activation via `_pendingFeatureSelection` + `tryResolvePendingFeatureSelection()`. A lingering `featuresFilters.search` term would filter the target card out of the list before `tryResolvePendingFeatureSelection()` can find and scroll to it — exactly analogous to the kanban reset at `project.js:697`. This must be reset in the same branch, not left as a conditional audit.

## Edge-Case & Dependency Audit

**Race Conditions**
- The debounced `input` listener triggers a re-render that destroys the input the listener is firing on. Browsers run the listener to completion synchronously on the detached element, so this is safe — but the re-focus must run AFTER `renderKanbanPlans()` / `renderFeaturesList()` returns (render is synchronous, so the new input is in the DOM at that point) and must query the new input from the pane, not close over the old one.
- Two independent debounce timers (one per tab) prevent cross-tab timer cancellation.

**Security**
- No new surface. The search value is read from a trusted local input and matched against `plan.topic` (already escaped at render via `escapeHtml`). No injection risk.

**Side Effects**
- Removing `#kanban-search` makes `getElementById('kanban-search')` return null. Any remaining reference (the lookup at `project.js:213`, the listener block at `project.js:2135–2143`, the reset at `project.js:698`) will either no-op silently or throw on `null.addEventListener`. All three must be removed in the same change.
- The `.sidebar-search-input` CSS rule is shared by both the (removed) static input and the (new) dynamic inputs. Changing its `width`/`margin` affects only the dynamic inputs after the static one is gone — no regression to the controls strip (the input is no longer in it).

**Dependencies & Conflicts**
- Depends on the existing `kanbanFilters.search` field (`project.js:384`, already present) and the existing `kanbanFilters.search` reset at `project.js:697` (inside `activateKanbanTabAndSelectPlan`). No new kanban state needed.
- Adds a new `featuresFilters.search` field — must be initialized at `project.js:385` and reset in the `isFeature` branch of `activateKanbanTabAndSelectPlan` (`project.js:649–651`).
- No conflicts with the `Link all` button (`project.js:1554`) — the search row is a separate sibling below the toggle row.
- No conflicts with the claudify theme — `.sidebar-search-input` is not themed by `body.theme-claudify` (which targets cards/items, not inputs); the input base styles (`#111` bg, `--border-color` border) are theme-agnostic.

## Dependencies

- None. This plan is self-contained within `src/webview/project.html` and `src/webview/project.js`.

## Adversarial Synthesis

Key risks: (1) rebuild-on-render breaks the input on every keystroke unless value-restoration AND post-render re-focus + caret restoration are both implemented — the plan's Edge Cases called this out but the original implementation steps omitted the re-focus code from the step body, leaving an implementer to build a visibly-broken search; (2) the original step 7 left the features-tab navigation reset as a conditional audit ("if such a path exists"), but the code shows the path DOES exist (`activateKanbanTabAndSelectPlan` with `isFeature: true`) and a lingering search term would hijack every external feature-card navigation — this is a real bug, not a maybe. Mitigations: re-focus logic is now explicit in Steps 3 & 6 with the exact query selector; step 7 is upgraded to a concrete reset in the `isFeature` branch alongside the existing `workspaceRoot`/`column`/`project` clears.

## Proposed Changes

### project.html

**Context:** The static `<input id="kanban-search">` lives in `.kanban-controls-strip` (`project.html:1245`) with controls-strip-specific CSS (`.sidebar-search-input` at `project.html:137` uses `margin-left: auto; width: 150px;`). It must move out of the strip and become a full-width row inside the sidebar pane. The collapse rule at `project.html:474` already hides every pane child except `.sidebar-toggle-row`, so a `.sidebar-search-row` sibling of the toggle row hides automatically when collapsed.

**Logic:** Add one new CSS rule for the row container; repurpose the existing `.sidebar-search-input` rule for full-width use; delete the static input from the controls strip.

**Implementation:**

1. **Add `.sidebar-search-row` near `.sidebar-toggle-row` (`project.html:452`).** New rule:
   - `display: flex; padding: 6px 12px; background: var(--panel-bg2); border-bottom: 1px solid var(--border-color);`
   - The inner `<input>` is `width: 100%;`, reusing the existing input base styles (background `#111`, border, padding, font-size 11px, mono font).

2. **Update `.sidebar-search-input` (`project.html:137`):** remove `margin-left: auto; width: 150px;` (controls-strip-specific) and set `width: 100%;`. The controls strip no longer hosts this input, so the auto-margin rule is no longer needed. Keep the rest of the rule (bg, border, color, padding, border-radius, font-size).

3. **Delete the static kanban search input** from `.kanban-controls-strip` (`project.html:1245`): remove `<input type="text" id="kanban-search" class="sidebar-search-input" placeholder="Search plans..." />`.

**Edge Cases:**
- The `.sidebar-search-input` class is now used only by the dynamic inputs inside `.sidebar-search-row`. The `width: 100%` change has no effect on the controls strip (the static input is gone).
- The claudify theme block (`project.html:77+`) does not target inputs — no theme-specific changes needed.
- The collapse rule (`project.html:474`) hides `.sidebar-search-row` when collapsed because it is not `.sidebar-toggle-row`. Verify both panes hide the search row when collapsed.

### project.js

**Context:** `renderKanbanPlans()` (`project.js:1546`) and `renderFeaturesList()` (`project.js:2148`) both do `innerHTML = ''` and rebuild the toggle row + cards on every render. The kanban search is currently wired once against a static element (`project.js:213`, `2135–2143`); features has no search at all. `featuresFilters` (`project.js:385`) lacks a `search` field. The kanban filter (`project.js:1528–1531`) matches `kanbanFilters.search` against `plan.topic`; features render `plan.topic` at `project.js:2254`, so the same field is the correct match target. The kanban search is reset at `project.js:697` inside the `activateKanbanTabAndSelectPlan` case so a lingering term doesn't hide the auto-selected target card; the features tab has an analogous auto-select path (`activateKanbanTabAndSelectPlan` with `isFeature: true`, `project.js:640–661`) that currently does NOT reset a search term.

**Logic:** Render a search row as the first child of each sidebar pane (immediately after the toggle row, before the empty-state check so it shows even when the list is empty). Restore the input's value from `filters.search` on each render. Attach a debounced `input` listener (200ms) that updates `filters.search` and re-renders, then re-focuses the new input and places the caret at the end. Add a `search` field to `featuresFilters` and mirror the kanban text filter in `renderFeaturesList()`. Reset `featuresFilters.search` in the `isFeature` branch of `activateKanbanTabAndSelectPlan`. Remove the now-dead static-element wiring.

**Implementation:**

**Step 1 — Render the kanban search row dynamically inside `renderKanbanPlans()` (`project.js:1546`).**

Immediately after the toggle row is appended (`kanbanListPane.appendChild(toggleRow)` at `project.js:1582`), and BEFORE the `if (filtered.length === 0)` empty-state check at `project.js:1584` (so the search row shows even when there are no results), insert a search row:

- Create a `<div class="sidebar-search-row">`.
- Create an `<input type="text" class="sidebar-search-input" placeholder="Search plans...">` inside it.
- Restore the input's `.value` from `kanbanFilters.search` (so re-renders don't lose the user's typed term).
- Attach a debounced `input` listener (200ms) using a module-level (or closure-stable) timeout variable, mirroring the existing `kanbanSearchTimeout` pattern (`project.js:2134`). The listener:
  1. `clearTimeout(kanbanSearchTimeout);`
  2. `kanbanSearchTimeout = setTimeout(() => { kanbanFilters.search = input.value; renderKanbanPlans(); /* re-focus below */ }, 200);`
- After the `renderKanbanPlans()` call inside the timeout callback, re-focus the new input and restore the caret to the end, so typing a multi-character search does not drop focus after the first debounced re-render:
  ```js
  const newInput = kanbanListPane.querySelector('.sidebar-search-input');
  if (newInput) {
      newInput.focus();
      const len = newInput.value.length;
      newInput.setSelectionRange(len, len);
  }
  ```
- Append the search row to `kanbanListPane` before the plan cards.

**Step 2 — Remove the dead static-element kanban wiring.**

Because the input is now re-created each render, the following become dead code and must be removed in the same change:

- `const kanbanSearch = document.getElementById('kanban-search');` (`project.js:213`).
- The one-time listener block `if (kanbanSearch) { kanbanSearch.addEventListener('input', ...) }` (`project.js:2135–2143`).
- The `if (kanbanSearch) kanbanSearch.value = '';` reset at `project.js:698`. The `kanbanFilters.search = ''` reset at `project.js:697` (already present) is sufficient — the next render restores the input as empty. Dropping the `kanbanSearch.value = ''` line is safe because the static element no longer exists.

**Step 3 — Add `search` to `featuresFilters` (`project.js:385`).**

Change:
```js
const featuresFilters = { workspaceRoot: '', column: '', project: '' };
```
to:
```js
const featuresFilters = { workspaceRoot: '', column: '', project: '', search: '' };
```

**Step 4 — Apply the search filter in `renderFeaturesList()` (`project.js:2148`).**

After the existing `featuresFilters.project` block (`project.js:2161–2167`), add a text filter mirroring the kanban one (`project.js:1528–1531`):
```js
if (featuresFilters.search) {
    const searchLower = featuresFilters.search.toLowerCase();
    filtered = filtered.filter(plan => plan.topic.toLowerCase().includes(searchLower));
}
```

**Step 5 — Render the features search row dynamically inside `renderFeaturesList()` (`project.js:2148`).**

Immediately after the toggle row is appended (`featuresListPane.appendChild(toggleRow)` at `project.js:2180`), and BEFORE the `if (filtered.length === 0)` empty-state check at `project.js:2182` (so the search row shows even when there are no results), insert a search row using the same pattern as Step 1:

- `<div class="sidebar-search-row">` containing `<input type="text" class="sidebar-search-input" placeholder="Search features...">`.
- Restore `.value` from `featuresFilters.search`.
- Attach a debounced `input` listener (200ms) that sets `featuresFilters.search = input.value`, calls `renderFeaturesList()`, then re-focuses the new input and restores the caret to the end (same re-focus block as Step 1, querying `featuresListPane.querySelector('.sidebar-search-input')`).
- Use a SEPARATE closure-stable timeout variable (e.g. `featuresSearchTimeout`) — do NOT share with kanban's `kanbanSearchTimeout`. A shared variable would let a features keystroke cancel a pending kanban re-render (or vice versa).

**Step 6 — Reset `featuresFilters.search` in the `activateKanbanTabAndSelectPlan` `isFeature` branch (`project.js:640–661`).**

> **Superseded:** Step 7 of the original plan framed this as a conditional audit: "Check whether the features tab has an analogous navigation path... If such a path exists and could be hijacked by a lingering search term, reset `featuresFilters.search = ''` there too. If no such auto-select path exists for features, skip this step."
>
> **Reason:** The audit is already answerable from the code — the path exists. `activateKanbanTabAndSelectPlan` with `msg.isFeature === true` (`project.js:640–661`) sets `_pendingFeatureSelection`, clicks the features tab, and calls `tryResolvePendingFeatureSelection()` (`project.js:660`), which finds the target feature card in the filtered list and scrolls it into view (`project.js:1828–1846`). A lingering `featuresFilters.search` term would filter the target card out before `tryResolvePendingFeatureSelection()` can match it — exactly analogous to the kanban reset at `project.js:697`. Leaving this as a "skip if no path" conditional lets a real bug ship.
>
> **Replaced with:** A concrete reset. In the `isFeature` branch at `project.js:649–651` (where `featuresFilters.workspaceRoot`, `.column`, and `.project` are already cleared), add `featuresFilters.search = '';`. No static-element value reset is needed (there is no static features search input).

> **Superseded:** The original step 7 characterized the kanban reset trigger as "a `reviewPlan` message navigates to the kanban tab" (`project.js:697`).
>
> **Reason:** There is no `reviewPlan` message case; the reset at `project.js:697` lives inside the `activateKanbanTabAndSelectPlan` case (the same case that handles the `isFeature` branch). The trigger name was imprecise.
>
> **Replaced with:** The trigger is `activateKanbanTabAndSelectPlan` (non-feature branch), which clears `kanbanFilters.search` at `project.js:697` before clicking the kanban tab and calling `tryResolvePendingKanbanSelection()`. The features analog is the `isFeature` branch of the same case.

**Edge Cases:**
- **Re-render value loss**: the input is destroyed on each render. The value-restoration from `filters.search` (Steps 1 & 5) is essential — without it, every keystroke that triggers a re-render blanks the input.
- **Cursor focus loss on re-render**: the input is re-created, so focus is lost after each debounced re-render. The re-focus + `setSelectionRange(len, len)` block (Steps 1 & 5) is mandatory, not optional. Without it, typing a 3-character search drops focus after the first character. The original plan described this only in Edge Cases; it is now explicit in the step body.
- **Debounce timer scope**: `kanbanSearchTimeout` and `featuresSearchTimeout` must be separate variables.
- **Collapsed sidebar**: `.sidebar-search-row` is hidden by the existing `.content-row.collapsed #...-list-pane > *:not(.sidebar-toggle-row)` rule (`project.html:474`). Verify both panes hide the search row when collapsed.
- **`#kanban-link-all` button**: the kanban toggle row keeps its "Link all" button (`project.js:1554`). The search row is a separate sibling below it — no conflict.
- **Dead code cleanup**: removing the static `#kanban-search` input makes `getElementById('kanban-search')` return null. The lookup at `project.js:213`, the listener block at `project.js:2135–2143`, and the reset at `project.js:698` must all be removed in the same change. Leaving any of these will either no-op silently or throw on `null.addEventListener`.

## Verification Plan

### Automated Tests

Skipped per session directive. No automated tests will be run as part of this plan's verification.

### Manual Verification

1. **Kanban search relocation**:
   - Open the Project panel → Kanban tab. Confirm the search box appears at the top of the plans sidebar, directly below the `Link all / «` toggle row, full width.
   - Confirm the controls strip no longer contains a search input (the dropdowns and buttons remain, ending with Review).
   - Type a search term matching some plan topics — confirm the list filters within ~200ms.
   - Confirm the input keeps focus and the caret stays at the end while typing (re-focus logic works). Type a 3+ character term in one continuous keystroke sequence to verify focus is retained across debounced re-renders.
   - Clear the input — confirm the full list returns.
   - Collapse the sidebar via `«` — confirm the search row hides and only the toggle row remains. Expand via `»` — confirm the search row reappears with its value intact.
   - Trigger an `activateKanbanTabAndSelectPlan` navigation (e.g. from a chat prompt that targets a specific plan) — confirm the search is cleared and the target card is visible (the `kanbanFilters.search = ''` reset at `project.js:697` still works without the static element).
2. **Features search**:
   - Open the Features tab. Confirm a search box appears at the top of the features sidebar, below the toggle row, full width.
   - Type a search term matching some feature topics — confirm the list filters within ~200ms, matching `plan.topic` (case-insensitive).
   - Confirm focus is retained while typing a 3+ character term across debounced re-renders.
   - Collapse/expand the sidebar — confirm the search row hides/reappears with value intact.
   - Switch away from and back to the Features tab — confirm the search value persists across manual tab switches.
   - Trigger an `activateKanbanTabAndSelectPlan` navigation with `isFeature: true` (e.g. from a chat prompt that targets a specific feature) — confirm the search is cleared and the target feature card is scrolled into view and selected (the new `featuresFilters.search = ''` reset in the `isFeature` branch works).
3. **Theme check**: switch to the claudify theme and confirm both search inputs render with the correct theme-agnostic input styles (no broken contrast).
4. **No regressions**: confirm the kanban controls strip still lays out correctly (no gap where the search input was — the `margin-left: auto` removal from `.sidebar-search-input` should not affect the strip since the input is gone from it).
5. **Dead code check**: confirm there are no remaining references to `kanbanSearch` (the variable) or `getElementById('kanban-search')` in `project.js`, and no console errors on tab load.

## Recommendation

Complexity 4 → **Send to Coder**. The change is two-file and mostly routine, but the rebuild-on-render lifecycle (value restoration + post-render re-focus + caret restoration) and the features-tab navigation reset are moderate, well-scoped risks that benefit from a coder's attention to the re-focus timing, not an intern's copy-paste.

## Completion Report

Implemented the sidebar search consolidation across `src/webview/project.html` and `src/webview/project.js`: added a `.sidebar-search-row` CSS rule and repurposed `.sidebar-search-input` to full-width; removed the static `#kanban-search` input from `.kanban-controls-strip`; rendered a dynamic search row as the first child of both `#kanban-list-pane` and `#features-list-pane` (re-created each render with value restored from `kanbanFilters.search` / new `featuresFilters.search` field, debounced 200ms with post-render re-focus + caret restoration using separate `kanbanSearchTimeout` / `featuresSearchTimeout` timers); added the `featuresFilters.search` text filter mirroring the kanban one; reset `featuresFilters.search` in the `activateKanbanTabAndSelectPlan` `isFeature` branch; and removed all dead `kanbanSearch` wiring (variable lookup, one-time listener block, static-element value reset). No issues encountered — all dead-code refs verified gone via grep, edge cases (collapse rule coverage, TDZ on timer decls, re-focus targeting new input) confirmed in red-team review. Compilation and automated tests skipped per session directive.

## Review Findings

Reviewed the committed implementation (commit `89d02d8`) against the plan. All plan requirements are satisfied: CSS rules, static-input removal, dynamic search rows with value restoration + re-focus + caret restoration, `featuresFilters.search` field + filter + `isFeature`-branch reset, separate debounce timers, dead-code cleanup. One MAJOR regression found and fixed: the debounce callback only committed `filters.search` inside the 200ms timeout, so an external re-render arriving mid-type (e.g. `kanbanPlansReady` at `project.js:553` from a watcher fire) destroyed the input before the value was saved, losing the user's in-progress term — a regression vs. the old controls-strip input which survived external re-renders. Fix applied: both listeners now update `filters.search` synchronously on every keystroke (`project.js:1679`, `project.js:2304`); the debounce only gates the re-render. Files changed: `src/webview/project.js`. Remaining risk: focus still drops for up to 200ms if an external re-render arrives mid-type (the pending debounce re-focuses on fire); full mitigation requires the stable-header refactor the plan deferred. No compilation or tests run per session directive.
