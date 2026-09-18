# Tickets tab: de-overload the ticket preview meta bar

## Goal

Reduce the ticket preview action bar from a wall of 13 equal-weight buttons to a small set of primary actions plus an overflow menu, so it stops wrapping onto 2–3 rows and eating vertical space in the reading pane. This is the remaining "overloaded control strip" after the search-move and refresh-merge plans relieve the top strip.

### Problem & root-cause analysis

`#tickets-preview-meta-bar` ([src/webview/planning.html:3920-3934](src/webview/planning.html)) renders up to 13 buttons in a single flex row:

> Edit, Save, Cancel, Push, Assign, Tags, Comment, Attachments, Diagram, + Subtask, To subtask, To parent task, Delete

The bar is `flex-wrap: wrap` ([:3345-3356](src/webview/planning.html)), so at normal pane widths it spills onto two or three stacked rows, pushing the ticket content down and making the bar the visual focus instead of the ticket. Every action is an equal-weight `strip-btn` with no hierarchy — the everyday actions (Edit, Push, Comment) sit indistinguishably next to rare ones (Diagram, To subtask, To parent). Several are already conditionally shown (Save/Cancel only in edit mode, Attachments only when present, Diagram, the subtask-nav buttons via `_toggleSubtaskMetaButtons`), which the fix must preserve.

## User Review Required

- Confirm the primary inline set: **Edit / Push / Comment** (plus edit-mode-only Save / Cancel). If a different verb set is more "everyday" for your workflow, say so before implementation.
- Confirm **Delete** stays pinned far-right on its own (not inside the menu) — destructive action deliberately separated.
- Confirm the overflow trigger label **"⋯ More"** (not a bare kebab icon).

## Metadata
**Tags:** frontend, ui, refactor
**Complexity:** 5

## Complexity Audit

### Routine
- Reordering existing buttons into primary-inline vs. overflow-menu groups — DOM location changes only, ids/handlers preserved.
- Reusing the existing `strip-btn` styling for primary actions and menu items.
- Pinning Delete far-right via the existing `#btn-delete-ticket { margin-left: auto }` rule (already in place at [:3359-3361](src/webview/planning.html)).
- Outside-click / Escape close behavior — pattern already exists in `design.js:4751-4790` for `stitch-variants-dropdown-menu`.

### Complex / Risky
- **Building a multi-instance reusable overflow component.** The reference pattern (`stitch-variants-dropdown`, [design.html:4108](src/webview/design.html) / [design.js:4755](src/webview/design.js)) is **single-instance and id-based** (`getElementById('stitch-variants-dropdown-menu')`). The new component must support **two independent instances** on the same page (this meta-bar menu + the top-strip menu from the *Move Refetch into a "More" menu* subtask). A naive copy of the stitch pattern with hardcoded ids will collide. Must be class-based or data-attribute-based with scoped lookups.
- **Preserving per-provider/state gating inside the menu.** Each menu item's existing `display:none` / `disabled` toggle (Attachments only when `attachments.length`, Diagram, Tags disabled without selection, `_toggleSubtaskMetaButtons` for + Subtask / To subtask / To parent — [planning.js:11117-11135](src/webview/planning.js)) must keep working when the item is rendered inside the popover instead of as a top-level button. The gating code currently does `document.getElementById('btn-...')` lookups — those still work (ids unchanged), but the elements now live inside the popover DOM. Verify the gating toggles don't get hidden by the popover's own `display:none` when closed.
- **"⋯ More" trigger visibility.** The trigger must hide when every item under it is hidden (e.g. minimal-capability provider). Requires a recomputation hook that runs after each gating update — not just at render time.
- **Popover positioning inside `flex-wrap: wrap` bar.** The meta bar wraps; an absolutely-positioned popover anchored to the "⋯ More" trigger must escape the bar's overflow. The bar has no `overflow:hidden`, so `position: absolute` with `z-index: 1000` should escape — but verify it doesn't get clipped by any ancestor `overflow:auto` (the preview pane is `display: flex; flex-direction: column` — no clipping expected).

## Edge-Case & Dependency Audit

