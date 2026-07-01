# Fix: Reduce Sidebar Width for project.html Governance Tabs

**Plan ID:** 9395cf16-b9e4-4ca3-9487-430c91d5fb88

## Goal

The sidebar width for the Projects, Constitution, System, and Tuning tabs in `project.html` is unnecessarily large (320px — the same as the Kanban Plans and Epics tabs). These governance tabs display simple document lists, not complex plan/epic cards, so they don't need as much horizontal space. Reduce their sidebar width to ~240px to give more room to the preview pane.

### Problem Analysis & Root Cause

**Current state:** In `src/webview/project.html` at lines 203-211, a single CSS rule sets the width for ALL six tab sidebars to 320px:

```css
#kanban-list-pane, #epics-list-pane, #constitution-list-pane, #system-list-pane, #tuning-list-pane, #projects-list-pane {
    width: 320px;
    flex-shrink: 0;
    border-right: 1px solid var(--border-color);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    background: var(--panel-bg);
}
```

**The problem:** The Kanban Plans and Epics tabs display rich cards with plan titles, descriptions, complexity scores, tags, and action buttons — they genuinely need 320px. But the Projects, Constitution, System, and Tuning tabs display simple document name lists (e.g., "CONSTITUTION.md", "CLAUDE.md", "prd.md") that fit comfortably in 240px. The excessive sidebar width steals horizontal space from the markdown preview pane, making documents harder to read.

**Root cause:** When the governance tabs were added, they were lumped into the same CSS rule as the kanban/epics sidebars for convenience, without considering that their content is fundamentally simpler and doesn't need the same width.

## Metadata
- **Tags:** frontend, css, ui, project-html, sidebar
- **Complexity:** 2

## Complexity Audit

### Routine
- Splitting a CSS selector into two groups with different widths
- Updating collapsed-state CSS rules to match
- Visual verification

### Complex / Risky
- None. This is a pure CSS width change with no logic impact.

## Edge-Case & Dependency Audit

- **Collapsed sidebar state:** Lines 509-517 and 519-526 have collapsed-state CSS rules that reference the same selectors. **Verified:** these rules only set padding, overflow, and `display: none` for non-toggle children — they do NOT set width. The collapsed width (40px) is controlled by a separate rule at lines 502-504 (`.content-row.collapsed > :first-child { flex: 0 0 40px !important; }`), which applies to all tabs equally. The collapsed rules at 509-517 and 519-526 can remain as a single rule — no split needed.
- **Cyber-theme rule:** Lines 745-755 have a cyber-theme rule (`.cyber-theme-enabled #kanban-list-pane, ...`) that references all six pane IDs for background/backdrop-filter/border-color. It does NOT set width, but should be split into two groups for consistency with the width split.
- **Responsive behavior:** The sidebar uses `flex-shrink: 0` so it won't shrink below its set width. Reducing to 240px is safe. No media queries override sidebar width.
- **Sidebar toggle button:** The toggle logic in `project.js` uses class selectors (`.sidebar-toggle-btn`, `.content-row`), NOT pane IDs. A width change will NOT break the toggle.
- **Projects tab wiring:** The `projects-list-pane` ID exists in HTML but is NOT referenced in `project.js` (no corresponding variable). This may indicate the Projects tab is wired differently or is incomplete. Verify the tab is functional before changing its width — if it's a dead pane, the width change is cosmetic on non-functional content.
- **No dependencies on other files** — this is entirely within `project.html`'s inline CSS.

## Proposed Changes

### 1. Split the sidebar width CSS rule

**File:** `src/webview/project.html` (lines 203-211)

Replace the single rule with two:

```css
/* Kanban & Epics — wider for complex plan/epic cards */
#kanban-list-pane, #epics-list-pane {
    width: 320px;
    flex-shrink: 0;
    border-right: 1px solid var(--border-color);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    background: var(--panel-bg);
}

/* Projects, Constitution, System, Tuning — narrower for simple doc lists */
#constitution-list-pane, #system-list-pane, #tuning-list-pane, #projects-list-pane {
    width: 240px;
    flex-shrink: 0;
    border-right: 1px solid var(--border-color);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    background: var(--panel-bg);
}
```

### 2. Collapsed-state CSS rules — NO SPLIT NEEDED

**File:** `src/webview/project.html` (lines 509-517 and 519-526)

