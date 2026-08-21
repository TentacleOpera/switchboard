# Relocate Copy Link to Preview Meta-Bars Across All Panels

## Goal

### Problem

Copy Link buttons currently live only on sidebar cards across all doc-type preview panels (planning.html, project.html, tickets.html, design.html). Users instinctively look for a link-copy action in the top function bar (meta-bar) of each document preview, not buried in a sidebar card's action row. This discoverability gap is a persistent UX friction point.

### Background

The codebase has a consistent layout pattern: a sidebar list pane (left) + a preview panel (right) with a meta-bar / controls strip above the preview content. The meta-bar carries document-specific actions (Edit, Save, Cancel, Review, Delete, etc.). Copy Link was added to sidebar cards as a per-card convenience but was never promoted to the meta-bar, making it invisible to users who expect it alongside the other document actions.

### Root Cause

Copy Link was implemented as a card-level affordance (`.kanban-plan-copy-link` / `.doc-card-copy-link` CSS classes, rendered in card template strings) rather than as a meta-bar action. Each panel's meta-bar was built independently, and none of them included a Copy Link button. The feature was never promoted to the function bar.

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, ux, refactor
**Project:** Browser Switchboard

## Affected Files

### Frontend (HTML — static meta-bar elements)
- `src/webview/planning.html` — `#docs-preview-meta-bar` (static HTML, line ~3700)
- `src/webview/tickets.html` — `#tickets-preview-meta-bar` (static HTML, line ~4058)
- `src/webview/project.html` — Constitution controls strip (line ~1411), System controls strip (line ~1450), Projects controls strip (line ~1325), Archives controls strip (line ~1520)

### Frontend (JS — dynamic meta-bar rendering + card template edits)
- `src/webview/planning.js` — wire Copy Link in docs meta-bar; remove Copy Link from kanban plan card template (vestigial kanban code, lines ~5673, ~5700-5720)
- `src/webview/tickets.js` — wire Copy Link in tickets meta-bar (copy ticket file path)
- `src/webview/project.js` — add Copy Link to `renderKanbanMetaBar()` (line ~1968); add Copy Link to `renderFeatureMetaBar()` (line ~2514); add Copy Link to Constitution/System/Projects/Archives controls strips; remove Copy Link from kanban plan card template (line ~1715), feature card template (line ~2355), projects sidebar card template (line ~1481), constitution/system sidebar card template (line ~2860)
- `src/webview/design.js` — rename existing "Link" button to "Copy Link" in the design controls strip for label consistency (line ~1875, ~1934, ~1955)

### CSS
- `src/webview/planning.html` — `.kanban-plan-copy-link` CSS block (lines ~2494-2511) can remain (used by vestigial planning.js code) but is now dead; leave it to avoid cross-panel breakage
- `src/webview/project.html` — `.kanban-plan-copy-link`, `.doc-card-copy-link` CSS blocks (lines ~418-445) can remain; dead but harmless

## Implementation Plan

### Step 1: planning.html — Add Copy Link to docs meta-bar

**HTML edit** (`planning.html`, `#docs-preview-meta-bar`, ~line 3700):
Add a `<button id="btn-copy-doc-link" class="strip-btn" disabled>Copy Link</button>` as the first button in the meta-bar (before Edit).

**JS edit** (`planning.js`):
- Enable/disable the button when a doc is selected/deselected (in the same code path that toggles Edit/Save/Cancel buttons)
- Wire click handler: `navigator.clipboard.writeText(toAgentRef(activeDocFilePath))` with "Copied" feedback (2s timeout)
- The active doc's file path is available from the doc selection state (the same state that feeds `loadDocumentPreview`)

### Step 2: tickets.html — Add Copy Link to tickets meta-bar

**HTML edit** (`tickets.html`, `#tickets-preview-meta-bar`, ~line 4058):
Add a `<button id="btn-copy-ticket-link" class="strip-btn">Copy Link</button>` as the first button in the meta-bar (before Edit).

**JS edit** (`tickets.js`):
- Wire click handler: copies the selected ticket's local file path to clipboard
- The ticket file path is available from the selected ticket state (the same state that feeds the ticket preview)
- For remote-only tickets (ClickUp/Linear without local file), disable the button or hide it
- "Copied" feedback (2s timeout)

### Step 3: project.html — Add Copy Link to all tab meta-bars / controls strips

**Kanban tab** (dynamic meta-bar in `project.js`, `renderKanbanMetaBar()`, ~line 1968):
- Add `<button class="strip-btn" id="kanban-meta-copy-link-btn">Copy Link</button>` to the meta-bar innerHTML
- Place it in the left group (near Column/Complexity) or the right group (near Review/Delete)
- Wire click handler: `navigator.clipboard.writeText(toAgentRef(plan.planFile))` with "Copied" feedback
- Disable/hide if no `planFile` exists
- Register the click listener after `metaBar.innerHTML = ...` (same pattern as existing dynamic buttons)

**Features tab** (dynamic meta-bar in `project.js`, `renderFeatureMetaBar()`, ~line 2514):
- Add `<button class="strip-btn" id="feature-meta-copy-link-btn">Copy Link</button>` to the meta-bar innerHTML
- Wire click handler: copies the feature's plan file path
- Note: `renderFeatureSubtaskMetaBar()` (~line 2587) ALREADY has a Copy Link button (`feature-subtask-meta-copy-link-btn`) — no change needed there

**Constitution tab** (static controls strip in `project.html`, ~line 1411):
- Add `<button id="btn-copy-constitution-link" class="strip-btn" disabled>Copy Link</button>` to the controls strip
- Wire in `project.js`: enable when a constitution file is selected, copy its file path on click