- **Race Conditions:** Toggling a menu item's visibility while the popover is open (e.g. Attachments arrives via an async fetch after the bar renders) — the popover must re-evaluate its items' visibility on each gating update, not snapshot at open time. Mitigation: hook the "⋯ More" trigger visibility + item visibility into the existing `_toggleSubtaskMetaButtons` / `getTicketsTabElements()` update path.
- **Security:** No new attack surface — no user input handling, no eval, no external URLs. Menu items are existing buttons with existing handlers.
- **Side Effects:** Moving buttons into the popover changes their DOM parents. Any code that walks the meta-bar's direct children (e.g. the loading-state disabler at [planning.js:2278-2285](src/webview/planning.js) that does `metaBar.querySelectorAll('button, select')` and disables them) must still reach popover items. `querySelectorAll` descends into the popover, so this still works — verify.
- **Dependencies & Conflicts:**
  - **Depends on no other subtask.** This subtask *introduces* the reusable overflow component that the *Move Refetch into a "More" menu* subtask reuses.
  - **Soft coupling:** The top-strip "⋯ More" menu (other subtask) and this meta-bar "⋯ More" menu are different instances; the component must be multi-instance (see Complexity Audit).
  - No backend changes; no provider message-protocol changes.

## Dependencies

- **Blocks:** *Tickets tab: move Refetch into a "More" menu* — that subtask reuses the overflow component built here. Land this subtask first, or build the shared component in whichever lands first and have the other reuse it. Do not build two overflow menus.
- No external session dependencies.

## Adversarial Synthesis

Key risks: (1) the reference pattern is single-instance id-based but the component must be multi-instance — a naive copy collides; (2) gating toggles that mutate `display`/`disabled` on items now inside the popover must still fire correctly when the popover is closed; (3) the "⋯ More" trigger must hide when empty, requiring a recomputation hook tied to the existing gating update path. Mitigations: build the component class/data-attribute scoped (not id-scoped); keep all item ids unchanged so existing `getElementById` gating lookups still resolve; recompute trigger visibility inside `_toggleSubtaskMetaButtons` and the Attachments/Diagram update branches.

## Proposed Changes

### `src/webview/planning.html`
- **Context:** `#tickets-preview-meta-bar` at [:3920-3934](src/webview/planning.html) — 13 flat buttons.
- **Logic:** Establish hierarchy: a few primary inline actions, everything else behind a "⋯ More" popover, destructive action pinned away.
- **Implementation:**
  1. Build one small reusable overflow-menu component (CSS + a JS helper) modeled on the existing `stitch-variants-dropdown` in [design.html:4108](src/webview/design.html) / [design.js:4755](src/webview/design.js) — a button that toggles an absolutely-positioned popover of menu items, closes on outside-click/Escape. **Must be multi-instance** (class-based or data-attribute-based scoped lookups, not hardcoded ids). Put it in planning.html/planning.js so the top strip can reuse it later.
  2. **Primary inline (always the everyday verbs):** Edit, Push, Comment. Save / Cancel stay inline but remain edit-mode-only (unchanged toggle).
  3. **Move into "⋯ More":** Assign, Tags, Attachments, Diagram, + Subtask, To subtask, To parent task. Keep their existing ids and click handlers — only their DOM location changes (rendered as menu items instead of top-level buttons).
  4. **Delete** stays pinned far-right on its own via the existing `#btn-delete-ticket { margin-left: auto }` ([:3357-3361](src/webview/planning.html)) — it must not go into the menu (destructive, deliberately separated).
- **Edge Cases:** See Complexity Audit — popover escape from `flex-wrap` bar, multi-instance scoping.

### `src/webview/planning.html` (CSS)
- **Context:** Meta-bar CSS at [:3345-3361](src/webview/planning.html).
- **Logic:** Add popover styles (absolute positioning, z-index 1000, outside-click surface) and the "⋯ More" trigger button style. Keep `flex-wrap: wrap` on the bar — primary actions + trigger + Delete should fit one row at typical pane widths.
- **Edge Cases:** Popover must not be clipped by ancestor overflow; verify in both themes.

### `src/webview/planning.js`
- **Context:** Subtask-meta toggle at [planning.js:11117-11135](src/webview/planning.js); Attachments/Diagram gating in the same region; loading-state disabler at [planning.js:2278-2285](src/webview/planning.js).
- **Logic:** Add the overflow-component JS helper (toggle on click, close on outside-click/Escape, multi-instance). Preserve all existing gating.
- **Implementation:**
  1. Add a reusable `OverflowMenu` helper (or equivalent) that supports N instances on the page — each trigger/popover pair scoped by a shared class or `data-overflow-menu` attribute, not by id.
  2. Wire the meta-bar "⋯ More" trigger to its popover.
  3. **Preserve all existing gating.** The current per-provider/per-state visibility logic (Attachments only when `attachments.length`, Diagram, Tags disabled without selection, `_toggleSubtaskMetaButtons` for + Subtask / To subtask / To parent — [planning.js:11117-11135](src/webview/planning.js)) must keep working: a hidden/disabled action is hidden/disabled **inside the menu**, and the "⋯ More" trigger itself hides when every item under it is hidden (e.g. minimal-capability provider). Add a `_recomputeMoreTriggerVisibility()` call inside `_toggleSubtaskMetaButtons` and the Attachments/Diagram update branches.