**Verified:** The collapsed-state rules at lines 509-517 and 519-526 do NOT set width — they only set padding, overflow, and `display: none` for non-toggle children. The collapsed width (40px) is controlled by a separate universal rule at lines 502-504 (`.content-row.collapsed > :first-child { flex: 0 0 40px !important; }`). These rules can remain as-is — no split needed.

### 3. Split the cyber-theme sidebar rule for consistency

**File:** `src/webview/project.html` (lines 745-755)

The cyber-theme rule references all six pane IDs. While it doesn't set width, split it for consistency:

```css
/* Cyber theme — Kanban & Epics */
.cyber-theme-enabled #kanban-list-pane,
.cyber-theme-enabled #epics-list-pane {
    background: rgba(10, 10, 10, 0.70);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border-right-color: color-mix(in srgb, var(--accent-primary) 20%, transparent);
}

/* Cyber theme — Projects, Constitution, System, Tuning */
.cyber-theme-enabled #constitution-list-pane,
.cyber-theme-enabled #system-list-pane,
.cyber-theme-enabled #tuning-list-pane,
.cyber-theme-enabled #projects-list-pane {
    background: rgba(10, 10, 10, 0.70);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border-right-color: color-mix(in srgb, var(--accent-primary) 20%, transparent);
}
```

### 4. If architect tab is added

If the architect tab (from the architect agent plan) is implemented, add `#architect-list-pane` to the narrower sidebar group:

```css
#constitution-list-pane, #system-list-pane, #tuning-list-pane, #projects-list-pane, #architect-list-pane {
    width: 240px;
    /* ... */
}
```

## Verification Plan

1. **Visual check — Kanban Plans tab:** Open project.html → Kanban Plans tab → verify sidebar is still 320px (unchanged).
2. **Visual check — Epics tab:** Switch to Epics tab → verify sidebar is still 320px (unchanged).
3. **Visual check — Projects tab:** Switch to Projects tab → verify sidebar is 240px (narrower) and the preview pane has more room.
4. **Visual check — Constitution tab:** Switch to Constitution tab → verify sidebar is 240px.
5. **Visual check — System tab:** Switch to System tab → verify sidebar is 240px.
6. **Visual check — Tuning tab:** Switch to Tuning tab → verify sidebar is 240px.
7. **Sidebar toggle:** Click the sidebar toggle button on each tab → verify collapse/expand works correctly for both width groups.
8. **Document list fits:** Verify all document names in the governance tab sidebars are fully visible at 240px (no truncation).
9. **Projects tab functional check:** Before changing width, verify the Projects tab is actually functional (its pane ID `projects-list-pane` is not referenced in `project.js` — confirm the tab renders content correctly).

## Dependencies

- None — this plan is self-contained within `project.html`'s inline CSS.

## Adversarial Synthesis

Key risks: the `projects-list-pane` ID is not referenced in `project.js`, suggesting the Projects tab may be incompletely wired — verify before changing width. The collapsed width is 40px (not 0px as originally assumed), controlled by a universal rule, so collapsed rules need no split. The cyber-theme rule at 745-755 should be split for consistency. Mitigations: pure CSS change, toggle uses class selectors not IDs, no media queries affect width.

## Recommendation

Complexity 2/10 → **Send to Coder**.

## Review Findings

**Stage 1 (Grumpy):** Welcome, mortals. I came expecting a one-line CSS tweak and found… a one-line CSS tweak done right. The width rule is split correctly (kanban/epics 320px at lines 203-211, governance 240px at lines 212-220). The cyber-theme rule is split for consistency (lines 754-760 vs 761-769). The collapsed-state rules were correctly left unsplit (lines 518-534 set only padding/overflow/display:none; the 40px collapsed width comes from the universal rule at line 511). No findings. The `projects-list-pane` not being referenced in `project.js` is a pre-existing condition the plan already flagged — not a defect of this change.

**Stage 2 (Balanced):** No CRITICAL/MAJOR/NIT findings. Implementation is fully plan-compliant. No code fixes needed.

**Files changed:** `src/webview/project.html` (CSS split at lines 203-220, 754-769).
**Validation:** Static review only (compile/tests skipped per session directives). CSS is syntactically valid; selectors match existing pane IDs.
**Remaining risks:** None material. The `projects-list-pane` JS-wiring question is out of scope for this plan.