**System tab** (static controls strip in `project.html`, ~line 1450):
- Add `<button id="btn-copy-system-link" class="strip-btn" disabled>Copy Link</button>` to the controls strip
- Wire in `project.js`: enable when a system file is selected, copy its file path on click

**Projects tab** (static controls strip in `project.html`, ~line 1325):
- Add `<button id="btn-copy-prd-link" class="strip-btn" disabled>Copy Link</button>` to the controls strip
- Wire in `project.js`: enable when a project PRD file exists, copy its file path on click

**Archives tab** (static controls strip in `project.html`, ~line 1520):
- Add `<button id="btn-copy-archive-link" class="strip-btn" disabled>Copy Link</button>` to the controls strip
- Wire in `project.js`: enable when an archived plan is selected, copy its file path on click

**Tuning tab**: Already has Copy Link in the preview content area (`btn-insight-copy-link`, line ~1155). No change needed.

### Step 4: design.html — Rename "Link" to "Copy Link"

**HTML edit** (`design.html`, ~line 3703):
- Rename `<button id="btn-link-to-doc-design" class="strip-btn" disabled>Link</button>` to `<button id="btn-link-to-doc-design" class="strip-btn" disabled>Copy Link</button>`
- No JS change needed — the click handler already copies the file path via `linkToDocument`

### Step 5: Remove Copy Link from sidebar cards

**project.js** — Remove Copy Link buttons from card templates and their event listeners:
1. **Kanban plan card template** (~line 1715): Remove `${plan.planFile ? \`<button class="kanban-plan-copy-link" ...>Copy Link</button>\` : ''}` from the template string. Remove the `copyLinkBtn` event listener block (~lines 1731-1741).
2. **Feature card template** (~line 2355): Remove `${plan.planFile ? \`<button class="kanban-plan-copy-link feature-card-action" ...>Copy Link</button>\` : ''}` from the template string. Remove the `featureCopyLinkBtn` event listener block (~lines 2406-2417).
3. **Projects sidebar card template** (~line 1481): Remove the `copyLinkHtml` block and the `wireCopyLinkButton` call (~line 1495).
4. **Constitution/System sidebar card template** (~line 2860): Remove the `copyLinkHtml` block and the `wireCopyLinkButton` call (~line 2869).

**planning.js** — Remove Copy Link from vestigial kanban plan card template:
1. **Kanban plan card template** (~line 5673): Remove the Copy Link button from the template string. Remove the `copyLinkBtn` event listener block (~lines 5700-5721).

**design.js** — Remove Copy Link from stitch screen gallery cards:
1. **Stitch screen card** (~line 3078): Remove the `btnLink` button creation and append. The preview overlay's "Copy Link" button (`#preview-btn-png`) already covers the selected-screen case.

## Edge Cases & Risks

1. **No file path available**: Some plans/tickets may not have a `planFile` (e.g., remote-only tickets, plans without files). The Copy Link button must be disabled or hidden in these cases. The meta-bar is already hidden when no document is selected, so this is primarily about the controls strip buttons (Constitution, System, Projects, Archives) which are always visible.

2. **Feature subtask meta-bar already has Copy Link**: `renderFeatureSubtaskMetaBar()` already includes a Copy Link button. Do NOT duplicate it. Only `renderFeatureMetaBar()` (the top-level feature view) needs the new button.

3. **Tuning tab already has Copy Link**: The tuning tab's Copy Link is in the preview content area (appended after the insight markdown), not in a meta-bar. It's already in the "function bar" equivalent. No change needed.

4. **design.html "Link" button**: The existing "Link" button in the design controls strip already copies the file path. Renaming it to "Copy Link" is a label-only change for consistency. No behavioral change.

5. **Vestigial planning.js kanban code**: planning.js still has kanban plan card rendering code from when the kanban tab lived in planning.html. The kanban tab has since moved to project.html. The vestigial code should have its Copy Link removed too, but the code itself is dead (no HTML element to render into). Safe to edit.

6. **`toAgentRef` is a passthrough**: The `toAgentRef()` function in `sharedUtils.js` simply returns the path as-is (the `@` prefix was removed). Copy Link copies the raw absolute path. No change to this function.

7. **Clipboard API in webview**: All existing Copy Link buttons use `navigator.clipboard.writeText()` which works in VS Code webviews. The new meta-bar buttons should use the same pattern.

## Verification Plan

1. **planning.html**: Select a doc in the sidebar → verify Copy Link appears in the docs meta-bar → click it → verify the file path is on the clipboard → verify the sidebar card no longer has a Copy Link button
2. **project.html Kanban tab**: Select a plan → verify Copy Link appears in the kanban meta-bar → click it → verify file path copied → verify sidebar card no longer has Copy Link
3. **project.html Features tab**: Select a feature → verify Copy Link in feature meta-bar → select a subtask → verify Copy Link in subtask meta-bar (already existed) → verify feature sidebar card no longer has Copy Link
4. **project.html Constitution/System/Projects/Archives tabs**: Select a file → verify Copy Link in controls strip → click → verify path copied → verify sidebar card no longer has Copy Link
5. **tickets.html**: Select a local ticket → verify Copy Link in tickets meta-bar → click → verify file path copied → select a remote-only ticket → verify Copy Link is disabled/hidden
6. **design.html**: Verify the "Link" button is now labeled "Copy Link" → select a design doc → click Copy Link → verify file path copied → verify stitch gallery cards no longer have Copy Link
