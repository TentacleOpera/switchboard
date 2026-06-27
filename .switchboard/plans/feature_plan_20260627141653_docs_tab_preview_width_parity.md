# Docs Tab Preview Width Parity with Kanban Plans

## Goal

The Artifacts/Docs tab preview in `planning.html` appears noticeably narrower than the same plan files displayed in the `project.html` Kanban plans view, even though the two views are meant to display mirrored content. The user reports the Kanban plans display is "much nicer" and wider, while the Docs tab preview feels "rather limited in width."

### Problem Analysis & Root Cause

Both views render markdown with **identical content styling** (font-size 13px, line-height 1.5, same heading typography with uppercase/border-left decorations, same code block and table styling — per the plan's stated comparison of the "Unified Markdown Preview Styling" blocks in both files). The difference is **not** in how the markdown is styled, but in **how much horizontal space the preview pane is given by the flex layout**. (Note: the width fix below is independent of content-styling parity — it only changes the flex layout, so even if content styling differed, the width fix stands.)

**`project.html` (Kanban — the "nice" one):**
- Sidebar (`#kanban-list-pane`): `width: 320px; flex-shrink: 0;` (line 197-199) — **fixed** at 320px, never grows.
- Preview (`.preview-panel-wrapper`): `flex: 1` — takes **all remaining space**.
- On a 1600px-wide panel: sidebar = 320px, preview = **1280px**.
- On a 2400px-wide panel: sidebar = 320px, preview = **2080px**.

**`planning.html` (Docs tab — the "limited" one):**
- Sidebar (`#tree-pane`): `flex: 1` (set by the generic rule `.content-row > :first-child { flex: 1 }`, line 258-261) — **grows proportionally**.
- Preview (`.preview-panel-wrapper`): `flex: 3` (set by `.content-row > :last-child { flex: 3 }`, line 262-265) — gets 75% of the row.
- This is a **25%/75% proportional split**.
- On a 1600px-wide panel: sidebar = 400px, preview = **1200px** (80px narrower).
- On a 2400px-wide panel: sidebar = 600px, preview = **1800px** (280px narrower).

The discrepancy **scales with window width** — on wider displays the docs tab sidebar keeps growing (eating 25% of the row) while the Kanban sidebar stays capped at 320px. This is why the docs tab feels increasingly cramped compared to the Kanban view on wider screens.

**Root cause:** `planning.html`'s `.content-row` uses a proportional `flex: 1` / `flex: 3` split for all tabs, while `project.html` uses a fixed-width sidebar + `flex: 1` preview. The docs tab sidebar (`#tree-pane`) inherits the proportional behavior and grows unnecessarily wide on larger windows.

## Metadata

- **Tags:** `ui`, `ux`, `bugfix`, `docs`
- **Complexity:** 2/10
- **Files touched:** 1 (`src/webview/planning.html`)
- **Risk:** Low — pure CSS layout change, no logic/data flow impact

## User Review Required

No user review required. This is a pure CSS layout fix with no logic, data, or migration impact. The change mirrors an already-shipped, proven pattern from `project.html`'s Kanban view. Safe to proceed directly to implementation.

## Complexity Audit

### Routine
- Single-file CSS change in `src/webview/planning.html`.
- Adds one new `#tree-pane { flex: 0 0 320px }` rule immediately after the existing `#tree-pane` block (line 662).
- Reuses the exact fixed-sidebar pattern already shipping in `project.html` (`#kanban-list-pane`, line 197-199).
- No JavaScript changes — `applySidebarState()` in `planning.js` (line 1220) only toggles the `collapsed` class and never sets inline flex/width styles.
- No data flow, no migrations, no new dependencies.
- The collapsed-sidebar state is already handled by an `!important` rule (line 267-268) that continues to override the new fixed width.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

**Race Conditions:** None. This is a static CSS rule with no runtime state mutation, no async flow, and no event-handler changes.

**Security:** None. No user input handling, no HTML injection surface, no permission or auth changes. Pure presentation CSS.

**Side Effects:**
- The docs tab sidebar (`#tree-pane`) changes from proportional (25% of row) to fixed (320px). This is the intended, user-requested behavior change.
- Other tabs' sidebars (`#tree-pane-online`, `#tree-pane-tickets`, `#tree-pane-planning-html`) are **not** affected — they keep their proportional `flex: 1` / `flex: 3` split. This is intentional since the user only reported the docs tab. **Future extension candidate:** the same `flex: 0 0 320px` fix can be applied to those sibling panes later if the same cramping is reported on the Research/Tickets/Planning-HTML tabs.
- The CSS transition `.content-row > * { transition: flex 0.2s ease; }` (line 255-256) continues to animate the sidebar between expanded (320px) and collapsed (40px) states cleanly, since both states are `!important`-governed or specificity-governed flex-basis values.

**Dependencies & Conflicts:**
1. **Collapsed sidebar state:** The existing rule `.content-row.collapsed > :first-child { flex: 0 0 40px !important; }` (line 267-268) uses `!important` and still overrides the new `flex: 0 0 320px` on `#tree-pane` when the sidebar is collapsed. No conflict — `!important` beats the ID selector's specificity.
2. **Other tabs sharing `.content-row`:** The generic `.content-row > :first-child { flex: 1 }` and `:last-child { flex: 3 }` rules (lines 258-265) apply to all tabs. The fix targets `#tree-pane` by ID (specificity 1-0-0), which beats the class+pseudo-class selector (0-2-0). Other tabs are unaffected (see Side Effects above).
3. **JS sidebar toggle:** `applySidebarState()` in `planning.js` (line 1220) only toggles the `collapsed` class on `.content-row` — it does not set inline `flex` or `width` styles. No JS changes needed.
4. **Narrow windows (concrete failure mode):** With `flex: 0 0 320px` (flex-shrink: 0), a panel narrower than ~360px makes the 320px sidebar overflow its container and squeezes the preview to near-zero width, making the preview unusable. This is the **same behavior as `project.html`'s kanban view**, which already ships with the 320px fixed sidebar and has not been reported as a problem. The existing escape hatch is to collapse the sidebar (→ 40px), reclaiming the full width for the preview. No additional mitigation needed for parity.
5. **Antigravity-specific rendering:** The user mentions Antigravity plans specifically. These render through the same `#markdown-preview` element as all other docs — no special-casing needed. The width fix applies uniformly to all content in the docs tab.

## Dependencies

None. This is a self-contained single-file CSS change with no prerequisite plans or sessions.

## Adversarial Synthesis

Key risks: (1) the docs tab sidebar becomes rigidly fixed at 320px, so on very narrow panels the preview is squeezed until the sidebar is collapsed — but this exactly matches the already-shipped Kanban behavior and is the user's requested parity. (2) Sibling panes (online/tickets/planning-html) retain the proportional split, so the same cramping could be reported there later — flagged as a future extension, not a defect. Mitigations: the existing `!important` collapsed-state rule continues to govern the toggle; the ID-selector specificity cleanly overrides the generic flex rule without touching other tabs.

## Proposed Changes

### File: `src/webview/planning.html`

**Change 1 — Give `#tree-pane` a fixed width matching the Kanban pattern**

Locate the existing `#tree-pane` rule (lines 652-662):

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

Add a new rule immediately after it (after line 662) that overrides the flex behavior for `#tree-pane` only, matching `project.html`'s `#kanban-list-pane` pattern:

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
- The collapsed state rule (`flex: 0 0 40px !important`, line 267-268) still overrides this when the sidebar is toggled collapsed.

**No other files need changes.** The JS (`planning.js`) only toggles the `collapsed` class and does not manipulate inline flex/width styles. The markdown content styling is already shared between the two views.

## Verification Plan

### Automated Tests

Automated tests are **deferred to the user** per session directive — no unit, integration, or e2e tests will be run as part of this plan. This is a pure CSS layout change with no logic surface; visual verification (below) is the appropriate validation.

### Manual Visual Verification

1. **Visual comparison test:**
   - Open the Switchboard Artifacts/Planning panel in VS Code.
   - Navigate to the Docs tab and select an Antigravity plan document.
   - Open the Kanban/Project panel (`project.html`) and select the same plan from the Kanban board.
   - Place them side-by-side (or toggle between them) and confirm the preview pane widths now match.
   - Test on a wide window (extend the VS Code window to full-screen on a wide monitor) — the docs tab sidebar should stay at 320px and the preview should get all remaining space, matching the kanban view.

2. **Sidebar collapse test:**
   - In the Docs tab, click the sidebar toggle button (`«`).
   - Confirm the sidebar collapses to 40px (the `!important` collapsed rule still works).
   - Click again to expand — confirm it returns to 320px (not 25% of the row).

3. **Narrow window test:**
   - Narrow the VS Code window significantly (below ~400px panel width).
   - Confirm the docs tab sidebar stays 320px (same as kanban) and the preview shrinks accordingly. If too cramped, collapse the sidebar to reclaim the full width.

4. **Other tabs unaffected:**
   - Switch to the Research, Tickets, and Planning HTML tabs.
   - Confirm their sidebars still use the proportional `flex: 1` / `flex: 3` split (no change to `#tree-pane-online`, `#tree-pane-tickets`, `#tree-pane-planning-html`).

---

**Recommendation:** Complexity 2/10 → **Send to Intern**. This is a single-rule CSS fix that mirrors an already-shipped, proven pattern. No logic, no migrations, no JS changes.
