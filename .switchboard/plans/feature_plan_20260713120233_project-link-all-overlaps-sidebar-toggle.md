# Fix Link-All Button Overlapping Sidebar Toggle in project.html (and audit all webviews)

## Goal

In `project.html`, the **"Link all"** button sits inside the same `.sidebar-toggle-row` as the sidebar collapse/expand toggle. When the sidebar is collapsed, the row is squeezed to 40px and centered — the "Link all" button renders on top of the toggle button, blocking clicks so the sidebar can never be expanded again. The user is trapped in the collapsed state.

This plan fixes `project.html` and confirms (via audit) that the other webviews are not affected.

### Problem Analysis

The Kanban list pane in `project.html` has a header row (`.sidebar-toggle-row`) containing two buttons side-by-side:

```html
<div class="sidebar-toggle-row">
    <button id="kanban-link-all" class="strip-btn" title="Copy all filtered plan links to clipboard">Link all</button>
    <button class="sidebar-toggle-btn" title="Toggle sidebar">«</button>
</div>
```

When the user collapses the sidebar, the `.content-row` gains a `.collapsed` class and a set of CSS rules shrinks the first child (the list pane) to `flex: 0 0 40px`. A companion rule hides every direct child of the list pane **except** `.sidebar-toggle-row`:

```css
.content-row.collapsed #kanban-list-pane > *:not(.sidebar-toggle-row) {
    display: none !important;
}
```

The intent is: when collapsed, show only the toggle row so the user can click « to expand again. The flaw is that the "Link all" button is **inside** `.sidebar-toggle-row` (a grandchild of the pane, not a direct child), so the `> *:not(.sidebar-toggle-row)` selector does not reach it. Both buttons remain visible, the row uses `justify-content: center` in its collapsed state, and the two buttons are forced into the same 40px-wide strip — the larger "Link all" button paints over the toggle and swallows its click target.

### Root Cause

`src/webview/project.html` — missing a collapsed-state hide rule for `.strip-btn` elements inside `.sidebar-toggle-row`. The sibling webview `planning.html` already has the correct pattern (lines 375–377):

```css
.content-row.collapsed #tree-pane-tickets .sidebar-toggle-row .strip-btn {
    display: none !important;
}
```

`project.html` never adopted that rule, so its "Link all" button stays visible when collapsed and overlaps the toggle.

## Metadata

- **Tags:** ui, bugfix, frontend
- **Complexity:** 2

## User Review Required

Yes — visual verification only. User should confirm that, after the fix, collapsing the Project sidebar leaves only the «/» toggle button visible and clickable in every pane (Kanban, Projects, Features, Constitution, System, Tuning), and that expanding restores the "Link all" button in the Kanban pane. No code-level review needed beyond the one CSS rule.

## Complexity Audit

### Routine
- Single CSS rule addition in one file (`src/webview/project.html`), mirroring a pattern already proven in `planning.html` (lines 375–377).
- Purely declarative CSS scoped to the `.collapsed` state; cannot affect the expanded layout.
- No JS, no state, no data flow, no cross-file coordination.

### Complex / Risky
- None. The same selector pattern is already shipping in `planning.html` without incident.

> *Adversarial concern (preserved from original):* Could hiding "Link all" when collapsed surprise a user who expects to copy links from the collapsed view? No — when the sidebar is collapsed the plan list itself is hidden, so there is nothing to "link all". Hiding the button is the correct UX; it is only meaningful when the list is visible.

## Edge-Case & Dependency Audit

- **Other panes in project.html:** The collapsed-state selector list (line 448/451) covers `#kanban-list-pane`, `#features-list-pane`, `#constitution-list-pane`, `#system-list-pane`, `#tuning-list-pane`, `#projects-list-pane`. The new rule uses the general `.content-row.collapsed .sidebar-toggle-row .strip-btn` selector, so it automatically protects **every** sidebar pane in `project.html` that follows the same row pattern — not just the Kanban pane. This is a feature, not a risk: any future pane that adds a `.strip-btn` to its toggle row is covered.
- **Per-pane `.strip-btn` enumeration (audit of actual button contents, not just pane IDs):** Verified by reading each `.sidebar-toggle-row` block in `project.html`:
  - `#kanban-list-pane` (line 1158) — contains `#kanban-link-all.strip-btn` + toggle. **Only pane with a `.strip-btn`.** Rule hides it → intended.
  - `#projects-list-pane` (line 1191) — toggle button only, no `.strip-btn`. Rule is a no-op here.
  - `#features-list-pane` (line 1227) — toggle button only, no `.strip-btn`. No-op.
  - `#constitution-list-pane` (line 1272) — toggle button only, no `.strip-btn`. No-op.
  - `#system-list-pane` (line 1306) — toggle button only, no `.strip-btn`. No-op.
  - `#tuning-list-pane` (line 1342) — toggle button only, no `.strip-btn`. No-op.

  Conclusion: the global selector's blast radius is safe — it only acts on the one pane that actually has a `.strip-btn`, and hides nothing meaningful in the other five (there is nothing to hide). No regression risk.
