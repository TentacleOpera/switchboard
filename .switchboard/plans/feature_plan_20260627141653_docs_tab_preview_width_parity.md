# Docs Tab Preview Width Parity with Kanban Plans

## Goal

The Artifacts/Docs tab preview in `planning.html` appears noticeably narrower than the same plan files displayed in the `project.html` Kanban plans view, even though the two views are meant to display mirrored content. The user reports the Kanban plans display is "much nicer" and wider, while the Docs tab preview feels "rather limited in width."

### Problem Analysis & Root Cause

Both views render markdown with **identical content styling** (font-size 13px, line-height 1.5, same heading typography with uppercase/border-left decorations, same code block and table styling — confirmed via line-by-line comparison of the "Unified Markdown Preview Styling" blocks in both files). The difference is **not** in how the markdown is styled, but in **how much horizontal space the preview pane is given by the flex layout**.

**`project.html` (Kanban — the "nice" one):**
- Sidebar (`#kanban-list-pane`): `width: 320px; flex-shrink: 0;` — **fixed** at 320px, never grows.
- Preview (`.preview-panel-wrapper`): `flex: 1` — takes **all remaining space**.
- On a 1600px-wide panel: sidebar = 320px, preview = **1280px**.
- On a 2400px-wide panel: sidebar = 320px, preview = **2080px**.

**`planning.html` (Docs tab — the "limited" one):**
- Sidebar (`#tree-pane`): `flex: 1` (set by the generic rule `.content-row > :first-child { flex: 1 }`) — **grows proportionally**.
- Preview (`.preview-panel-wrapper`): `flex: 3` (set by `.content-row > :last-child { flex: 3 }`) — gets 75% of the row.
- This is a **25%/75% proportional split**.
- On a 1600px-wide panel: sidebar = 400px, preview = **1200px** (80px narrower).
- On a 2400px-wide panel: sidebar = 600px, preview = **1800px** (280px narrower).

The discrepancy **scales with window width** — on wider displays the docs tab sidebar keeps growing (eating 25% of the row) while the Kanban sidebar stays capped at 320px. This is why the docs tab feels increasingly cramped compared to the Kanban view on wider screens.

**Root cause:** `planning.html`'s `.content-row` uses a proportional `flex: 1` / `flex: 3` split for all tabs, while `project.html` uses a fixed-width sidebar + `flex: 1` preview. The docs tab sidebar (`#tree-pane`) inherits the proportional behavior and grows unnecessarily wide on larger windows.

## Metadata

- **Tags:** `css`, `layout`, `planning-panel`, `docs-tab`, `ux`, `width-parity`
- **Complexity:** 2/10
- **Files touched:** 1 (`src/webview/planning.html`)
- **Risk:** Low — pure CSS layout change, no logic/data flow impact

## Complexity Audit

**Classification: Routine**

This is a single-file CSS change that overrides the flex behavior of one element (`#tree-pane`) to match an existing, proven pattern from `project.html`. No JavaScript changes, no data flow changes, no migrations. The collapsed-sidebar state is already handled by an `!important` rule that will continue to override the new fixed width.

## Edge-Case & Dependency Audit

1. **Collapsed sidebar state:** The existing rule `.content-row.collapsed > :first-child { flex: 0 0 40px !important; }` (line 267-268) uses `!important` and will still override the new `flex: 0 0 320px` on `#tree-pane` when the sidebar is collapsed. No conflict.

2. **Other tabs sharing `.content-row`:** The generic `.content-row > :first-child { flex: 1 }` and `:last-child { flex: 3 }` rules (lines 258-263) apply to all tabs (docs, research/online, tickets, planning-html, kanban). The fix targets `#tree-pane` by ID (specificity 1-0-0), which beats the class+pseudo-class selector (0-2-0). Other tabs' sidebars (`#tree-pane-online`, `#tree-pane-tickets`, `#tree-pane-planning-html`) are **not** affected — they keep their proportional flex behavior. This is intentional since the user only reported the docs tab; the same fix can be extended to other tabs later if desired.

