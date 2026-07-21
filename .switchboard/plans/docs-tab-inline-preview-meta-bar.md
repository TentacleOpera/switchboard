# Docs tab: add an inline preview meta-bar for document-scoped actions

> Imported from user request

## Goal

In the Planning panel's **Docs** tab (`planning.html`), give the document previewer its own **inline command bar** (a preview meta-bar rendered above the open document), matching the pattern the **Tickets** tab already uses. Move the document-scoped actions out of the single top control strip and into that inline bar, leaving only list-scoped controls (workspace filter, source filter, search, + New Doc, status) in the top strip.

### Problem analysis & root cause

The Docs tab and the Tickets tab were built to two different generations of the layout:

- **Tickets tab** has **two** bars:
  1. A top control strip `#controls-strip-tickets` ([planning.html:3950](../../src/webview/planning.html#L3950)) for list-scoped controls (source, filters, refresh, `⋯ More`).
  2. An **inline preview meta-bar** `#tickets-preview-meta-bar` ([planning.html:3991](../../src/webview/planning.html#L3991)) rendered *above the selected ticket*, holding the per-selection actions: Edit / Save / Cancel / Push / Comment, a `⋯ More` overflow (Assign, Tags, Attachments, Diagram, +Subtask, To subtask…), and Delete.

  The same inline-meta-bar pattern is shared by the Kanban previewer — the CSS rule at [planning.html:3363](../../src/webview/planning.html#L3363) already groups `#kanban-preview-meta-bar, #tickets-preview-meta-bar, #tickets-local-meta-bar`.

- **Docs tab** has **only** the top strip `#controls-strip-docs` ([planning.html:3705](../../src/webview/planning.html#L3705)). Every action — list-scoped *and* document-scoped — is crammed into it, and the document-scoped buttons are simply enabled/disabled as a doc is selected. There is **no** `#docs-preview-meta-bar` element (grepping `preview-meta-bar` in `planning.html` matches only the kanban/tickets bars). The docs previewer's `.preview-content-wrapper` ([planning.html:3739](../../src/webview/planning.html#L3739)) goes straight to `#markdown-preview` / `#markdown-editor` with no bar above it.

**Root cause:** the Docs tab never received the control-strip/meta-bar split that the Tickets tab got in the `Tickets tab control-strip & sidebar cleanup` change (2026-07-20). It's a consistency gap, not an intentional design choice. As a result, per-document actions (Edit, Push, Draft with agent, Save as PRD, Save as Constitution, Copy to Online, Import) live in the top strip instead of inline over the document they act on, and no inline bar ever appears no matter which doc is selected.

### Approach (low-risk DOM move + CSS)

Every docs button is referenced by `getElementById` in `planning.js` (e.g. `btn-edit` [4439](../../src/webview/planning.js#L4439)/[8469](../../src/webview/planning.js#L8469), `btn-push-doc` [4466](../../src/webview/planning.js#L4466)/[8496](../../src/webview/planning.js#L8496), `btn-agent-doc` [8538](../../src/webview/planning.js#L8538), `btn-set-prd`/`btn-set-constitution` [8629-8630](../../src/webview/planning.js#L8629), `btn-sync-to-online` [12264](../../src/webview/planning.js#L12264), `btn-import-full-doc` [4438](../../src/webview/planning.js#L4438)). **Keeping the same element IDs and moving the elements in the DOM preserves all existing event wiring and enable/disable logic** — no handler needs to be re-bound. The overflow menu likewise auto-initializes: `initOverflowMenus()` ([planning.js:2349](../../src/webview/planning.js#L2349), called at [9456](../../src/webview/planning.js#L9456)) is a document-level delegated handler over any `[data-overflow-menu]`, so a new overflow block in the docs bar works with zero extra wiring.

So the change is almost entirely HTML restructure + one CSS selector addition + one small visibility toggle.

**Button classification:**

| Button (id) | Scope | Destination |
| :--- | :--- | :--- |
| `docs-workspace-filter`, `docs-source-filter` (selects) | list | stays in top strip |
| `btn-create-doc` (+ New Doc) | list | stays in top strip |
| `docs-search` (input), `status` (span) | list | stays in top strip |
| `btn-edit`, `btn-save`, `btn-cancel` | document | inline meta-bar (primary row) |
| `btn-push-doc` (Push) | document | inline meta-bar (primary row) |
| `btn-agent-doc` (Draft with agent) | document | inline meta-bar (primary row) |
| `btn-set-prd` (Save as PRD) | document | inline meta-bar → `⋯ More` |
| `btn-set-constitution` (Save as Constitution) | document | inline meta-bar → `⋯ More` |
| `btn-sync-to-online` (Copy to Online…) | document | inline meta-bar → `⋯ More` |
| `btn-import-full-doc` (Import) | document | inline meta-bar → `⋯ More` |

The everyday/primary row is Edit · Save · Cancel · Push · Draft with agent; the rest live behind a `⋯ More` overflow, mirroring how the Tickets meta-bar keeps its everyday actions primary and pushes secondary ones into `⋯ More`.

## Metadata

- **Tags:** frontend, ui, ux, docs
- **Complexity:** 3

## User Review Required

None — grouping decided: primary row is Edit / Save / Cancel / Push / **Draft with agent**; the overflow holds Save as PRD / Save as Constitution / Copy to Online / Import. The mechanics (move elements by ID, add the shared meta-bar CSS, toggle visibility on selection) reuse an established in-repo pattern and need no architectural sign-off.

## Complexity Audit

### Routine

1. **Add the meta-bar element.** In `#docs-content`, inside `.preview-panel-wrapper`, place the bar **inside `#preview-pane` as its first child** (above `.preview-content-wrapper`), matching the Tickets tab's structure where `#tickets-preview-meta-bar` is the first child of `#preview-pane-tickets` ([planning.html:3991](../../src/webview/planning.html#L3991)).

   > **Superseded:** Place the bar "inside `.preview-panel-wrapper` immediately above `#preview-pane` (or as the first child of `.preview-content-wrapper`, above `#markdown-preview` at [planning.html:3746](../../src/webview/planning.html#L3746))"
   > **Reason:** Neither proposed placement matches the Tickets tab pattern the plan claims to follow. The Tickets meta-bar lives *inside* `#preview-pane-tickets` as its first child. Placing it as a sibling above `#preview-pane` or inside `.preview-content-wrapper` breaks the layout parallel and risks the preview content not filling remaining height.
   > **Replaced with:** Place `#docs-preview-meta-bar` inside `#preview-pane` as the first child, above `.preview-content-wrapper` — exactly mirroring `#tickets-preview-meta-bar` inside `#preview-pane-tickets`.

   Additionally, `#preview-pane` currently has only `flex: 1; width: 100%; box-sizing: border-box;` in its inline style ([planning.html:3738](../../src/webview/planning.html#L3738)) — it lacks `display: flex; flex-direction: column;` which `#preview-pane-tickets` has ([planning.html:3990](../../src/webview/planning.html#L3990)). **Add `display: flex; flex-direction: column;`** to `#preview-pane`'s inline style so the meta-bar and `.preview-content-wrapper` stack vertically and the preview content fills the remaining height.

   ```html
   <div id="docs-preview-meta-bar" style="display:none;">
     <!-- moved: btn-edit, btn-save, btn-cancel, btn-push-doc, btn-agent-doc -->
     <div class="overflow-menu" data-overflow-menu>
       <button type="button" class="strip-btn overflow-menu-trigger" data-overflow-trigger title="More actions">⋯ More</button>
       <div class="overflow-menu-popover" data-overflow-popover>
         <!-- moved: btn-import-full-doc, btn-set-prd, btn-set-constitution, btn-sync-to-online (add class overflow-menu-item) -->
       </div>
     </div>
   </div>
   ```
2. **Move the document-scoped buttons** (listed in the table above) out of `#controls-strip-docs` and into the new bar, **keeping their existing `id`s and `disabled`/`style` state**. Add `overflow-menu-item` to the ones placed in the popover (matches the Tickets popover items).
3. **Register the CSS.** Append `#docs-preview-meta-bar` to the shared meta-bar selector at [planning.html:3363](../../src/webview/planning.html#L3363) so it inherits the exact styling used by kanban/tickets. No new CSS rule body needed.
4. **Toggle visibility.** Show the bar when a document is open, hide it otherwise. The cleanest hook is the preview handler's enable block at [planning.js:4438-4466](../../src/webview/planning.js#L4438) (the only enable/disable site for docs buttons). Set `document.getElementById('docs-preview-meta-bar').style.display = <doc open> ? 'flex' : 'none'` alongside the existing enable/disable of `btn-edit`. Use the same condition that currently drives `btnEdit.disabled` so the bar's visibility and the buttons' enablement never disagree. Additionally, hide the bar when the active doc is deleted — the deletion handlers at [planning.js:6453](../../src/webview/planning.js#L6453) and [planning.js:6477](../../src/webview/planning.js#L6477) set `state.activeDocId = null`; call the visibility helper there too.

### Complex / Risky

- **Low risk — visibility source of truth.** The only enable/disable site for docs buttons is the preview handler at [planning.js:4438-4466](../../src/webview/planning.js#L4438). There is no second "state-sync" enable/disable path — the lines previously cited as `8443-8470` are tab-switch re-fetch logic and button event wiring, not enable/disable. Drive the bar's `display` from the same "a document is currently open/selected" predicate used to enable `btn-edit` at that single site (or factor a tiny `_setDocsMetaBarVisible(open)` helper). Do **not** invent a new selection flag. Also hide the bar from the deletion handlers at [6453](../../src/webview/planning.js#L6453) and [6477](../../src/webview/planning.js#L6477) where `state.activeDocId` is set to null.
- **Low risk — edit mode.** During edit, `btn-save`/`btn-cancel` are shown and `btn-edit` is hidden by `enterEditMode` at [planning.js:8403-8405](../../src/webview/planning.js#L8403) (`btnEdit.style.display = 'none'; btnSave.style.display = ''; btnCancel.style.display = '';`). On exit, `exitEditMode` at [planning.js:8428-8430](../../src/webview/planning.js#L8428) reverses those. Those toggles use per-button `style.display`, so they keep working unchanged once the buttons live in the bar — the bar itself must remain visible throughout edit mode (a doc is open), so the visibility predicate must be "doc open", not "not editing".
- **Low risk — overflow trigger auto-hide.** `_recomputeOverflowTriggerVisibility` ([planning.js:2345](../../src/webview/planning.js#L2345)) hides the `⋯ More` trigger when the popover has no visible items. Since several popover buttons start `disabled`/`display:none` (e.g. `btn-import-full-doc`), verify the trigger shows once at least one becomes visible on selection — this is exactly how the Tickets bar behaves, so the shared logic already handles it.

## Edge-Case & Dependency Audit

- **No doc selected / empty state.** Bar is `display:none` by default and stays hidden until a doc is open; the previewer's "Select a document…" empty state ([planning.html:3747](../../src/webview/planning.html#L3747)) shows with no bar, matching Tickets' behavior when nothing is selected.
- **`btn-import-full-doc` already `display:none` + `disabled`.** It is only surfaced for certain online/full-doc sources. Preserve both attributes on the move; it appears inside `⋯ More` only when the existing logic un-hides it.
- **`btn-set-prd` disabled-with-tooltip.** It starts `disabled` with a "create a project first" title ([planning.html:3722](../../src/webview/planning.html#L3722)); the enable logic at [8636-8644](../../src/webview/planning.js#L8636) (`updatePrdButtonState`) is unchanged by the move. Tooltip and disabled state carry over verbatim.
- **`status` span.** Leave the `#status` span in the top strip (it's a list/operation status indicator, not document-scoped). Its `getElementById('status')` references are unaffected.
- **Overflow menu portaling.** Tickets' overflow popover is portaled to `<body>` when open (note at [planning.js:2380](../../src/webview/planning.js#L2380)); the docs popover uses the identical `data-overflow-*` markup, so it inherits this with no extra work.
- **Cyber theme.** `.cyber-theme-enabled .controls-strip` has a themed override ([planning.html:2296](../../src/webview/planning.html#L2296)); the meta-bar uses `var(--panel-bg2)` like the other meta-bars and needs no cyber-specific rule (kanban/tickets bars don't have one either). Spot-check under the cyber theme regardless.
- **No backend / TS changes.** Every message path (`readLocalTicketFile` analog for docs, push, draft-prompt copy, set-PRD, set-constitution, copy-to-online) is already wired to these element IDs. This is a **webview-only** change to `planning.html` + `planning.js`. No extension-host code, no `out/` concerns (source is authoritative).
- **Doc deletion clears selection.** When the active doc is deleted, `state.activeDocId` is set to null at [planning.js:6453](../../src/webview/planning.js#L6453) (local doc) and [planning.js:6477](../../src/webview/planning.js#L6477) (imported doc). The meta-bar must hide in both cases — call `_setDocsMetaBarVisible(false)` (or set `display: none` directly) alongside the existing `state.activeDocId = null` assignment.
- **Dependencies & conflicts:** Self-contained within `src/webview/planning.html` and `src/webview/planning.js`. Related but independent: `tickets-preview-meta-bar-deoverload.md` (Tickets bar only) — no overlap. Also independent of `docs-tab-new-doc-modal.md` (that rewrites the create flow; this relocates existing buttons) — no overlapping elements, safe to ship in either order.

## Dependencies

- None — this plan is self-contained.

## Adversarial Synthesis

Key risks: (1) meta-bar placement must match Tickets tab exactly (inside `#preview-pane`, not as a sibling) or layout breaks; (2) `#preview-pane` needs `display: flex; flex-direction: column;` added or preview content won't fill remaining height; (3) doc deletion clears `activeDocId` without hiding the bar unless the deletion handlers are patched; (4) the only enable/disable site is the preview handler — there is no second "state-sync" path, so the visibility toggle has exactly one show-site and two hide-sites (deletion handlers). Mitigations: superseded placement with exact Tickets-mirroring; inline-style fix documented; deletion-handler hooks identified.

## Verification Plan

### Automated Tests

- None — manual verification per steps below (skip compilation and automated tests per session directives).

1. **Build/reload** the extension and open the Planning panel → **Docs** tab.
2. **No selection:** top strip shows only workspace filter, source filter, + New Doc, search, status. No inline bar visible.
3. **Select a local doc:** an inline meta-bar appears above the preview with Edit · Save-hidden · Push · Draft with agent and a `⋯ More` menu containing Save as PRD, Save as Constitution, Copy to Online (and Import when applicable). The old top-strip copies of these buttons are gone.
4. **Edit flow:** click Edit → Save + Cancel appear in the bar, editor shows; Save persists, Cancel reverts. Bar stays visible throughout.
5. **Push / Draft with agent / Save as PRD / Save as Constitution / Copy to Online:** each fires the same behavior as before the move (push online, copy prompt to clipboard, set PRD/constitution, copy-to-online modal). `Save as PRD` still shows its disabled tooltip when the workspace has no projects.
6. **Overflow trigger:** `⋯ More` is hidden when its items are all hidden/disabled, appears once at least one is available (parity with Tickets).
7. **Switch to Tickets tab and back:** Tickets bar unchanged; Docs bar re-hides when no doc is selected.
8. **Cyber theme on:** meta-bar renders with correct panel background and readable buttons.
9. **Delete active doc:** bar hides when the selected doc is deleted (both local and imported doc deletion paths).

## Completion Summary

Implemented the docs inline preview meta-bar. Moved the 9 document-scoped buttons (Edit, Save, Cancel, Push, Draft with agent, Import, Save as PRD, Save as Constitution, Copy to Online) out of `#controls-strip-docs` into a new `#docs-preview-meta-bar` inside `#preview-pane` (first child, mirroring the Tickets tab). Primary row: Edit/Save/Cancel/Push/Draft with agent; the other four live behind a `⋯ More` overflow popover. Added `display: flex; flex-direction: column;` to `#preview-pane`'s inline style, appended `#docs-preview-meta-bar` to the shared meta-bar CSS selector, and added a `_setDocsMetaBarVisible` helper shown in both `loadDocumentPreview` branches and hidden in both deletion handlers (`localDocDeleted`, `importedDocDeleted`). Added `_recomputeAllOverflowTriggers()` calls after docs button gating, `updatePrdButtonState`, `updateSyncToOnlineButtonState`, and the rerender path so the `⋯ More` trigger hides/shows with parity to the Tickets bar. Files changed: `src/webview/planning.html`, `src/webview/planning.js`. No issues encountered.