- **Edge Cases:** Gating toggles must still resolve items by id (ids unchanged) even when items live inside a closed popover; loading-state disabler's `querySelectorAll('button, select')` must still descend into the popover.

## Verification Plan

### Automated Tests
- Skipped per session directive (no automated tests run).

### Manual Checks
- Select a ticket: meta bar shows Edit / Push / Comment + "⋯ More" + Delete (far right), all on one row at typical pane widths — no wrapping.
- "⋯ More" opens a popover with Assign, Tags, Attachments, Diagram, + Subtask, To subtask, To parent; each still triggers its original action.
- Enter edit mode: Save / Cancel appear inline as before.
- Provider/state gating intact: Attachments only when the ticket has attachments; subtask buttons appear/hide per `_toggleSubtaskMetaButtons`; Tags disabled with no selection; the "⋯ More" trigger disappears if it would be empty.
- Popover closes on outside-click and Escape; keyboard-navigable.
- Both themes (default + claudify) render correctly.
- **Multi-instance check:** with this subtask and the top-strip "⋯ More" both landed, open both popovers (or open one then the other) — they must not collide, share state, or break each other's outside-click handling.

## Decisions (confirmed)
- Primary inline set: **Edit / Push / Comment** (plus edit-mode-only Save / Cancel). Everything else goes in the menu.
- Overflow trigger: labeled **"⋯ More"** (not a bare kebab).
- This subtask owns the reusable overflow-menu component; the *Move Refetch into a "More" menu* subtask reuses it for the top strip. Build it here first if landing first.

## Routing
**Complexity 5 → Send to Coder.** Multi-file (HTML + CSS + JS), one moderate well-scoped risk (multi-instance component), extends an existing pattern.

## Review Findings

Reviewed the committed implementation (commit 32bc8ab) against this plan. The reusable overflow-menu component is scoped by `[data-overflow-menu]`/`[data-overflow-trigger]`/`[data-overflow-popover]` data attributes (multi-instance, no id collision) with a `position: fixed` popover at `z-index: 10000` (planning.html:3380-3419, planning.js:2288-2384) — escapes both the meta bar's `flex-wrap: wrap` and the top strip's `overflow-x: auto`, with viewport-edge clamping and flip-above in `_positionOverflowPopover`. Primary inline actions are Edit/Save/Cancel/Push/Comment; overflow items are Assign/Tags/Attachments/Diagram/+Subtask/To subtask/To parent; Delete stays pinned far-right via `margin-left: auto` — matches the plan exactly. All item ids preserved so `getElementById` gating lookups still resolve inside the popover DOM. `_recomputeAllOverflowTriggers()` is called after `_toggleSubtaskMetaButtons` (planning.js:11063) and after Attachments/Diagram gating (planning.js:11209, 11774) so the "⋯ More" trigger hides when every item is hidden. `_closeAllOverflowPopovers(null)` runs when the meta bar is hidden (planning.js:11184, 11749, 12135). `setTicketsLoadingState` (planning.js:2278-2285) uses `querySelectorAll('button, select')` which descends into the popover, so loading-state disable/enable still reaches popover items; gating code re-applies correct `disabled` states after loading. `_recomputeOverflowTriggerVisibility` correctly checks each item's own `display`/`disabled` via `getComputedStyle` — identifies items that would be visible if the popover were open, even when the popover itself is closed. No CRITICAL/MAJOR findings. Two NITs (defer): the selector `.overflow-menu-item, .strip-btn` in `_recomputeOverflowTriggerVisibility` (planning.js:2318) is redundant (`.overflow-menu-item` alone suffices — all items have both classes, querySelectorAll deduplicates); `previewMoreTrigger` in `getTicketsTabElements()` (planning.js:2398) is a dead property never consumed. Verification: grep confirmed no orphaned references; the `initOverflowMenus` guard (planning.js:2339) prevents double-registration on tab re-entry; scroll/resize repositioning uses capture-phase listeners. Remaining risk: none material — if a trigger scrolls off-screen while its popover is open, the popover clamps to the viewport edge (cosmetic, not functional).