3. **JS sidebar toggle:** `applySidebarState()` in `planning.js` (line 1220) only toggles the `collapsed` class on `.content-row` — it does not set inline `flex` or `width` styles. No JS changes needed.

4. **Narrow windows:** On very narrow panels (e.g. 400px), a fixed 320px sidebar leaves only 80px for the preview. This is the same behavior as `project.html`'s kanban view, which already ships with the 320px fixed sidebar and has not been reported as a problem. The sidebar can still be collapsed to reclaim the full width.

5. **Antigravity-specific rendering:** The user mentions Antigravity plans specifically. These are rendered through the same `#markdown-preview` element as all other docs — no special-casing needed. The width fix applies uniformly to all content in the docs tab.

## Proposed Changes

### File: `src/webview/planning.html`

**Change 1 — Give `#tree-pane` a fixed width matching the Kanban pattern**

Locate the existing `#tree-pane` rule (around line 652-662):

```css
#tree-pane,
#tree-pane-online,
#tree-pane-tickets,
#tree-pane-planning-html {
    position: relative;
    background: var(--panel-bg2);
    border-right: 1px solid var(--border-color);
    overflow-y: auto;
    padding: 12px;
    min-height: 100%;
}
```

Add a new rule immediately after it that overrides the flex behavior for `#tree-pane` only, matching `project.html`'s `#kanban-list-pane` pattern:

```css
/* Docs tab sidebar: fixed width to match project.html kanban layout.
   The generic .content-row > :first-child { flex: 1 } rule would
   otherwise grow this pane proportionally (25% of the row), making
   the preview narrower than the kanban plans view. */
#tree-pane {
    flex: 0 0 320px;
}
```

This works because:
- `flex: 0 0 320px` = `flex-grow: 0; flex-shrink: 0; flex-basis: 320px` — the sidebar stays exactly 320px.
- ID selector `#tree-pane` (specificity 1-0-0) overrides the generic `.content-row > :first-child { flex: 1 }` (specificity 0-2-0).
- The preview pane (`.preview-panel-wrapper`, the `:last-child`) keeps `flex: 3`, but with the sidebar now fixed at 320px, `flex: 3` just means "take all remaining space" (since there's no other flex-growing sibling).
- The collapsed state rule (`flex: 0 0 40px !important`) still overrides this when the sidebar is toggled collapsed.

**No other files need changes.** The JS (`planning.js`) only toggles the `collapsed` class and does not manipulate inline flex/width styles. The markdown content styling is already identical between the two views.

## Verification Plan

1. **Build:** Run `npm run compile` (webpack) — this is a CSS-only change in an HTML file, so no TypeScript/build errors are expected. (Note: `dist/` is not used during dev testing; verification is via installed VSIX.)

2. **Visual comparison test:**
   - Open the Switchboard Artifacts/Planning panel in VS Code.
   - Navigate to the Docs tab and select an Antigravity plan document.
   - Open the Kanban/Project panel (`project.html`) and select the same plan from the Kanban board.
   - Place them side-by-side (or toggle between them) and confirm the preview pane widths now match.
   - Test on a wide window (extend the VS Code window to full-screen on a wide monitor) — the docs tab sidebar should stay at 320px and the preview should get all remaining space, matching the kanban view.

3. **Sidebar collapse test:**
   - In the Docs tab, click the sidebar toggle button (`«`).
   - Confirm the sidebar collapses to 40px (the `!important` collapsed rule still works).
   - Click again to expand — confirm it returns to 320px (not 25% of the row).

4. **Narrow window test:**
   - Narrow the VS Code window significantly.
   - Confirm the docs tab sidebar stays 320px (same as kanban) and the preview shrinks accordingly. If too cramped, collapse the sidebar.

5. **Other tabs unaffected:**
   - Switch to the Research, Tickets, and Planning HTML tabs.
   - Confirm their sidebars still use the proportional `flex: 1` / `flex: 3` split (no change to `#tree-pane-online`, `#tree-pane-tickets`, `#tree-pane-planning-html`).