- **Tech-debt note (structural smell, not in scope for this fix):** The deeper defect is that the "Link all" action button lives *inside* `.sidebar-toggle-row` at all — that row is semantically the sidebar-toggle row, and jamming an unrelated action button into it is what made the `> *:not(.sidebar-toggle-row)` selector miss it. This CSS patch hides the squatter; it does not relocate it. A future pane that legitimately needs a visible-when-collapsed action button in its toggle row will have to override this global hide rule. Relocating "Link all" out of the toggle row (and adjusting the existing `> *:not(.sidebar-toggle-row)` hide rule) would be the structural fix, but it touches HTML + JS and is out of scope for this overlap bugfix. Flagged here so the smell is visible, not buried.
- **`.sidebar-folders-btn` buttons:** `design.html` hides `.sidebar-folders-btn` (the "Manage Folders" button) via its own rule. `project.html` does not currently use `.sidebar-folders-btn` in toggle rows, but the new `.strip-btn` rule would not catch a `.sidebar-folders-btn` element (different class). If `project.html` later adopts `.sidebar-folders-btn`, a parallel rule will be needed — out of scope for this fix.
- **Inline `style.display` set by JS:** `project.js` does not set inline `display` on `#kanban-link-all` (unlike `planning.js` which toggles `#tickets-import-all-kanban`). The `!important` flag is still included for safety and to match the `planning.html` precedent.
- **Other webviews audited:**
  - `planning.html` — already fixed (lines 375–377). No change needed.
  - `design.html` — already fixed for `.sidebar-folders-btn` (lines 371–373); no `.strip-btn` in its toggle rows. No change needed.
  - `kanban.html`, `implementation.html`, `setup.html` — no sidebar toggle / collapse feature. Not applicable.
- **No JS dependency:** The collapse toggle is driven by adding/removing the `.collapsed` class on `.content-row` (`project.js` `toggleSidebarCollapsed`). The new CSS rule is purely reactive to that class; no JS change required.

## Dependencies

- None. Standalone CSS fix; no prerequisite plans or sessions.

## Adversarial Synthesis

Key risks: (1) the global `.content-row.collapsed .sidebar-toggle-row .strip-btn` selector has project-wide blast radius — mitigated by the per-pane enumeration confirming only the Kanban pane has a `.strip-btn`. (2) The fix patches the symptom (overlap) not the structure ("Link all" is misplaced inside the toggle row) — mitigated by flagging it as tech debt here rather than expanding scope into an HTML+JS refactor. (3) `!important` is cargo-culted from `planning.html` — accepted as defensive parity, harmless. No race, security, or data-flow surface.

## Proposed Changes

### File: `src/webview/project.html`

**Change 1 — Add a collapsed-state hide rule for `.strip-btn` inside `.sidebar-toggle-row`.**

Insert immediately after the existing `.content-row.collapsed .sidebar-toggle-row` block (after line 457, before the `/* Overlay and modals for logs */` comment on line 458):

```css
/* Hide strip-btns inside sidebar-toggle-row when collapsed so they don't
   overlap the sidebar toggle button (mirrors planning.html lines 375-377). */
.content-row.collapsed .sidebar-toggle-row .strip-btn {
    display: none !important;
}
```

Before (lines 453–458):
```css
}.content-row.collapsed .sidebar-toggle-row {
    position: static;
    display: flex;
    justify-content: center;
    margin-bottom: 8px;
}/* Overlay and modals for logs */
```

After:
```css
}.content-row.collapsed .sidebar-toggle-row {
    position: static;
    display: flex;
    justify-content: center;
    margin-bottom: 8px;
}.content-row.collapsed .sidebar-toggle-row .strip-btn {
    display: none !important;
}/* Overlay and modals for logs */
```

(Place the new rule on its own lines for readability; the existing file uses a compact `}...{` style — match surrounding formatting as appropriate.)

**That is the entire fix.** No other files change. The audit confirmed `planning.html` and `design.html` already have their own equivalent rules; the remaining webviews have no sidebar collapse feature.

## Verification Plan

> Per session directives: **skip compilation** (no build/compile step required) and **skip automated tests**. This is a pure CSS layout fix; visual verification is the correct gate.

1. **Open the Project webview** in VS Code (Switchboard sidebar → Project).
2. **Reproduce the bug first (pre-fix sanity):** with the sidebar expanded, click « to collapse. Observe the "Link all" button rendering on top of the toggle. (This confirms the test setup.)
3. **Apply the fix** and reload the webview.
4. **Collapsed-state check:** collapse the sidebar.
   - The "Link all" button is hidden.
   - Only the » toggle button is visible, centered in the 40px strip.
   - Clicking » expands the sidebar reliably — the toggle is no longer blocked.
5. **Expanded-state check:** expand the sidebar.
   - The "Link all" button is visible again in the toggle row.
   - Clicking "Link all" still copies filtered plan links to the clipboard (functional regression check).
6. **Other panes in project.html:** switch to Features / Constitution / System / Tuning / Projects panes (each has its own `.sidebar-toggle-row`). Collapse and expand each. Confirm no button overlap in any pane. (The general selector protects all of them; per-pane enumeration confirms only Kanban has a `.strip-btn` to hide.)
7. **Cross-webview regression:** open `planning.html` and `design.html` webviews; confirm their existing collapse behavior is unchanged.

### Automated Tests

Skip automated tests (per session directive). Pure CSS layout fix with no logic surface; visual verification is the correct gate.

## Completion Summary

Implemented the single CSS rule from Change 1: added `.content-row.collapsed .sidebar-toggle-row .strip-btn { display: none !important; }` to `src/webview/project.html` (now at lines 458-460), inserted immediately after the existing `.content-row.collapsed .sidebar-toggle-row` block and before the `/* Overlay and modals for logs */` comment, matching the `planning.html` precedent. No other files changed — the audit confirmed `planning.html` and `design.html` already have equivalent rules and the remaining webviews have no sidebar collapse feature. Red-team review found no issues: selector is gated on `.collapsed`, blast radius is safe (only the Kanban pane has a `.strip-btn`), and the expanded layout is untouched. No issues encountered.

## Review Findings

Reviewer pass (in-place, no auxiliary workflow). No code changes applied — the implemented CSS rule is correct and no CRITICAL/MAJOR code findings. Verification was a manual audit (compilation and tests skipped per directive): confirmed the rule at `src/webview/project.html:458-460`; confirmed via `project.js:1515-1518` that the runtime DOM also carries `.strip-btn` inside `.sidebar-toggle-row` (JS-generated, not just static HTML); confirmed only `#kanban-list-pane` has a `.strip-btn` (other five panes are no-ops); confirmed `planning.html:375` and `design.html:371` precedents; confirmed `project.js` sets no inline `display` on `#kanban-link-all`; confirmed `kanban.html`/`implementation.html`/`setup.html` have no collapse feature; traced the full toggle path through `toggleSidebarCollapsed` (`project.js:107`) → `applySidebarState` → `.collapsed` class toggle → CSS rule fires. NITs (not fixed): plan-specified explanatory comment was omitted (defensible — file uses compressed `}/* */` style with no inline comments); plan line references off-by-two from actual; plan §User Review says «/» but actual glyphs are « (expanded) / » (collapsed). Process note (not a code defect, not fixable without history rewrite): the CSS rule landed in earlier auto-commit `580516a` (skill-collision plan), not in this plan's own auto-commit `35d55ff` (which touched a different plan file) — bisect-by-plan-commit will not find the fix under its own plan. Remaining risk: the structural tech debt ("Link all" lives inside `.sidebar-toggle-row` at all) is flagged but out of scope; a future pane needing a visible-when-collapsed action button in its toggle row will have to override this global hide rule.
